// Log Explorer: one page for a debug log, in a window of its own. Every trigger and class
// the log ran is shown with its whole source, the lines that ran highlighted,
// and what each line did (debug output, queries, DML, exceptions) under it.
// Opened from the button on a .log editor's title bar.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { lineStates, exceptionStatus, inferredLines, closingBraceLines, abortedLines } = require('./executionAnalyzer');
const { moveToNewWindow, maximize } = require('./popOut');

const esc = (value) =>
  String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);


// ---------- Apex syntax colouring ----------
// A webview cannot borrow the editor's TextMate colouring, so this is a small
// Apex tokenizer: comments, strings, numbers, annotations, keywords (Apex and
// SOQL are case-insensitive), control flow, types and method calls. Colours
// follow VS Code's Dark+/Light+ themes through CSS classes.
const APEX_KEYWORDS = new Set(('abstract after before class enum extends final global implements interface new null override private protected public static super ' +
  'testmethod this transient trigger virtual void webservice with without sharing inherited on insert update delete undelete upsert merge true false ' +
  'instanceof get set').split(' '));
const APEX_CONTROL = new Set('if else for while do switch when return throw try catch finally break continue'.split(' '));
const SOQL_KEYWORDS = new Set(('select from where and or not in like limit offset order by asc desc nulls first last group having count includes excludes ' +
  'find returning all rows for view reference update tracking viewstat typeof end').split(' '));
const PRIMITIVES = new Set('string integer long decimal double boolean id date datetime time blob object list set map sobject exception'.split(' '));

// Returns { html, inComment } for one line; `inComment` carries a /* */ comment over.
function highlightApex(text, inComment) {
  let html = '';
  let i = 0;
  let inSoql = false;
  const span = (cls, value) => `<span class="t-${cls}">${esc(value)}</span>`;
  while (i < text.length) {
    if (inComment) {
      const end = text.indexOf('*/', i);
      const stop = end < 0 ? text.length : end + 2;
      html += span('comment', text.slice(i, stop));
      i = stop;
      inComment = end < 0;
      continue;
    }
    const rest = text.slice(i);
    let m;
    if (rest.startsWith('//')) {
      html += span('comment', rest);
      break;
    }
    if (rest.startsWith('/*')) {
      inComment = true;
      continue;
    }
    if ((m = /^'(?:\\.|[^'\\])*'?/.exec(rest))) {
      html += span('string', m[0]);
    } else if ((m = /^\d+(?:\.\d+)?[lLdD]?/.exec(rest))) {
      html += span('number', m[0]);
    } else if ((m = /^@\w+/.exec(rest))) {
      html += span('annotation', m[0]);
    } else if ((m = /^[A-Za-z_]\w*/.exec(rest))) {
      const word = m[0];
      const lower = word.toLowerCase();
      const after = text.slice(i + word.length);
      if (inSoql && SOQL_KEYWORDS.has(lower)) {
        html += span('soql', word);
      } else if (APEX_CONTROL.has(lower)) {
        html += span('control', word);
      } else if (APEX_KEYWORDS.has(lower)) {
        html += span('keyword', word);
      } else if (/^\s*\(/.test(after)) {
        html += span('function', word);
      } else if (PRIMITIVES.has(lower) || /^[A-Z]/.test(word)) {
        html += span('type', word);
      } else {
        html += span('variable', word);
      }
    } else {
      m = [rest[0]];
      if (rest[0] === '[') {
        inSoql = true;
      } else if (rest[0] === ']') {
        inSoql = false;
      }
      html += esc(rest[0]);
    }
    i += m[0].length;
  }
  return { html, inComment };
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

// Triggers first, then classes, each group in the order the log reached them.
function filesInRunOrder(analysis) {
  const runOrder = (f) => (f.firstStep < 0 ? Infinity : f.firstStep);
  return [...analysis.files.values()]
    .filter((file) => file.lines.size || file.firstStep >= 0)
    .sort((a, b) => (a.kind === 'trigger' ? 0 : 1) - (b.kind === 'trigger' ? 0 : 1) || runOrder(a) - runOrder(b));
}

function exceptionHtml(analysis, ex) {
  const stack = (ex.stack || [])
    .map((s) => `<li><a href="#" data-key="${esc(s.file)}" data-line="${esc(s.line)}">${esc(s.frame || s.fileName || '?')}${s.line ? ` : line ${esc(s.line)}` : ''}</a></li>`)
    .join('');
  const resumed = ex.resumedAt
    ? `<div>Execution continued at <a href="#" data-key="${esc(ex.resumedAt.file)}" data-line="${esc(ex.resumedAt.line)}">${esc(ex.resumedAt.fileName)} line ${esc(ex.resumedAt.line)}</a>${ex.resumedAt.sameFrame ? ' (same method: likely a catch block)' : ''}</div>`
    : '';
  return `<div class="exception">
  <div class="ex-title">${esc(ex.type)} <span class="where">at <a href="#" data-key="${esc(ex.file)}" data-line="${esc(ex.line)}">${esc(ex.fileName || 'unknown')} line ${esc(ex.line || '?')}</a> · ${esc(ex.time || '')}</span></div>
  <pre class="ex-message">${esc(ex.message)}</pre>
  <div class="ex-status">${esc(exceptionStatus(ex))}</div>
  ${resumed}
  ${stack ? `<div class="label">Stack trace</div><ol class="stack">${stack}</ol>` : ''}
  ${ex.fatalText && ex.fatalText !== ex.message ? `<div class="label">Fatal error</div><pre class="ex-message">${esc(ex.fatalText)}</pre>` : ''}
</div>`;
}

// What one line did, shown under it.
function lineNotes(analysis, data) {
  const out = [];
  for (const index of data.exceptions) {
    const ex = analysis.exceptions[index];
    if (ex) {
      out.push(`<div class="note err">✖ ${esc(ex.type)}: ${esc(ex.message)}<br><span class="dim">${esc(exceptionStatus(ex))}</span></div>`);
    }
  }
  for (const d of data.debug) {
    out.push(`<div class="note debug">${d.time ? `<span class="dim">${esc(d.time)}</span> ` : ''}${esc(d.level)} · ${esc(d.text)}</div>`);
  }
  for (const q of data.soql) {
    out.push(`<div class="note soql">SOQL · ${esc(q.text)}${q.rows !== undefined ? ` · ${plural(q.rows, 'row')}` : ''}${q.ms !== undefined ? ` · ${q.ms} ms` : ''}</div>`);
  }
  for (const d of data.dml) {
    out.push(`<div class="note dml">DML ${esc(d.op)} ${esc(d.object)}${d.rows !== undefined ? ` · ${plural(d.rows, 'row')}` : ''}</div>`);
  }
  if (data.callouts) {
    out.push(`<div class="note dml">${plural(data.callouts, 'callout')}</div>`);
  }
  for (const v of data.vars.slice(0, 5)) {
    out.push(`<div class="note var">${esc(v.name)} = ${esc(v.value)}</div>`);
  }
  return out.join('');
}

function fileHtml(analysis, file, lines, options) {
  const states = lineStates(analysis, file.key, { hotThreshold: options.hotThreshold });
  const kind = file.kind === 'trigger' ? 'Trigger' : 'Class';
  const ran = [...states.values()];
  const errors = ran.filter((s) => s.state === 'exception').length;
  const header = `<h2 id="${esc(file.key)}">${options.number ? `<span class="num">${options.number}</span>` : ''}<span class="badge ${file.kind}">${kind}</span> ${esc(file.name)} <span class="dim">${plural(ran.length, 'line')} recorded${errors ? ` · <span class="errtext">${plural(errors, 'exception')}</span>` : ''}</span> <a href="#" class="open" data-key="${esc(file.key)}" data-line="${states.size ? Math.min(...states.keys()) : 1}">Open in editor</a></h2>`;
  let body;
  if (lines) {
    const inferred = options.inferLines === false ? new Map() : inferredLines(analysis, file.key, (n) => lines[n - 1] || '', lines.length);
    const failed = new Set([...states].filter(([, s]) => s.state === 'exception').map(([n]) => n));
    abortedLines(analysis, file.key).forEach((n) => failed.add(n));
    const braces = closingBraceLines(lines, new Set([...states.keys(), ...inferred.keys()]), failed);
    let inComment = false;
    const coloured = lines.map((text) => {
      const out = highlightApex(text, inComment);
      inComment = out.inComment;
      return out.html;
    });
    body = lines
      .map((text, i) => {
        const n = i + 1;
        const state = states.get(n);
        const notes = state ? lineNotes(analysis, state.data) : '';
        const guess = !state && inferred.get(n);
        const brace = !state && !guess && braces.has(n);
        return `<div class="row ${state ? state.state : guess ? 'inferred' : brace ? 'executed' : ''}"${guess ? ` title="Not in the log; most likely ran: ${guess.calls ? `it calls ${esc(guess.calls)}(), which the log shows running` : `between recorded lines ${guess.from} and ${guess.to}`}"` : ''} data-key="${esc(file.key)}" data-line="${n}"><span class="ln">${n}</span><span class="hits">${state && state.count > 1 ? `×${state.count}` : ''}</span><code>${coloured[i] || ' '}</code></div>${notes ? `<div class="notes">${notes}</div>` : ''}`;
      })
      .join('');
  } else {
    body =
      `<div class="missing">The source of ${esc(file.name)} is not in this workspace. Recorded lines:</div>` +
      [...states.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([n, s]) => `<div class="row ${s.state}"><span class="ln">${n}</span><span class="hits">${s.count > 1 ? `×${s.count}` : ''}</span><code></code></div><div class="notes">${lineNotes(analysis, s.data)}</div>`)
        .join('');
  }
  return `<section class="file">${header}<div class="code">${body}</div></section>`;
}

// Everything known about one exception, as plain text for the hover box and Copy.
function exceptionText(ex) {
  const lines = [`${ex.type}`, ex.message, '', `Thrown at ${ex.fileName || 'unknown'} line ${ex.line || '?'}${ex.time ? ` at ${ex.time}` : ''}`, `What happened: ${exceptionStatus(ex)}`];
  if (ex.resumedAt) {
    lines.push(`Execution continued at ${ex.resumedAt.fileName} line ${ex.resumedAt.line}`);
  }
  if (ex.stack && ex.stack.length) {
    lines.push('', 'Stack trace:', ...ex.stack.map((s) => `  ${s.frame || s.fileName || '?'}${s.line ? ` line ${s.line}` : ''}`));
  }
  if (ex.fatalText && ex.fatalText !== ex.message) {
    lines.push('', 'Fatal error:', ex.fatalText);
  }
  return lines.join('\n');
}

// Each run of a trigger (BeforeUpdate, AfterUpdate...) as { fid, event }: one
// save runs the same trigger several times, each taking its own branches.
function triggerRuns(analysis, key) {
  return analysis.steps
    .filter((s) => s.kind === 'unit' && s.file === key && s.fid !== undefined)
    .map((s) => ({ fid: s.fid, event: ((/trigger event (\w+)/.exec(s.text) || [])[1] || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase() }));
}

// Whether a step index lies inside one trigger run: from its start to the
// first later step outside it.
function runRange(analysis, fid) {
  const start = analysis.steps.findIndex((s) => s.kind === 'unit' && s.fid === fid);
  if (start < 0) {
    return () => false;
  }
  const depth = analysis.steps[start].depth;
  let end = start + 1;
  while (end < analysis.steps.length && analysis.steps[end].depth >= depth && !(analysis.steps[end].kind === 'unit' && analysis.steps[end].depth === depth)) {
    end++;
  }
  return (index) => index >= start && index < end;
}

// Lines one trigger run reached: line -> exception index (or undefined).
function runLines(analysis, key, fid) {
  const lines = new Map();
  analysis.steps.forEach((s, index) => {
    if (s.file !== key || s.fid !== fid || !s.line) {
      return;
    }
    const ex = s.kind === 'exception' ? analysis.exceptions.findIndex((e) => e.step === index) : -1;
    if (ex >= 0) {
      lines.set(s.line, ex);
    } else if (!lines.has(s.line)) {
      lines.set(s.line, undefined);
    }
  });
  return lines;
}

// The plain view next to the log: the whole file, lines that ran green and the
// line that threw red, like test coverage. No counts or notes; the error
// message is the red line's tooltip. With `options.run`, only that trigger run.
function coverageFileHtml(analysis, file, lines, options) {
  const kind = file.kind === 'trigger' ? 'Trigger' : 'Class';
  const run = options.run;
  const header = `<h2 id="${esc(run ? `${file.key}#${run.fid}` : file.key)}"><span class="num">${options.number}</span><span class="badge ${file.kind}">${kind}</span> ${esc(file.name)}${run && run.event ? ` <span class="dim">${esc(run.event)}</span>` : ''}</h2>`;
  if (!lines) {
    return `<section class="file">${header}<div class="missing">${esc(file.name)} is not in this workspace.</div></section>`;
  }
  let reached;
  if (run) {
    reached = runLines(analysis, file.key, run.fid);
  } else {
    reached = new Map();
    for (const [n, s] of lineStates(analysis, file.key, { hotThreshold: options.hotThreshold })) {
      reached.set(n, s.state === 'exception' ? s.data.exceptions[s.data.exceptions.length - 1] : undefined);
    }
  }
  const scope = run ? { ...analysis, steps: analysis.steps.filter((s) => s.fid === run.fid) } : analysis;
  const inferred = options.inferLines === false ? new Map() : inferredLines(scope, file.key, (n) => lines[n - 1] || '', lines.length);
  const ran = new Set([...reached.keys(), ...inferred.keys()]);
  const failed = new Set([...reached].filter(([, ex]) => ex !== undefined).map(([n]) => n));
  // Lines an exception jumped out of only matter for the braces after them.
  const left = new Set([...failed, ...abortedLines(analysis, file.key, run ? runRange(analysis, run.fid) : undefined)]);
  const braces = closingBraceLines(lines, ran, left);
  // System.debug output of each line (this run only), shown on hover.
  const debug = new Map();
  for (const s of scope.steps) {
    if (s.kind === 'debug' && s.file === file.key && s.line) {
      const list = debug.get(s.line) || [];
      list.push(`${s.time ? `${s.time}  ` : ''}${s.level ? `${s.level}  ` : ''}${String(s.text).replace(/^System\.debug: /, '')}`);
      debug.set(s.line, list);
    }
  }
  const debugText = [];
  let inComment = false;
  const rows = lines.map((text, i) => {
    const n = i + 1;
    const out = highlightApex(text, inComment);
    inComment = out.inComment;
    let cls = ran.has(n) || braces.has(n) ? 'ran' : '';
    let exAttr = '';
    if (failed.has(n)) {
      cls = 'err';
      exAttr = ` data-ex="${reached.get(n)}"`;
    }
    if (debug.has(n)) {
      const id = `${options.number}-${n}`;
      const list = debug.get(n);
      exAttr += ` data-dbg="${id}"`;
      debugText.push(`<pre class="exsrc" id="dbg-${id}" hidden data-title="System.debug · line ${n}${list.length > 1 ? ` · ${list.length} times` : ''}">${esc(list.join('\n'))}</pre>`);
    }
    return `<div class="row ${cls}"${exAttr} data-key="${esc(file.key)}" data-line="${n}"><span class="ln">${n}</span><code>${out.html || ' '}</code></div>`;
  });
  return `<section class="file">${header}<div class="code">${rows.join('')}</div>${debugText.join('')}</section>`;
}

// `sources`: Map file key -> array of source lines (missing when not in the workspace).
function buildHtml(analysis, sources, options) {
  const files = filesInRunOrder(analysis);
  const summary = analysis.summary || {};
  const debugSteps = analysis.steps.filter((s) => s.kind === 'debug');
  const nav = files
    .map((f) => {
      const errors = f.exceptions ? ` <span class="errtext">✖${f.exceptions}</span>` : '';
      return `<li><a href="#${esc(f.key)}" class="jump"><span class="badge ${f.kind}">${f.kind === 'trigger' ? 'T' : 'C'}</span> ${esc(f.name)}${errors}</a></li>`;
    })
    .join('');
  const exceptions = analysis.exceptions.length
    ? analysis.exceptions.map((ex) => exceptionHtml(analysis, ex)).join('')
    : '<div class="dim">No exceptions in this log.</div>';
  const debug = debugSteps.length
    ? debugSteps
        .map((s) => {
          return `<div class="logline${/\b(ERROR|exception)\b/i.test(s.text) ? ' err' : ''}"><span class="dim">${esc(s.time || '')}</span> <a href="#" data-key="${esc(s.file)}" data-line="${esc(s.line)}">${esc(s.frame || '')}${s.line ? `:${esc(s.line)}` : ''}</a> ${esc(String(s.text).replace(/^System\.debug: /, ''))}</div>`;
        })
        .join('')
    : '<div class="dim">No System.debug output in this log.</div>';
  const notes = analysis.notes.map((n) => `<div class="infonote">${esc(n)}</div>`).join('');
  // Coverage view: a trigger that ran more than once gets one section per run,
  // so the branch each run took is not mixed with the others.
  const views = options.coverage
    ? files.flatMap((f) => {
        const runs = f.kind === 'trigger' ? triggerRuns(analysis, f.key) : [];
        return runs.length > 1 ? runs.map((run) => ({ file: f, run })) : [{ file: f }];
      })
    : [];
  const code = !files.length
    ? '<div class="dim">The log names no class or trigger from this workspace.</div>'
    : options.coverage
      ? views.map((v, i) => coverageFileHtml(analysis, v.file, sources.get(v.file.key), { ...options, number: i + 1, run: v.run })).join('')
      : files.map((f) => fileHtml(analysis, f, sources.get(f.key), options)).join('');
  const legend = '<div class="legend"><span class="l-ran">ran</span><span class="l-inf">most likely ran (not in the log)</span><span class="l-hot">ran often / repeated query</span><span class="l-ex">exception</span><span class="dim">Click a line to open it in the editor.</span></div>';
  // Coverage view: next to the log, just the code that ran, trigger first.
  const body = options.coverage
    ? `<div class="bar"><b>${esc(options.title)}</b></div>
<main class="coverage">${code}</main>
${analysis.exceptions.map((ex, i) => `<pre class="exsrc" id="ex-${i}" hidden>${esc(exceptionText(ex))}</pre>`).join('')}
<div class="expop" id="expop" hidden><div class="expop-head"><b id="expopTitle"></b><span class="spacer"></span><button class="copy" id="expopCopy">Copy</button></div><pre id="expopBody"></pre></div>`
    : `<div class="layout">
<aside>
  <h3>In this log</h3>
  <ul>
    <li><a href="#exceptions" class="jump">Exceptions${analysis.exceptions.length ? ` <span class="errtext">(${analysis.exceptions.length})</span>` : ''}</a></li>
    <li><a href="#debug" class="jump">Debug log (${debugSteps.length})</a></li>
  </ul>
  <h3>Triggers and classes, in run order</h3>
  <ul>${nav || '<li class="dim">None</li>'}</ul>
</aside>
<main>
  <div class="titlerow"><h1>${esc(options.title)}</h1></div>
  <div class="dim">${esc(options.org ? `Org ${options.org} · ` : '')}Apex Code level ${esc(analysis.apexLevel || 'unknown')}${analysis.user && analysis.user.username ? ` · run by ${esc(analysis.user.username)}` : ''}</div>
  <div class="stats">
    <div><b>${(summary.durationMs || 0).toLocaleString()} ms</b>duration</div>
    <div><b>${files.length}</b>classes / triggers</div>
    <div><b>${analysis.queries.size ? [...analysis.queries.values()].reduce((n, q) => n + q.count, 0) : 0}</b>SOQL</div>
    <div><b class="${analysis.exceptions.length ? 'errtext' : ''}">${analysis.exceptions.length}</b>exceptions</div>
    <div><b>${debugSteps.length}</b>debug lines</div>
  </div>
  ${notes}
  <h2 id="exceptions">Exceptions</h2>
  ${exceptions}
  <h2 id="debug">Debug log</h2>
  <div class="debuglog">${debug}</div>
  ${legend}
  ${code}
</main>
</div>`;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${options.nonce}'; script-src 'nonce-${options.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(options.title)}</title>
<style nonce="${options.nonce}">
  /* Always the Dark Modern look, in light and dark VS Code themes alike. */
  :root { --dm-bg: #1f1f1f; --dm-fg: #cccccc; --dm-side: #181818; --dm-border: #2b2b2b; --dm-hover: #2a2d2e; --dm-link: #4daafc; --dm-muted: #9d9d9d; --dm-badge: #616161; --dm-quote: #2b2b2b; --dm-error: #f85149; --dm-focus: #0078d4; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--dm-fg); background: var(--dm-bg); color-scheme: dark; }
  a { color: var(--dm-link); text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }
  .layout { display: grid; grid-template-columns: 260px 1fr; height: 100vh; }
  aside { border-right: 1px solid var(--dm-border); overflow: auto; padding: 12px; background: var(--dm-side); }
  aside h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin: 16px 0 6px; opacity: .8; }
  aside ul { list-style: none; margin: 0; padding: 0; }
  aside li a { display: block; padding: 3px 4px; border-radius: 3px; color: var(--dm-fg); }
  aside li a:hover { background: var(--dm-hover); text-decoration: none; }
  main { overflow: auto; padding: 16px 24px 80px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 28px 0 8px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  h2 .open { margin-left: auto; font-weight: normal; font-size: 12px; }
  .dim { opacity: .7; font-weight: normal; font-size: 12px; }
  .badge { font-size: 10px; padding: 1px 5px; border-radius: 3px; font-weight: bold; color: #fff; background: #3b82c4; }
  .badge.trigger { background: #a855c7; }
  .stats { display: flex; gap: 18px; flex-wrap: wrap; margin: 8px 0 12px; font-size: 12px; }
  .stats b { font-size: 15px; display: block; }
  .infonote { font-size: 12px; padding: 4px 8px; border-left: 3px solid var(--dm-link); margin: 4px 0; background: var(--dm-quote); }
  .exception { border: 1px solid var(--dm-error); border-left-width: 4px; border-radius: 4px; padding: 8px 12px; margin: 8px 0; background: rgba(241, 76, 76, .08); }
  .ex-title { color: var(--dm-error); font-weight: bold; }
  .ex-title .where { font-weight: normal; color: var(--dm-fg); font-size: 12px; }
  .ex-message { color: var(--dm-error); white-space: pre-wrap; word-break: break-word; margin: 6px 0; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .ex-status { font-size: 12px; font-style: italic; }
  .label { font-size: 11px; text-transform: uppercase; opacity: .7; margin-top: 8px; }
  .stack { margin: 4px 0; padding-left: 22px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .errtext { color: var(--dm-error); }
  .debuglog { font-family: var(--vscode-editor-font-family); font-size: 12px; max-height: 320px; overflow: auto; border: 1px solid var(--dm-border); padding: 6px; }
  .logline { padding: 1px 0; white-space: pre-wrap; word-break: break-word; }
  .logline.err { color: var(--dm-error); }
  .code { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 13px); border: 1px solid var(--dm-border); }
  .row { display: grid; grid-template-columns: 52px 40px 1fr; white-space: pre; cursor: pointer; }
  .row:hover { outline: 1px solid var(--dm-focus); }
  .row .ln { text-align: right; padding-right: 8px; opacity: .5; user-select: none; }
  .row .hits { font-size: 11px; opacity: .8; }
  /* VS Code gives <code> in webviews a grey box; the code sits on the editor background instead. */
  .row code { font-family: inherit; overflow: hidden; text-overflow: ellipsis; background: transparent; padding: 0; border-radius: 0; color: inherit; font-size: inherit; }
  /* Coverage like the editor highlighting: a coloured edge and a tinted line. */
  .row { border-left: 3px solid transparent; }
  .row.executed { background: rgba(46, 160, 67, .16); border-left-color: #3fb950; }
  .row.hot { background: rgba(210, 153, 34, .22); border-left-color: #d29922; }
  .row.exception { background: rgba(241, 76, 76, .26); border-left-color: #f14c4c; }
  .row.inferred { background: rgba(46, 160, 67, .06); border-left: 3px dotted #3fb950; }
  .row.executed .ln, .row.hot .ln, .row.exception .ln { opacity: .9; }
  .row.exception .ln { color: #f14c4c; font-weight: bold; }
  /* Apex colours: Dark Modern (Dark+ tokens), whatever the VS Code theme. */
  .t-keyword { color: #569cd6; } .t-control { color: #c586c0; } .t-type { color: #4ec9b0; } .t-function { color: #dcdcaa; }
  .t-variable { color: #9cdcfe; } .t-string { color: #ce9178; } .t-number { color: #b5cea8; } .t-comment { color: #6a9955; font-style: italic; }
  .t-annotation { color: #dcdcaa; } .t-soql { color: #569cd6; font-weight: 600; }
  .notes { padding: 2px 0 4px 92px; font-size: 12px; }
  .note { white-space: pre-wrap; word-break: break-word; padding: 1px 6px; border-left: 3px solid transparent; margin: 1px 0; }
  .note.err { color: var(--dm-error); border-color: var(--dm-error); background: rgba(241, 76, 76, .08); }
  .note.debug { border-color: #3b82c4; }
  .note.soql { border-color: #2ea043; }
  .note.dml { border-color: #d29922; }
  .note.var { border-color: #888; opacity: .8; }
  .missing { padding: 6px; font-style: italic; }
  .legend { display: flex; gap: 12px; font-size: 12px; margin: 6px 0; flex-wrap: wrap; }
  .legend span::before { content: ''; display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: middle; }
  .legend .l-ex::before { background: rgba(241, 76, 76, .6); }
  .legend .l-hot::before { background: rgba(210, 153, 34, .6); }
  .legend .l-ran::before { background: rgba(46, 160, 67, .6); }
  .legend .l-inf::before { border-left: 3px dotted rgba(46, 160, 67, .8); width: 7px; }
  .spacer { flex: 1; }
  .titlerow { display: flex; align-items: center; gap: 10px; }
  .bar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 8px 16px; background: var(--dm-side); border-bottom: 1px solid var(--dm-border); }
  main.coverage { height: auto; overflow: visible; padding: 8px 16px 80px; }
  /* Coverage view: VS Code's editor background, one green for ran, one red for the error. */
  body.coverage { --dm-bg: #1e1e1e; --dm-side: #1e1e1e; --dm-border: #333333; }
  /* In a dark theme, use the editor's own background colour. */
  body.vscode-dark, body.vscode-high-contrast { --dm-bg: var(--vscode-editor-background, #1e1e1e); --dm-side: var(--vscode-editor-background, #1e1e1e); }
  .coverage .code { border: 0; }
  .coverage .row { grid-template-columns: 56px 1fr; border-left: 4px solid transparent; line-height: 1.5; cursor: pointer; }
  .coverage .row:hover { outline: none; filter: brightness(1.15); }
  .coverage .row .ln { color: #6e7681; opacity: 1; padding-right: 14px; }
  .coverage .row.ran { background: rgba(35, 134, 54, 0.35); border-left-color: #2ea043; }
  .coverage .row.err { background: rgba(218, 54, 51, 0.45); border-left-color: #f85149; }
  .coverage .row.ran .ln, .coverage .row.err .ln { color: #c9d1d9; }
  .coverage h2 { margin: 22px 0 6px; font-size: 13px; }
  /* Error details: only on hover over the red line, with a Copy button. */
  .expop { position: absolute; z-index: 5; max-width: min(760px, calc(100vw - 40px)); background: #252526; color: #cccccc; border: 1px solid #454545; border-left: 3px solid #f85149; border-radius: 4px; box-shadow: 0 6px 18px rgba(0, 0, 0, .5); }
  .expop-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid #3c3c3c; }
  .expop-head b { color: #f85149; }
  .expop.debug { border-left-color: #4daafc; }
  .expop.debug .expop-head b { color: #4daafc; }
  /* A line with System.debug output: a blue dot by its number, details on hover. */
  .coverage .row[data-dbg] .ln { position: relative; }
  .coverage .row[data-dbg] .ln::before { content: ''; position: absolute; left: 6px; top: 50%; width: 6px; height: 6px; margin-top: -3px; border-radius: 50%; background: #4daafc; }
  .expop pre { margin: 0; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 12px; max-height: 50vh; overflow: auto; user-select: text; background: transparent; }
  .copy { border: 1px solid #3c3c3c; border-radius: 3px; padding: 2px 10px; cursor: pointer; color: #cccccc; background: #2d2d2d; }
  .copy:hover { background: #3a3a3a; }
  h2 .num { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; font-size: 11px; background: var(--dm-badge); color: #fff; }
  @media (max-width: 700px) { .layout { grid-template-columns: 1fr; } aside { display: none; } }
</style></head>
<body class="${options.coverage ? 'coverage' : ''}">${body}
<script nonce="${options.nonce}">
  const vscode = acquireVsCodeApi();
  // Hovering a red line shows its error, a line with a blue dot its debug
  // output; the box stays open while the mouse is on it, so its text can be
  // selected and copied, or copied whole with Copy.
  const pop = document.getElementById('expop');
  const POP_ROW = '.row.err[data-ex], .row[data-dbg]';
  let hideTimer;
  let shownRow;
  const hidePop = () => { hideTimer = setTimeout(() => { if (pop) { pop.hidden = true; shownRow = undefined; } }, 250); };
  if (pop) {
    document.addEventListener('mouseover', (event) => {
      const row = event.target.closest(POP_ROW);
      if (row) {
        clearTimeout(hideTimer);
        if (row === shownRow && !pop.hidden) return;
        shownRow = row;
        let title = '';
        const parts = [];
        if (row.dataset.ex !== undefined && row.classList.contains('err')) {
          const text = document.getElementById('ex-' + row.dataset.ex).textContent;
          title = text.split('\\n')[0];
          parts.push(text.split('\\n').slice(1).join('\\n').trim());
        }
        if (row.dataset.dbg) {
          const source = document.getElementById('dbg-' + row.dataset.dbg);
          title = title || source.dataset.title;
          parts.push((parts.length ? 'Debug output:\\n' : '') + source.textContent);
        }
        pop.classList.toggle('debug', !row.classList.contains('err'));
        document.getElementById('expopTitle').textContent = title;
        document.getElementById('expopBody').textContent = parts.join('\\n\\n');
        pop.dataset.text = row.classList.contains('err') ? title + '\\n' + parts.join('\\n\\n') : parts.join('\\n\\n');
        document.getElementById('expopCopy').textContent = 'Copy';
        const box = row.getBoundingClientRect();
        pop.hidden = false;
        pop.style.left = Math.max(8, Math.min(box.left + 60, window.innerWidth - pop.offsetWidth - 8)) + window.scrollX + 'px';
        pop.style.top = box.bottom + window.scrollY + 2 + 'px';
      } else if (event.target.closest('#expop')) {
        clearTimeout(hideTimer);
      }
    });
    document.addEventListener('mouseout', (event) => {
      if (event.target.closest(POP_ROW) || event.target.closest('#expop')) hidePop();
    });
    document.getElementById('expopCopy').addEventListener('click', (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'copy', text: pop.dataset.text || '' });
      event.target.textContent = 'Copied';
    });
  }
  document.addEventListener('click', (event) => {
    const jump = event.target.closest('a.jump');
    if (jump) {
      event.preventDefault();
      const target = document.getElementById(decodeURIComponent(jump.getAttribute('href').slice(1)));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (event.target.closest('#expop')) {
      return;
    }
    const link = event.target.closest('[data-key]');
    if (link && link.dataset.key) {
      event.preventDefault();
      vscode.postMessage({ type: 'open', key: link.dataset.key, line: Number(link.dataset.line) || 1 });
    }
  });
</script>
</body></html>`;
}

// Opens the explorer for the log file at `uri`, or, without one, for the
// active editor's log or else the log already selected in Sales Grid.
// `selectedOnly` skips the editor: the caller has just picked the log.
async function openLogExplorer(insight, uri, selectedOnly = false) {
  const editor = !selectedOnly && vscode.window.activeTextEditor;
  const target = uri && uri.fsPath ? uri : editor && /\.log$/i.test(editor.document.uri.fsPath) ? editor.document.uri : undefined;
  let analysis = insight.analysis;
  if (target) {
    if (target.scheme !== 'file') {
      vscode.window.showInformationMessage('Sales Grid: the Log Explorer needs a debug log saved on disk.');
      return undefined;
    }
    const file = target.fsPath;
    if (!analysis || path.resolve(analysis.file) !== path.resolve(file)) {
      const base = path.basename(file, path.extname(file));
      const id = /^[a-zA-Z0-9]{15,18}$/.test(base) ? base : undefined;
      analysis = await insight.select({ file, id, title: path.basename(file) }, { highlight: true });
    }
  } else if (!analysis) {
    analysis = await insight.load();
  }
  if (!analysis) {
    vscode.window.showInformationMessage('Sales Grid: open or pick an Apex debug log first.');
    return undefined;
  }
  return showExplorer(insight, analysis);
}

// Source lines of every workspace file the log ran.
async function readSources(insight, analysis) {
  const sources = new Map();
  for (const key of analysis.files.keys()) {
    const sourceUri = await insight.uriFor(key);
    if (sourceUri) {
      try {
        sources.set(key, (await fs.promises.readFile(sourceUri.fsPath, 'utf8')).split(/\r?\n/));
      } catch {
        // Unreadable now: shown as "not in this workspace".
      }
    }
  }
  return sources;
}

// The Log Explorer page, or with `coverage` only the code that ran (trigger
// first), as shown next to the log by Open Log with Class. No close button or
// Escape: the window's own buttons close it.
async function createPanel(insight, analysis, { coverage = false, viewColumn = vscode.ViewColumn.Active } = {}) {
  const sources = await readSources(insight, analysis);
  const name = (insight.selected && insight.selected.title) || path.basename(analysis.file);
  const title = coverage ? `Code that ran: ${name}` : `Log Explorer: ${name}`;
  const panel = vscode.window.createWebviewPanel(coverage ? 'salesgrid.coverage' : 'salesgrid.logExplorer', title, viewColumn, { enableScripts: true, retainContextWhenHidden: true });
  const config = vscode.workspace.getConfiguration('salesgrid');
  panel.webview.html = buildHtml(analysis, sources, {
    nonce: crypto.randomBytes(16).toString('hex'),
    title: coverage ? name : title,
    coverage,
    org: insight.selected && insight.selected.org,
    hotThreshold: config.get('executionHighlight.hotLineThreshold') || 50,
    inferLines: config.get('executionHighlight.inferLines') !== false
  });
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message && message.type === 'open') {
      insight.goToLocation(message.key, message.line, { viewColumn: vscode.ViewColumn.One, preview: true });
    } else if (message && message.type === 'copy') {
      await vscode.env.clipboard.writeText(String(message.text || '').slice(0, 50000));
    }
  });
  return panel;
}

async function showExplorer(insight, analysis) {
  const panel = await createPanel(insight, analysis);
  // A maximized window of its own; without one, the panel fills the editor area.
  if (await moveToNewWindow()) {
    await maximize();
  } else {
    await Promise.resolve(vscode.commands.executeCommand('workbench.action.maximizeEditor')).catch(() => undefined);
  }
  return panel;
}

module.exports = { openLogExplorer, createPanel, buildHtml, filesInRunOrder, highlightApex };
