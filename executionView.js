// Shows what a debug log recorded, on the Apex source itself: executed lines
// in green, exceptions in red, heavy lines in yellow, details on hover, a
// step-by-step replay of the recorded path, and the Debug Logs sidebar that
// switches debugging on and picks the log. Nothing from a log leaves this
// computer.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { analyzeLog, findings, lineStates, lineCount, verifySource, exceptionStatus, fileKey, inferredLines, closingBraceLines, abortedLines } = require('./executionAnalyzer');
const { parseLog } = require('./logParser');
const { logFolder, logOrg, downloadLog } = require('./salesGridPage');
const { openLogExplorer, createPanel } = require('./logExplorer');
const { moveToNewWindow, moveGroupToNewWindow, maximize, wanted: wantNewWindow } = require('./popOut');

const SELECTED_KEY = 'salesgrid.highlightLog';
const LOG_LIST_SIZE = 50;
const HOVER_COMMANDS = ['salesgrid.inspectLine', 'salesgrid.replay.goto', 'salesgrid.showLogLine', 'salesgrid.goToLocation'];

function setContext(key, value) {
  vscode.commands.executeCommand('setContext', key, value);
}

function settings() {
  return vscode.workspace.getConfiguration('salesgrid');
}

function hotThreshold() {
  return Math.max(2, Number(settings().get('executionHighlight.hotLineThreshold')) || 50);
}

// Markdown-safe text for hovers.
function md(text) {
  return String(text === undefined || text === null ? '' : text).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

function code(text, max = 160) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  const short = value.length > max ? `${value.slice(0, max)}…` : value;
  return `\`${short.replace(/`/g, "'")}\``;
}

function commandLink(label, command, args) {
  return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
}

function when(value) {
  const date = new Date(String(value || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function size(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function minutesLeft(iso) {
  const minutes = Math.max(0, Math.round((new Date(String(iso).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime() - Date.now()) / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min left` : `${minutes} min left`;
}

// The analyser's key for an open Apex file, or undefined for anything else.
function keyOfDocument(document) {
  if (!document || document.uri.scheme !== 'file') {
    return undefined;
  }
  const match = /^(\w+)\.(cls|trigger)$/i.exec(path.basename(document.uri.fsPath));
  return match ? fileKey(match[2].toLowerCase() === 'cls' ? 'class' : 'trigger', match[1]) : undefined;
}

// A log without METHOD_ENTRY events does not say which class ran a query, so
// the analyser checks lines against the workspace source. Only read then.
async function readSourceIfNeeded(text, index) {
  if (text.includes('|METHOD_ENTRY|') || !/\|(SOQL_EXECUTE_BEGIN|SOSL_EXECUTE_BEGIN|DML_BEGIN|USER_DEBUG)\|/.test(text)) {
    return undefined;
  }
  const source = new Map();
  for (const [key, uris] of [...index].slice(0, 5000)) {
    if (!uris || !uris[0]) {
      continue;
    }
    try {
      const body = await fs.promises.readFile(uris[0].fsPath, 'utf8');
      source.set(key, { name: path.basename(uris[0].fsPath).replace(/\.\w+$/, ''), lines: body.split(/\r?\n/) });
    } catch {
      // A file that went away since indexing is simply skipped.
    }
  }
  return source;
}

class ExecutionInsight {
  // deps: { context, output, log, provider, debugger, fileOrg(), selectFileOrg(), page }
  constructor(deps) {
    Object.assign(this, deps);
    this.selected = deps.context.workspaceState.get(SELECTED_KEY);
    this.analysis = undefined;
    this.analysing = undefined;
    this.highlightOn = false;
    this.replayIndex = -1;
    this.orgConfirmed = undefined;
    this.classIndex = undefined;
    this.verified = new Map();
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChange = this._onDidChange.event;

    const marker = (name) => new vscode.ThemeColor(name);
    const lineType = (background, edge) =>
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: marker(background),
        borderColor: marker(edge),
        borderStyle: 'solid',
        borderWidth: '0 0 0 3px',
        overviewRulerColor: marker(edge),
        overviewRulerLane: vscode.OverviewRulerLane.Left
      });
    this.types = {
      executed: lineType('salesgrid.executedLineBackground', 'salesgrid.executedLineMarker'),
      exception: lineType('salesgrid.exceptionLineBackground', 'salesgrid.exceptionLineMarker'),
      hot: lineType('salesgrid.hotLineBackground', 'salesgrid.hotLineMarker'),
      replay: vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: marker('salesgrid.replayLineBackground'),
        borderColor: marker('focusBorder'),
        borderStyle: 'solid',
        borderWidth: '1px 0 1px 0',
        overviewRulerColor: marker('focusBorder'),
        overviewRulerLane: vscode.OverviewRulerLane.Full
      }),
      inferred: vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: marker('salesgrid.inferredLineBackground'),
        borderColor: marker('salesgrid.executedLineMarker'),
        borderStyle: 'dotted',
        borderWidth: '0 0 0 3px'
      })
    };
    this.status = vscode.window.createStatusBarItem('salesgrid.executionHighlight', vscode.StatusBarAlignment.Left, -0.06);
    this.status.name = 'Sales Grid: Execution Highlighting';
    this.replayStatus = vscode.window.createStatusBarItem('salesgrid.replay', vscode.StatusBarAlignment.Left, -0.065);
    this.replayStatus.name = 'Sales Grid: Replay';
    this.replayStatus.command = 'salesgrid.replay.menu';
    setContext('salesgrid.logSelected', !!this.selected);
    setContext('salesgrid.highlightOn', false);
    setContext('salesgrid.replayActive', false);
  }

  dispose() {
    Object.values(this.types).forEach((type) => type.dispose());
    this.status.dispose();
    this.replayStatus.dispose();
    if (this.indexWatcher) {
      this.indexWatcher.dispose();
    }
  }

  // ---------- which log ----------

  // Classes and triggers in the workspace, by analyser key. Built once and
  // kept up to date as files are added or removed.
  async index() {
    if (!this.classIndex) {
      this.classIndex = (async () => {
        const map = new Map();
        const uris = await vscode.workspace.findFiles('**/*.{cls,trigger}', '{**/node_modules/**,**/.sfdx/**,**/.sf/**}', 20000);
        for (const uri of uris) {
          this.addToIndex(map, uri);
        }
        if (!this.indexWatcher) {
          this.indexWatcher = vscode.workspace.createFileSystemWatcher('**/*.{cls,trigger}', false, true, false);
          this.indexWatcher.onDidCreate(async (uri) => this.addToIndex(await this.classIndex, uri));
          this.indexWatcher.onDidDelete(async (uri) => {
            const key = keyOfDocument({ uri });
            const map2 = await this.classIndex;
            if (key && map2.has(key)) {
              map2.set(key, map2.get(key).filter((other) => other.toString() !== uri.toString()));
            }
          });
        }
        return map;
      })();
    }
    return this.classIndex;
  }

  addToIndex(map, uri) {
    const key = keyOfDocument({ uri });
    if (key) {
      const list = map.get(key) || [];
      // Prefer the copy inside a package folder over stray copies elsewhere.
      list.push(uri);
      list.sort((a, b) => Number(/[\\/]force-app[\\/]/.test(b.fsPath)) - Number(/[\\/]force-app[\\/]/.test(a.fsPath)));
      map.set(key, list);
    }
  }

  async uriFor(key) {
    const list = (await this.index()).get(key);
    return list && list[0];
  }

  // `entry`: { id, org, file, title, start, user } of a log in the org or on disk.
  async select(entry, options = {}) {
    this.stopReplay();
    this.selected = entry;
    this.analysis = undefined;
    this.orgConfirmed = undefined;
    this.verified.clear();
    await this.context.workspaceState.update(SELECTED_KEY, entry);
    setContext('salesgrid.logSelected', true);
    this._onDidChange.fire();
    const analysis = await this.load();
    if (analysis && options.highlight) {
      await this.setHighlight(true);
    } else {
      this.applyAll();
    }
    return analysis;
  }

  async clearSelection() {
    this.stopReplay();
    this.selected = undefined;
    this.analysis = undefined;
    await this.context.workspaceState.update(SELECTED_KEY, undefined);
    setContext('salesgrid.logSelected', false);
    await this.setHighlight(false);
    this._onDidChange.fire();
  }

  // Reads and analyses the selected log once; later calls reuse the result.
  async load() {
    if (this.analysis) {
      return this.analysis;
    }
    if (!this.selected) {
      return undefined;
    }
    if (!this.analysing) {
      const entry = this.selected;
      this.analysing = vscode.window
        .withProgress({ location: vscode.ProgressLocation.Notification, title: `Sales Grid: analysing ${entry.title || 'debug log'}…` }, async () => {
          let file = entry.file;
          if (!file || !fs.existsSync(file)) {
            if (!entry.id || !entry.org) {
              throw new Error('The log file is no longer on disk.');
            }
            file = await downloadLog(this.context, this.debugger, entry.org, entry.id);
            entry.file = file;
          }
          const text = await fs.promises.readFile(file, 'utf8');
          const index = await this.index();
          const knownClasses = [...index.keys()].filter((key) => key.startsWith('class:')).map((key) => key.slice(6));
          const started = Date.now();
          const source = await readSourceIfNeeded(text, index);
          const analysis = analyzeLog(text, { knownClasses, source });
          analysis.summary = parseLog(text);
          analysis.findings = findings(analysis, { hotThreshold: hotThreshold(), limits: analysis.summary.limits });
          analysis.file = file;
          analysis.fileTime = (await fs.promises.stat(file)).mtimeMs;
          this.log(`Analysed ${entry.title || path.basename(file)}: ${analysis.files.size} class/trigger file(s), ${analysis.steps.length.toLocaleString()} steps, ${analysis.exceptions.length} exception(s) in ${Date.now() - started} ms.`);
          if (!entry.org && analysis.user && analysis.user.username) {
            const orgs = this.provider.orgs || [];
            const match = orgs.find((org) => org.username.toLowerCase() === analysis.user.username.toLowerCase());
            entry.org = match ? match.username : undefined;
            entry.recordedFor = analysis.user.username;
          }
          return analysis;
        })
        .then(
          (analysis) => {
            if (this.selected === entry) {
              this.analysis = analysis;
            }
            this.analysing = undefined;
            this._onDidChange.fire();
            return analysis;
          },
          (error) => {
            this.analysing = undefined;
            this.log(`FAILED: could not analyse the debug log. ${error.message}`);
            vscode.window.showErrorMessage(`Sales Grid: could not analyse the debug log. ${error.message}`);
            return undefined;
          }
        );
    }
    return this.analysing;
  }

  // Logs from another org would colour the wrong code; ask once per log.
  async orgMatches() {
    if (this.orgConfirmed !== undefined || !this.selected) {
      return this.orgConfirmed !== false;
    }
    const org = await this.fileOrg();
    const logOrgName = this.selected.org;
    if (!org || !logOrgName || org.username === logOrgName) {
      this.orgConfirmed = true;
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      `This log was recorded in ${logOrgName}, but this project uses ${org.alias || org.username}.`,
      { modal: true, detail: 'The code in the two orgs may differ, so the highlighted lines may not match your files.' },
      'Highlight Anyway'
    );
    this.orgConfirmed = choice === 'Highlight Anyway';
    return this.orgConfirmed;
  }

  // ---------- highlighting ----------

  async setHighlight(on) {
    if (on) {
      if (!this.selected) {
        vscode.window.showInformationMessage('Sales Grid: pick a debug log first, on the Debug Logs tab of the Sales Grid page.');
        return;
      }
      if (!(await this.load()) || !(await this.orgMatches())) {
        return;
      }
    }
    this.highlightOn = on;
    setContext('salesgrid.highlightOn', on);
    if (!on) {
      this.stopReplay();
    }
    this.applyAll();
    this._onDidChange.fire();
  }

  applyAll() {
    for (const editor of vscode.window.visibleTextEditors) {
      this.apply(editor);
    }
    this.updateStatus();
  }

  apply(editor) {
    const document = editor.document;
    const key = keyOfDocument(document);
    const clear = () => Object.values(this.types).forEach((type) => editor.setDecorations(type, []));
    if (!key || !this.highlightOn || !this.analysis) {
      clear();
      return;
    }
    const states = lineStates(this.analysis, key, { hotThreshold: hotThreshold() });
    const showCounts = settings().get('executionHighlight.showCounts') !== false;
    const showDebug = settings().get('executionHighlight.showDebugOutput') !== false;
    const groups = { executed: [], exception: [], hot: [] };
    const muted = new vscode.ThemeColor('editorCodeLens.foreground');
    for (const [line, info] of states) {
      if (line > document.lineCount) {
        continue;
      }
      const end = document.lineAt(line - 1).range.end;
      let label = '';
      if (info.state === 'exception') {
        const exception = this.analysis.exceptions[info.data.exceptions[info.data.exceptions.length - 1]];
        label = `  ✖ ${exception.type.split('.').pop()}${exception.status === 'unhandled' ? ' (unhandled)' : ''}`;
      } else if (showCounts && info.count > 1) {
        label = `  ×${info.count.toLocaleString()}`;
      }
      if (info.data.resumes.length && showCounts) {
        label += '  ↩ resumed here';
      }
      if (showDebug && info.data.debug.length && info.state !== 'exception') {
        const last = info.data.debug[info.data.debug.length - 1];
        const text = String(last.text).split('\n')[0];
        label += `  ⟶ ${text.length > 120 ? `${text.slice(0, 120)}…` : text}${info.data.debug.length > 1 ? ` (+${info.data.debug.length - 1})` : ''}`;
      }
      groups[info.state].push({
        range: new vscode.Range(end, end),
        renderOptions: label ? { after: { contentText: label, color: info.state === 'exception' ? new vscode.ThemeColor('errorForeground') : muted, fontStyle: 'italic', margin: '0 0 0 1.5em' } } : undefined
      });
    }
    const inferredMap = this.inferredFor(document, key);
    // A line holding only `}` is never in the log; it ran when its block did.
    for (const line of this.bracesFor(document, key, states, inferredMap)) {
      if (states.has(line) || line > document.lineCount) {
        continue;
      }
      const end = document.lineAt(line - 1).range.end;
      groups.executed.push({ range: new vscode.Range(end, end) });
    }
    editor.setDecorations(this.types.executed, groups.executed);
    editor.setDecorations(this.types.exception, groups.exception);
    editor.setDecorations(this.types.hot, groups.hot);
    const inferred = [...inferredMap.keys()].filter((line) => line <= document.lineCount).map((line) => new vscode.Range(line - 1, 0, line - 1, 0));
    editor.setDecorations(this.types.inferred, inferred);
    this.applyReplay(editor, key);
  }

  applyReplay(editor, key) {
    const step = this.replayIndex >= 0 && this.analysis && this.analysis.steps[this.replayIndex];
    if (!step || step.file !== key || !step.line || step.line > editor.document.lineCount) {
      editor.setDecorations(this.types.replay, []);
      return;
    }
    const end = editor.document.lineAt(step.line - 1).range.end;
    editor.setDecorations(this.types.replay, [
      {
        range: new vscode.Range(end, end),
        renderOptions: {
          after: {
            contentText: `  ▶ step ${(this.replayIndex + 1).toLocaleString()} of ${this.analysis.steps.length.toLocaleString()}${step.kind !== 'statement' && step.text ? ` · ${step.text.split('\n')[0].slice(0, 90)}` : ''}`,
            color: new vscode.ThemeColor('editorInfo.foreground'),
            fontWeight: '600',
            margin: '0 0 0 1.5em'
          }
        }
      }
    ]);
  }

  // Does the open file still look like the code that wrote the log?
  sourceCheck(document, key) {
    const id = `${document.uri.toString()}|${document.version}`;
    if (!this.verified.has(id)) {
      const outcome = verifySource(this.analysis, key, (line) => (line <= document.lineCount ? document.lineAt(line - 1).text : ''), document.lineCount);
      // Saved after the log was recorded: lines may have moved even if the check passed.
      let savedAfter = false;
      try {
        const recorded = this.selected && this.selected.start ? new Date(String(this.selected.start).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime() : NaN;
        savedAfter = !Number.isNaN(recorded) && fs.statSync(document.uri.fsPath).mtimeMs > recorded;
      } catch (error) {
        savedAfter = false;
      }
      outcome.savedAfter = savedAfter;
      outcome.dirty = document.isDirty;
      this.verified.set(id, outcome);
    }
    return this.verified.get(id);
  }

  updateStatus() {
    const editor = vscode.window.activeTextEditor;
    if (!this.highlightOn || !this.analysis) {
      this.status.hide();
      return;
    }
    const key = editor && keyOfDocument(editor.document);
    const file = key && this.analysis.files.get(key);
    this.status.command = 'salesgrid.debugLogs.focus';
    if (!file) {
      this.status.text = '$(pulse) Sales Grid log';
      this.status.tooltip = `${this.selected.title || 'Debug log'}: nothing recorded for ${editor ? path.basename(editor.document.uri.fsPath) : 'this editor'}. Open a class or trigger it ran.`;
      this.status.backgroundColor = undefined;
      this.status.show();
      return;
    }
    const ran = file.lines.size;
    const check = this.sourceCheck(editor.document, key);
    const warn = check.mismatched || check.beyondEnd;
    this.status.text = `$(pulse) ${ran} line${ran === 1 ? '' : 's'} ran${file.exceptions ? ` · $(error) ${file.exceptions}` : ''}${warn ? ' · $(warning) changed?' : ''}`;
    this.status.tooltip = new vscode.MarkdownString(
      [
        `**${md(this.selected.title || 'Debug log')}**${this.selected.org ? ` · ${md(this.selected.org)}` : ''}`,
        `${ran} recorded line(s) in ${md(file.name)}${file.exceptions ? `, ${file.exceptions} exception(s)` : ''}.`,
        warn ? `$(warning) This file may have changed since the log was recorded: ${md(check.samples.join('; ') || `${check.beyondEnd} recorded line(s) are past the end of the file`)}.` : '',
        ...this.analysis.notes.map((note) => `$(info) ${md(note)}`),
        'Click to open the Debug Logs view.'
      ]
        .filter(Boolean)
        .join('\n\n'),
      true
    );
    this.status.backgroundColor = warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.status.show();
  }

  // ---------- hover ----------

  provideHover(document, position) {
    if (!this.highlightOn || !this.analysis) {
      return undefined;
    }
    const key = keyOfDocument(document);
    const file = key && this.analysis.files.get(key);
    const data = file && file.lines.get(position.line + 1);
    if (!data) {
      const guess = file && this.inferredFor(document, key).get(position.line + 1);
      if (!guess) {
        return undefined;
      }
      const why = guess.calls ? `it calls ${guess.calls}(), which the log shows running` : `it lies between recorded lines ${guess.from} and ${guess.to}, with no branch in between`;
      return new vscode.Hover(new vscode.MarkdownString(`Not in the log; most likely ran: ${why}.`), document.lineAt(position.line).range);
    }
    const markdown = new vscode.MarkdownString(this.describeLine(document, key, file, data), true);
    markdown.isTrusted = { enabledCommands: HOVER_COMMANDS };
    markdown.supportHtml = false;
    return new vscode.Hover(markdown, document.lineAt(position.line).range);
  }

  // Only what happened on this line, each with the time the log recorded it.
  describeLine(document, key, file, data) {
    const a = this.analysis;
    const when = (at) => (at ? `\`${at}\` ` : '');
    const parts = [];
    for (const index of data.exceptions.slice(-3)) {
      const ex = a.exceptions[index];
      parts.push(`${when(ex.time)}$(error) **${md(ex.type)}**: ${code(ex.message.replace(/^[\w.]+:\s*/, ''), 300)}  \n${md(exceptionStatus(ex))}`);
    }
    for (const index of data.resumes.slice(0, 2)) {
      parts.push(`↩ Resumed here after ${code(a.exceptions[index].type)}`);
    }
    for (const d of data.debug.slice(0, 10)) {
      parts.push(`${when(d.time)}${md(d.level)} · ${code(d.text, 300)}`);
    }
    if (data.debug.length > 10) {
      parts.push(`… ${data.debug.length - 10} more debug lines`);
    }
    for (const q of data.soql.slice(0, 5)) {
      parts.push(`${when(q.time)}SOQL · ${code(q.text, 250)}${q.rows !== undefined ? ` · ${q.rows} row${q.rows === 1 ? '' : 's'}` : ''}${q.ms !== undefined ? ` · ${q.ms} ms` : ''}`);
    }
    for (const d of data.dml.slice(0, 5)) {
      parts.push(`${when(d.time)}DML · ${md(d.op)} ${md(d.object)}${d.rows !== undefined ? ` · ${d.rows} row${d.rows === 1 ? '' : 's'}` : ''}`);
    }
    for (const v of data.vars.slice(0, 6)) {
      parts.push(`${code(v.name, 40)} = ${code(v.value, 150)}`);
    }
    if (!parts.length) {
      const count = lineCount(data);
      const first = data.steps.length ? a.steps[data.steps[0]].time : undefined;
      parts.push(`${when(first)}Ran${count > 1 ? ` ${count.toLocaleString()} times` : ''}`);
    }
    return parts.join('  \n');
  }

  // Lines between recorded ones that almost certainly ran (logs below FINER).
  inferredFor(document, key) {
    const id = `${document.uri.toString()}|${document.version}|${this.analysis && this.analysis.file}`;
    if (!this.inferredCache || this.inferredCache.id !== id) {
      const map = this.analysis && settings().get('executionHighlight.inferLines') !== false
        ? inferredLines(this.analysis, key, (line) => (line <= document.lineCount ? document.lineAt(line - 1).text : ''), document.lineCount)
        : new Map();
      this.inferredCache = { id, map };
    }
    return this.inferredCache.map;
  }

  bracesFor(document, key, states, inferred) {
    const id = `${document.uri.toString()}|${document.version}|${this.analysis && this.analysis.file}|${inferred.size}`;
    if (!this.bracesCache || this.bracesCache.id !== id) {
      const lines = [];
      for (let i = 0; i < document.lineCount; i++) {
        lines.push(document.lineAt(i).text);
      }
      const ran = new Set([...states.keys(), ...inferred.keys()]);
      const failed = new Set([...states].filter(([, s]) => s.state === 'exception').map(([n]) => n));
      abortedLines(this.analysis, key).forEach((n) => failed.add(n));
      this.bracesCache = { id, set: closingBraceLines(lines, ran, failed) };
    }
    return this.bracesCache.set;
  }

  async inspectLine(key, line) {
    const a = this.analysis;
    const data = a && a.files.get(key) && a.files.get(key).lines.get(line);
    if (!data) {
      return;
    }
    const items = data.steps.map((index) => {
      const step = a.steps[index];
      // The events that belong to this execution of the line.
      const related = [];
      for (let i = index; i < Math.min(a.steps.length, index + 12); i++) {
        const next = a.steps[i];
        if (i > index && (next.file !== step.file || next.line !== step.line || next.kind === 'statement')) {
          break;
        }
        if (next.text) {
          related.push(next.text.split('\n')[0]);
        }
        if (next.vars) {
          related.push(...next.vars);
        }
      }
      return {
        label: `$(debug-stackframe) Step ${(index + 1).toLocaleString()}`,
        description: `+${step.ms} ms · ${step.frame}`,
        detail: related.join(' · ') || (step.resumeOf !== undefined ? 'Execution resumed here after an exception' : 'Statement executed'),
        index
      };
    });
    const more = data.stepTotal > data.steps.length ? ` (first ${data.steps.length} of ${data.stepTotal.toLocaleString()})` : '';
    const picked = await vscode.window.showQuickPick(items, { title: `Line ${line}: recorded executions${more}`, placeHolder: 'Pick one to replay from there', matchOnDescription: true, matchOnDetail: true });
    if (picked) {
      await this.goToStep(picked.index);
    }
  }

  // ---------- replay ----------

  async startReplay(fromException) {
    if (!(await this.load())) {
      return;
    }
    const steps = this.analysis.steps;
    if (!steps.length) {
      vscode.window.showInformationMessage('Sales Grid: this log has no Apex steps to replay.');
      return;
    }
    let start = 0;
    if (fromException) {
      start = steps.findIndex((step) => step.kind === 'exception');
    }
    await this.goToStep(start < 0 ? 0 : start);
  }

  stopReplay() {
    if (this.replayIndex < 0) {
      return;
    }
    this.replayIndex = -1;
    setContext('salesgrid.replayActive', false);
    this.replayStatus.hide();
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.types.replay, []);
    }
  }

  async goToStep(index) {
    if (!(await this.load())) {
      return;
    }
    const steps = this.analysis.steps;
    const target = Math.max(0, Math.min(steps.length - 1, index));
    if (!this.highlightOn) {
      await this.setHighlight(true);
      if (!this.highlightOn) {
        return;
      }
    }
    this.replayIndex = target;
    setContext('salesgrid.replayActive', true);
    const step = steps[target];
    const uri = step.file && (await this.uriFor(step.file));
    let note = '';
    if (uri) {
      const document = await vscode.workspace.openTextDocument(uri);
      const line = Math.max(0, Math.min(document.lineCount - 1, (step.line || 1) - 1));
      const editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus: false });
      const range = new vscode.Range(line, 0, line, 0);
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } else if (step.file) {
      note = ' (file not in this workspace)';
    }
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyReplay(editor, keyOfDocument(editor.document));
    }
    const icon = { exception: '$(error)', fatal: '$(error)', call: '$(debug-step-into)', unit: '$(symbol-event)', soql: '$(database)', dml: '$(edit)', debug: '$(output)' }[step.kind] || '$(debug-step-over)';
    const where = step.file ? `${(this.analysis.files.get(step.file) || {}).name || ''}${step.line ? `:${step.line}` : ''}` : '';
    this.replayStatus.text = `${icon} Step ${(target + 1).toLocaleString()}/${steps.length.toLocaleString()} ${where}${note}`;
    this.replayStatus.tooltip = new vscode.MarkdownString(
      [
        `**Replay of recorded log events** (not a live debugger)`,
        `${md(step.frame || '')}`,
        step.text ? code(step.text, 400) : 'Statement executed',
        step.resumeOf !== undefined ? `$(debug-step-back) Execution resumed here after ${md(this.analysis.exceptions[step.resumeOf].type)} (likely a catch block; inferred)` : '',
        step.vars ? `Variables: ${step.vars.map((v) => code(v, 80)).join(', ')}` : '',
        `Log line ${step.at}. Click for replay controls.`
      ]
        .filter(Boolean)
        .join('\n\n'),
      true
    );
    this.replayStatus.show();
  }

  async stepBy(delta) {
    if (this.replayIndex < 0) {
      return this.startReplay(false);
    }
    return this.goToStep(this.replayIndex + delta);
  }

  async jumpTo(kinds, forward) {
    if (!(await this.load())) {
      return;
    }
    const steps = this.analysis.steps;
    const from = this.replayIndex;
    if (forward) {
      for (let i = from + 1; i < steps.length; i++) {
        if (kinds.includes(steps[i].kind)) {
          return this.goToStep(i);
        }
      }
    } else {
      for (let i = from - 1; i >= 0; i--) {
        if (kinds.includes(steps[i].kind)) {
          return this.goToStep(i);
        }
      }
    }
    vscode.window.setStatusBarMessage(`Sales Grid: no more ${kinds.includes('exception') ? 'exceptions' : 'steps of that kind'} ${forward ? 'after' : 'before'} this step.`, 3000);
    return undefined;
  }

  // Next step that is in a different file or method: a quick way through long loops.
  async stepOut(forward) {
    const steps = this.analysis && this.analysis.steps;
    if (!steps || this.replayIndex < 0) {
      return this.startReplay(false);
    }
    const current = steps[this.replayIndex];
    const dir = forward ? 1 : -1;
    for (let i = this.replayIndex + dir; i >= 0 && i < steps.length; i += dir) {
      if (steps[i].frame !== current.frame || steps[i].kind === 'exception') {
        return this.goToStep(i);
      }
    }
    return undefined;
  }

  async replayMenu() {
    const items = [
      { label: '$(arrow-right) Next step', run: () => this.stepBy(1) },
      { label: '$(arrow-left) Previous step', run: () => this.stepBy(-1) },
      { label: '$(debug-step-out) Next method or file', run: () => this.stepOut(true) },
      { label: '$(debug-step-back) Previous method or file', run: () => this.stepOut(false) },
      { label: '$(error) Next exception', run: () => this.jumpTo(['exception', 'fatal'], true) },
      { label: '$(error) Previous exception', run: () => this.jumpTo(['exception', 'fatal'], false) },
      { label: '$(debug-step-into) Next method call', run: () => this.jumpTo(['call', 'unit'], true) },
      { label: '$(database) Next query or DML', run: () => this.jumpTo(['soql', 'dml'], true) },
      { label: '$(go-to-file) Show this step in the log', run: () => this.showLogLine(this.analysis.steps[this.replayIndex].at) },
      { label: '$(debug-restart) Back to the first step', run: () => this.goToStep(0) },
      { label: '$(debug-stop) Stop replay', run: () => this.stopReplay() }
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'Sales Grid replay' });
    if (picked) {
      await picked.run();
    }
  }

  async showLogLine(at) {
    if (!this.analysis) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(this.analysis.file);
    const line = Math.max(0, Math.min(document.lineCount - 1, (at || 1) - 1));
    const editor = await vscode.window.showTextDocument(document, { preview: true, viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    const range = new vscode.Range(line, 0, line, document.lineAt(line).text.length);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  // `show`: extra showTextDocument options, e.g. { viewColumn: Beside }.
  async goToLocation(key, line, show = {}) {
    const uri = key && (await this.uriFor(key));
    if (!uri) {
      vscode.window.showInformationMessage(`Sales Grid: ${String(key || '').split(':')[1] || 'that file'} is not in this workspace.`);
      return;
    }
    if (!this.highlightOn) {
      await this.setHighlight(true);
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const target = Math.max(0, Math.min(document.lineCount - 1, (line || 1) - 1));
    const editor = await vscode.window.showTextDocument(document, { preview: true, ...show });
    this.apply(editor);
    const range = new vscode.Range(target, 0, target, 0);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return editor;
  }

  // Opens where the log matters most: the first exception, else the first file it ran.
  async revealMain(show) {
    const a = this.analysis;
    if (!a) {
      return;
    }
    const exception = a.exceptions.find((ex) => ex.file && ex.line);
    if (exception && (await this.uriFor(exception.file))) {
      return this.goToLocation(exception.file, exception.line, show);
    }
    const ordered = [...a.files.values()].filter((f) => f.lines.size).sort((x, y) => (x.firstStep < 0 ? Infinity : x.firstStep) - (y.firstStep < 0 ? Infinity : y.firstStep));
    for (const file of ordered) {
      if (await this.uriFor(file.key)) {
        return this.goToLocation(file.key, Math.min(...file.lines.keys()), show);
      }
    }
    // Nothing to colour. Say why, and still open a class the log ran when we have it.
    const ran = [...a.files.values()];
    for (const file of ran) {
      if (await this.uriFor(file.key)) {
        const editor = await this.goToLocation(file.key, 1, show);
        vscode.window.showInformationMessage(`Sales Grid: this log ran ${file.name} but recorded no line in it. ${a.statementLevel ? '' : `Apex Code was logged at ${a.apexLevel || 'a low level'}, which records only queries, DML, debug output and exceptions; use the Sales Grid debug level (FINER) to see every line.`}`.trim());
        return editor;
      }
    }
    if (!ran.length && a.units.some((u) => /execute_anonymous_apex/i.test(u.label))) {
      vscode.window.showInformationMessage('Sales Grid: this log is anonymous Apex only, so there is no class or trigger to highlight. If it started a job (a Queueable, batch or future method), pick that job\'s own log.');
      return;
    }
    const names = [...new Set([...ran.map((f) => f.name), ...a.units.filter((u) => !u.file).map((u) => u.label)])].filter(Boolean);
    vscode.window.showInformationMessage(names.length ? `Sales Grid: ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not in this workspace.` : 'Sales Grid: this log names no class or trigger to highlight.');
    return undefined;
  }

  // ---------- performance summary ----------

  async showPerformance() {
    const a = await this.load();
    if (!a) {
      return;
    }
    const s = a.summary;
    const lim = s.limits || {};
    const limitRow = (label, value) => (value ? `| ${label} | ${value.used.toLocaleString()} | ${value.max.toLocaleString()} | ${Math.round((value.used / value.max) * 100)}% |` : '');
    const confirmed = a.findings.filter((f) => f.confirmed);
    const inferred = a.findings.filter((f) => !f.confirmed);
    const methods = [...a.methods.values()].sort((x, y) => y.ns - x.ns).slice(0, 15);
    const text = [
      `# Performance: ${this.selected.title || 'Debug log'}`,
      '',
      `${this.selected.org ? `Org: ${this.selected.org} · ` : ''}Duration ${s.durationMs.toLocaleString()} ms · ${a.steps.length.toLocaleString()} recorded steps · Apex Code level ${a.apexLevel || 'unknown'}`,
      '',
      ...a.notes.map((n) => `> ${n}`),
      '',
      '## Governor limits (from the log)',
      '',
      '| Limit | Used | Max | Use |',
      '| --- | ---: | ---: | ---: |',
      limitRow('SOQL queries', lim.soql),
      limitRow('Query rows', lim.queryRows),
      limitRow('DML statements', lim.dml),
      limitRow('DML rows', lim.dmlRows),
      limitRow('CPU time (ms)', lim.cpu),
      limitRow('Heap (bytes)', lim.heap),
      limitRow('Callouts', lim.callouts),
      Object.keys(lim).length ? '' : '_The log has no limit summary (it needs Apex Profiling at INFO or more)._',
      '',
      '## Confirmed in the log',
      '',
      ...(confirmed.length ? confirmed.map((f) => `- ${f.text}`) : ['- Nothing notable.']),
      ...a.exceptions.map((ex) => `- ${ex.type} at ${ex.fileName || 'unknown'} line ${ex.line || '?'}: ${exceptionStatus(ex)}`),
      '',
      '## Likely causes to check (inferred)',
      '',
      ...(inferred.length ? inferred.map((f) => `- ${f.text}`) : ['- None.']),
      '',
      '## Methods by time',
      '',
      '| Method | Calls | Total ms |',
      '| --- | ---: | ---: |',
      ...methods.map((m) => `| ${m.label.replace(/\|/g, '\\|')} | ${m.calls.toLocaleString()} | ${(m.ns / 1e6).toFixed(1)} |`),
      '',
      '_Counts come from the events in this log. A debug log never proves full code coverage: lines that are not recorded may still have run._'
    ]
      .filter((line) => line !== null)
      .join('\n');
    const document = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
    await vscode.commands.executeCommand('markdown.showPreview', document.uri).then(undefined, () => vscode.window.showTextDocument(document));
  }
}

// ---------- the Debug Logs sidebar ----------

function item(label, options = {}) {
  const node = new vscode.TreeItem(label, options.collapsible || vscode.TreeItemCollapsibleState.None);
  Object.assign(node, options.props || {});
  if (options.icon) {
    node.iconPath = typeof options.icon === 'string' ? new vscode.ThemeIcon(options.icon) : options.icon;
  }
  node.description = options.description;
  node.tooltip = options.tooltip;
  node.command = options.command;
  node.contextValue = options.context;
  return node;
}

const icon = (name, colour) => new vscode.ThemeIcon(name, colour ? new vscode.ThemeColor(colour) : undefined);

class DebugLogsView {
  constructor(insight) {
    this.insight = insight;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.logs = new Map(); // org -> { items, at, error }
    this.debugging = new Map(); // org -> { flags, me, at, error }
    this.loading = new Map();
    this.view = undefined;
    insight.onDidChange(() => this.refresh());
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  // Asks the org again; `quiet` keeps the tree as it is unless something changed.
  async reload(quiet) {
    const org = await this.insight.fileOrg();
    if (!org) {
      this.refresh();
      return;
    }
    const before = JSON.stringify([this.logs.get(org.username), this.debugging.get(org.username)].map((x) => x && (x.items || x.flags || []).map((y) => `${y.id}|${y.expires || ''}`)));
    await Promise.all([this.fetchLogs(org.username), this.fetchDebugging(org.username)]);
    const after = JSON.stringify([this.logs.get(org.username), this.debugging.get(org.username)].map((x) => x && (x.items || x.flags || []).map((y) => `${y.id}|${y.expires || ''}`)));
    if (!quiet || before !== after) {
      this.refresh();
    }
  }

  async fetchLogs(org) {
    try {
      const items = await this.insight.debugger.listLogs(org, LOG_LIST_SIZE);
      this.logs.set(org, { items, at: Date.now() });
    } catch (error) {
      this.logs.set(org, { items: (this.logs.get(org) || {}).items || [], at: Date.now(), error: error.message });
    }
  }

  async fetchDebugging(org) {
    try {
      const state = await this.insight.debugger.activeDebugging(org);
      this.debugging.set(org, { ...state, at: Date.now() });
    } catch (error) {
      this.debugging.set(org, { flags: [], at: Date.now(), error: error.message });
    }
  }

  // The view's own progress bar runs while the org is being asked.
  async ensure(org) {
    if (this.logs.has(org) && this.debugging.has(org)) {
      return;
    }
    if (!this.loading.has(org)) {
      const work = Promise.all([this.logs.has(org) ? undefined : this.fetchLogs(org), this.debugging.has(org) ? undefined : this.fetchDebugging(org)]);
      this.loading.set(org, vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Sales Grid: debug logs' }, () => work).finally(() => this.loading.delete(org)));
    }
    await this.loading.get(org);
  }

  getTreeItem(node) {
    return node;
  }

  async getChildren(node) {
    if (!node) {
      return this.roots();
    }
    switch (node.group) {
      case 'selected':
        return this.selectedChildren();
      case 'files':
        return this.fileChildren();
      case 'exceptions':
        return this.exceptionChildren();
      case 'findings':
        return this.findingChildren();
      case 'orgLogs':
        return this.orgLogChildren(node.org);
      case 'downloaded':
        return this.downloadedChildren();
      case 'debugging':
        return this.debuggingChildren(node.org);
      default:
        return [];
    }
  }

  async roots() {
    const org = await this.insight.fileOrg();
    const roots = [];
    if (!org) {
      roots.push(item('Choose an org', { icon: 'cloud', description: 'no default org for this project', command: { command: 'salesgrid.selectFileOrg', title: 'Choose an Org' } }));
    } else {
      await this.ensure(org.username);
      roots.push(...this.debuggingRows(org));
    }
    const selected = this.insight.selected;
    if (selected) {
      const a = this.insight.analysis;
      roots.push(
        item(selected.title || 'Debug log', {
          icon: a && a.exceptions.length ? icon('error', 'errorForeground') : icon('eye', 'charts.green'),
          description: `in use${selected.start ? ` · ${when(selected.start)}` : ''}${selected.org ? ` · ${selected.org}` : ' · org unknown'}`,
          tooltip: 'The log used to highlight your code. Expand it for the code it ran, exceptions and performance.',
          collapsible: vscode.TreeItemCollapsibleState.Expanded,
          context: 'sgSelected',
          props: { group: 'selected' }
        })
      );
    }
    if (org) {
      roots.push(
        item(`Logs in ${org.alias || org.username}`, {
          icon: 'list-unordered',
          collapsible: selected ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
          context: 'sgOrgLogs',
          props: { group: 'orgLogs', org: org.username },
          description: this.logs.get(org.username) ? `${this.logs.get(org.username).items.length}` : ''
        })
      );
    }
    roots.push(item('Downloaded logs', { icon: 'folder', collapsible: vscode.TreeItemCollapsibleState.Collapsed, props: { group: 'downloaded' } }));
    return roots;
  }

  debuggingRows(org) {
    const state = this.debugging.get(org.username) || { flags: [] };
    if (state.error) {
      return [item('Could not read debug logging', { icon: icon('warning', 'list.warningForeground'), description: state.error, tooltip: state.error, command: { command: 'salesgrid.debugLogs.refresh', title: 'Retry' } })];
    }
    const mine = state.flags.find((flag) => flag.mine && flag.salesGrid) || state.flags.find((flag) => flag.mine);
    const others = state.flags.filter((flag) => !flag.mine);
    const rows = [];
    if (mine) {
      rows.push(
        item(mine.salesGrid ? 'Debugging on' : `Debug logging on (${mine.level})`, {
          icon: icon('record', 'charts.green'),
          description: `you · ${minutesLeft(mine.expires)}`,
          tooltip: mine.salesGrid ? `Logs every Apex statement you run, at the Sales Grid level. ${minutesLeft(mine.expires)}.` : `Logging uses the ${mine.level} level. Click to switch to the Sales Grid level, which records every statement for highlighting.`,
          context: mine.salesGrid ? 'sgDebugOn' : 'sgDebugOther',
          command: mine.salesGrid ? undefined : { command: 'salesgrid.debug.enable', title: 'Enable Debugging' }
        })
      );
    } else {
      rows.push(
        item('Debugging off', {
          icon: icon('circle-outline'),
          description: 'click to start',
          tooltip: 'Start debug logging with the Sales Grid debug level (Apex Code FINER), so every statement you run is recorded.',
          context: 'sgDebugOff',
          command: { command: 'salesgrid.debug.enable', title: 'Enable Debugging' }
        })
      );
    }
    if (others.length) {
      rows.push(
        item(`${others.length} other user${others.length === 1 ? '' : 's'} being logged`, {
          icon: 'person',
          collapsible: vscode.TreeItemCollapsibleState.Collapsed,
          tooltip: 'Trace flags that are recording right now, started by anyone, anywhere (including Setup). Checked every minute while this view is open.',
          props: { group: 'debugging', org: org.username }
        })
      );
    }
    return rows;
  }

  debuggingChildren(org) {
    const state = this.debugging.get(org) || { flags: [] };
    return state.flags
      .filter((flag) => !flag.mine)
      .map((flag) =>
        item(flag.entity, {
          icon: icon('record', flag.salesGrid ? 'charts.green' : 'charts.blue'),
          description: `${flag.level} · ${minutesLeft(flag.expires)}`,
          tooltip: `${flag.logType.replace('_', ' ').toLowerCase()} trace flag, level ${flag.level}, expires ${when(flag.expires)}.`,
          context: flag.salesGrid ? 'sgDebugOnOther' : undefined,
          props: { flag }
        })
      );
  }

  async selectedChildren() {
    const insight = this.insight;
    const a = await insight.load();
    if (!a) {
      return [item('Could not read this log', { icon: icon('warning', 'list.warningForeground') })];
    }
    const rows = [];
    rows.push(
      insight.highlightOn
        ? item('Highlighting on', { icon: icon('eye', 'charts.green'), description: 'click to turn off', command: { command: 'salesgrid.clearHighlight', title: 'Turn Off' } })
        : item('Highlight in code', { icon: 'eye', description: 'open the code it ran', command: { command: 'salesgrid.highlightAndReveal', title: 'Highlight' } })
    );
    rows.push(item('Replay execution', { icon: 'debug-start', description: `${a.steps.length.toLocaleString()} steps`, command: { command: 'salesgrid.replay.start', title: 'Replay' }, tooltip: 'Step through the recorded events, forwards and backwards. This replays the log; it is not a live debugger.' }));
    rows.push(item('Code that ran', { icon: 'files', description: `${[...a.files.values()].filter((f) => f.lines.size).length}`, collapsible: vscode.TreeItemCollapsibleState.Expanded, props: { group: 'files' } }));
    if (a.exceptions.length) {
      rows.push(item('Exceptions', { icon: icon('error', 'errorForeground'), description: `${a.exceptions.length}`, collapsible: vscode.TreeItemCollapsibleState.Expanded, props: { group: 'exceptions' } }));
    }
    rows.push(item('Performance', { icon: 'dashboard', description: a.findings.length ? `${a.findings.length} finding${a.findings.length === 1 ? '' : 's'}` : 'nothing notable', collapsible: vscode.TreeItemCollapsibleState.Collapsed, props: { group: 'findings' } }));
    for (const note of a.notes) {
      rows.push(item(note.split('.')[0], { icon: icon('warning', 'list.warningForeground'), tooltip: note }));
    }
    return rows;
  }

  async fileChildren() {
    const a = this.insight.analysis;
    if (!a) {
      return [];
    }
    const index = await this.insight.index();
    return [...a.files.values()]
      .filter((file) => file.lines.size)
      .sort((x, y) => (x.firstStep < 0 ? Infinity : x.firstStep) - (y.firstStep < 0 ? Infinity : y.firstStep))
      .map((file) => {
        const local = index.has(file.key);
        const first = Math.min(...file.lines.keys());
        return item(file.name, {
          icon: icon(file.kind === 'trigger' ? 'zap' : 'symbol-class', file.exceptions ? 'errorForeground' : undefined),
          description: `${file.kind} · ${file.lines.size} line${file.lines.size === 1 ? '' : 's'}${file.exceptions ? ` · ${file.exceptions} exception${file.exceptions === 1 ? '' : 's'}` : ''}${local ? '' : ' · not in workspace'}`,
          tooltip: `${[...file.methods].slice(0, 12).join('\n')}${file.methods.size > 12 ? '\n…' : ''}`,
          command: local ? { command: 'salesgrid.goToLocation', title: 'Open', arguments: [file.key, first] } : undefined
        });
      });
  }

  exceptionChildren() {
    const a = this.insight.analysis;
    return (a ? a.exceptions : []).map((ex) =>
      item(ex.type.split('.').pop(), {
        icon: icon(ex.status === 'unhandled' ? 'error' : 'warning', ex.status === 'unhandled' ? 'errorForeground' : 'list.warningForeground'),
        description: `${ex.fileName || '?'} line ${ex.line || '?'} · ${ex.status === 'unhandled' ? 'unhandled' : ex.status === 'continued' ? 'handled' : ex.status === 'leftUnit' ? 'left the trigger' : 'rethrown'}`,
        tooltip: `${ex.message}\n\n${exceptionStatus(ex)}${ex.resumedAt ? `\nContinued at ${ex.resumedAt.fileName} line ${ex.resumedAt.line}` : ''}`,
        command: ex.file ? { command: 'salesgrid.goToLocation', title: 'Go to Exception', arguments: [ex.file, ex.line] } : undefined
      })
    );
  }

  findingChildren() {
    const a = this.insight.analysis;
    const rows = (a ? a.findings : []).map((f) =>
      item(f.text, {
        icon: icon(f.severity === 'error' ? 'error' : f.severity === 'warning' ? 'warning' : 'info', f.severity === 'error' ? 'errorForeground' : f.severity === 'warning' ? 'list.warningForeground' : undefined),
        description: f.confirmed ? 'confirmed' : 'inferred',
        tooltip: `${f.text}\n\n${f.confirmed ? 'Read directly from the log.' : 'A likely cause worked out from the log; check the code.'}`,
        command: f.file && f.line ? { command: 'salesgrid.goToLocation', title: 'Go', arguments: [f.file, f.line] } : undefined
      })
    );
    rows.push(item('Full performance summary', { icon: 'graph', command: { command: 'salesgrid.showPerformance', title: 'Performance Summary' } }));
    return rows;
  }

  async orgLogChildren(org) {
    await this.ensure(org);
    const state = this.logs.get(org) || { items: [] };
    if (state.error && !state.items.length) {
      return [item('Could not list logs', { icon: icon('warning', 'list.warningForeground'), description: state.error, tooltip: state.error })];
    }
    if (!state.items.length) {
      return [item('No debug logs yet', { icon: 'info', description: 'start debugging, then run your code' })];
    }
    const selected = this.insight.selected;
    return state.items.map((log) => {
      const failed = !/^success$/i.test(log.status);
      const inUse = selected && selected.id === log.id;
      return item(log.operation || log.request || 'Log', {
        icon: inUse ? icon('eye', 'charts.green') : failed ? icon('error', 'errorForeground') : icon('pass', 'charts.green'),
        description: `${when(log.start)} · ${log.user} · ${size(log.bytes)}${inUse ? ' · in use' : ''}`,
        tooltip: new vscode.MarkdownString(`**${md(log.operation)}**  \n${md(log.user)} · ${md(when(log.start))}  \nStatus: ${md(log.status)}  \n${log.durationMs} ms · ${size(log.bytes)}  \n\nClick to use this log for highlighting.`),
        context: 'sgLog',
        command: { command: 'salesgrid.debugLogs.select', title: 'Use Log', arguments: [{ org, log }] },
        props: { org, log }
      });
    });
  }

  async downloadedChildren() {
    const folder = logFolder(this.insight.context);
    let files = [];
    try {
      const names = (await fs.promises.readdir(folder)).filter((name) => name.endsWith('.log'));
      files = await Promise.all(names.map(async (name) => ({ name, stat: await fs.promises.stat(path.join(folder, name)) })));
    } catch (error) {
      files = [];
    }
    files.sort((x, y) => y.stat.mtimeMs - x.stat.mtimeMs);
    const rows = files.slice(0, 30).map(({ name, stat }) => {
      const file = path.join(folder, name);
      const id = name.replace(/\.log$/, '');
      const org = logOrg(this.insight.context, id);
      return item(id, {
        icon: 'file',
        description: `${when(stat.mtime.toISOString())} · ${size(stat.size)}${org ? ` · ${org}` : ''}`,
        tooltip: file,
        command: { command: 'salesgrid.debugLogs.select', title: 'Use Log', arguments: [{ file, id, org, title: id, start: stat.mtime.toISOString() }] },
        context: 'sgLocalLog',
        props: { file }
      });
    });
    rows.push(item('Open a log file…', { icon: 'folder-opened', command: { command: 'salesgrid.debugLogs.openLocal', title: 'Open Log File' } }));
    return rows;
  }
}

// ---------- commands ----------

async function chooseUser(insight, org) {
  const me = { label: '$(account) Me', description: org, me: true };
  const other = { label: '$(person-add) Another user…', description: 'needs the Manage Users permission' };
  const who = await vscode.window.showQuickPick([me, other], { title: 'Debug whose code?' });
  if (!who) {
    return undefined;
  }
  if (who.me) {
    return { id: undefined, name: 'you' };
  }
  const text = await vscode.window.showInputBox({ title: 'Find a user', prompt: 'Name or username (at least 2 letters)', validateInput: (value) => (value.trim().length < 2 ? 'Type at least 2 letters' : undefined) });
  if (!text) {
    return undefined;
  }
  const users = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Searching users…' }, () => insight.debugger.searchUsers(org, text));
  if (!users.length) {
    vscode.window.showInformationMessage(`Sales Grid: no active user matches "${text}".`);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    users.map((user) => ({ label: user.name, description: user.username, detail: user.profile, user })),
    { title: 'Debug whose code?', matchOnDescription: true }
  );
  return picked && { id: picked.user.id, name: picked.user.name };
}

async function enableDebugging(insight, view) {
  const org = (await insight.fileOrg()) || (await insight.selectFileOrg());
  if (!org) {
    return;
  }
  const name = org.alias || org.username;
  try {
    const who = await chooseUser(insight, org.username);
    if (!who) {
      return;
    }
    const detail = await vscode.window.showQuickPick(
      [
        { label: 'FINER', description: 'recommended', detail: 'Every statement, method call, query, DML and exception. Enough to highlight the code that ran.', value: 'FINER' },
        { label: 'FINEST', description: 'larger logs', detail: 'Everything above plus variable values, shown on hover.', value: 'FINEST' }
      ],
      { title: 'Apex detail for the Sales Grid debug level' }
    );
    if (!detail) {
      return;
    }
    const duration = await vscode.window.showQuickPick(
      [
        { label: '30 minutes', value: 30 },
        { label: '1 hour', value: 60, picked: true },
        { label: '2 hours', value: 120 },
        { label: '4 hours', value: 240 },
        { label: '8 hours', value: 480 },
        { label: '24 hours', value: 1440, description: 'the most Salesforce allows' }
      ],
      { title: 'Keep debugging on for' }
    );
    if (!duration) {
      return;
    }
    const confirmChange = async ({ existing, wanted, differences }) => {
      const lines = differences.map((c) => `${c}: ${existing[c] || 'NONE'} → ${wanted[c]}`).join('\n');
      const choice = await vscode.window.showWarningMessage(
        `The "Sales Grid" debug level in ${name} has different settings.`,
        { modal: true, detail: `Change it to the settings Sales Grid needs?\n\n${lines}\n\n"Use As It Is" keeps your settings; highlighting may then show less.` },
        'Update It',
        'Use As It Is'
      );
      return choice === 'Update It' ? 'update' : choice === 'Use As It Is' ? 'keep' : 'cancel';
    };
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Turning on debugging in ${name}…` }, () =>
      insight.debugger.enableSalesGridDebugging(org.username, { targetUserId: who.id, minutes: duration.value, detail: detail.value, confirmChange })
    );
    const level = result.level.created ? 'created the Sales Grid debug level and ' : result.level.updated ? 'updated the Sales Grid debug level and ' : '';
    const message = `Sales Grid: ${level}debugging is on for ${who.name} in ${name} for ${duration.label} (Apex ${result.level.levels.ApexCode}).${result.notes.length ? ` ${result.notes.join(' ')}` : ''}`;
    insight.log(message.replace('Sales Grid: ', ''));
    vscode.window.showInformationMessage(message);
  } catch (error) {
    if (!error.cancelled) {
      insight.log(`FAILED: could not turn on debugging in ${name}. ${error.message}`);
      vscode.window.showErrorMessage(`Sales Grid: could not turn on debugging in ${name}. ${error.message}`);
    }
  }
  await view.reload();
}

async function disableDebugging(insight, view, flagNode) {
  const org = await insight.fileOrg();
  if (!org) {
    return;
  }
  const name = org.alias || org.username;
  try {
    const target = flagNode && flagNode.flag ? flagNode.flag.entityId : undefined;
    const stopped = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Turning off debugging in ${name}…` }, () =>
      insight.debugger.disableSalesGridDebugging(org.username, target)
    );
    const who = flagNode && flagNode.flag ? flagNode.flag.entity : 'you';
    vscode.window.showInformationMessage(stopped ? `Sales Grid: debugging is off for ${who} in ${name}.` : `Sales Grid: no Sales Grid debugging was running for ${who} in ${name}.`);
    insight.log(`Turned off debugging for ${who} in ${name} (${stopped} trace flag(s)).`);
  } catch (error) {
    insight.log(`FAILED: could not turn off debugging in ${name}. ${error.message}`);
    vscode.window.showErrorMessage(`Sales Grid: could not turn off debugging in ${name}. ${error.message}`);
  }
  await view.reload();
}

function register(insight) {
  const view = new DebugLogsView(insight);
  // The Debug Logs panel was removed from the sidebar (the Home page lists
  // logs). The provider stays: commands still use its log list and selection.
  const tree = { id: 'salesgrid.debugLogs', provider: view, dispose: () => view.dispose && view.dispose() };

  const selectLog = async (arg) => {
    if (!arg) {
      return;
    }
    if (arg.log) {
      const log = arg.log;
      await insight.select({ id: log.id, org: arg.org, title: log.operation || log.request || log.id, start: log.start, user: log.user });
    } else if (arg.file) {
      await insight.select({ file: arg.file, id: arg.id, org: arg.org || (arg.id && logOrg(insight.context, arg.id)), title: arg.title || path.basename(arg.file), start: arg.start });
    }
  };

  // A debug log opened in the editor (from the Salesforce extensions, the
  // Explorer or anywhere else) is picked and highlighted, and the class it ran
  // opens beside it.
  const logOpened = async (editor) => {
    const document = editor && editor.document;
    if (!document || document.uri.scheme !== 'file' || !/\.log$/i.test(document.uri.fsPath) || settings().get('executionHighlight.highlightOnLogOpen') === false) {
      return;
    }
    const file = document.uri.fsPath;
    const current = insight.selected && insight.selected.file;
    if ((current && path.resolve(current) === path.resolve(file)) || (insight.analysis && path.resolve(insight.analysis.file) === path.resolve(file))) {
      return;
    }
    // Only Apex debug logs: a version and level header, then timed events.
    if (!/^\d+\.\d+ [A-Z_]+,[A-Z]+/.test(document.lineAt(0).text) && !/\|(EXECUTION_STARTED|CODE_UNIT_STARTED)\b/.test(document.getText(new vscode.Range(0, 0, Math.min(document.lineCount, 20), 0)))) {
      return;
    }
    const base = path.basename(file, path.extname(file));
    const id = /^[a-zA-Z0-9]{15,18}$/.test(base) ? base : undefined;
    const analysis = await insight.select({ file, id, org: id && logOrg(insight.context, id), title: path.basename(file) }, { highlight: true });
    if (analysis && insight.highlightOn) {
      await insight.revealMain({ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    }
  };

  const disposables = [
    tree,
    vscode.window.onDidChangeActiveTextEditor((editor) => logOpened(editor).catch((error) => insight.log(`FAILED: could not highlight the opened log. ${error.message}`))),
    insight,
    vscode.languages.registerHoverProvider([{ scheme: 'file', pattern: '**/*.cls' }, { scheme: 'file', pattern: '**/*.trigger' }], { provideHover: (document, position) => insight.provideHover(document, position) }),
    vscode.window.onDidChangeVisibleTextEditors(() => insight.applyAll()),
    vscode.window.onDidChangeActiveTextEditor(() => insight.updateStatus()),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (insight.highlightOn && keyOfDocument(event.document)) {
        clearTimeout(insight.editTimer);
        insight.editTimer = setTimeout(() => insight.applyAll(), 400);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('salesgrid.executionHighlight') && insight.analysis) {
        insight.analysis.findings = findings(insight.analysis, { hotThreshold: hotThreshold(), limits: insight.analysis.summary.limits });
        insight.applyAll();
        view.refresh();
      }
    }),
    insight.provider.onDidLoad(() => view.refresh()),

    vscode.commands.registerCommand('salesgrid.debug.enable', () => enableDebugging(insight, view)),
    vscode.commands.registerCommand('salesgrid.debug.disable', (node) => disableDebugging(insight, view, node)),
    vscode.commands.registerCommand('salesgrid.debugLogs.refresh', () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Sales Grid: debug logs' }, () => view.reload())
    ),
    vscode.commands.registerCommand('salesgrid.debugLogs.changeOrg', async () => {
      if (await insight.selectFileOrg()) {
        await view.reload();
      }
    }),
    vscode.commands.registerCommand('salesgrid.debugLogs.select', selectLog),
    vscode.commands.registerCommand('salesgrid.debugLogs.highlight', async (node) => {
      await selectLog(node && node.log ? { org: node.org, log: node.log } : node && node.file ? { file: node.file, id: path.basename(node.file, '.log') } : undefined);
      await insight.setHighlight(true);
      await insight.revealMain();
    }),
    vscode.commands.registerCommand('salesgrid.openLogExplorer', (uri) => openLogExplorer(insight, uri)),
    vscode.commands.registerCommand('salesgrid.debugLogs.openExplorer', async (node) => {
      if (node && (node.log || node.file)) {
        await selectLog(node.log ? { org: node.org, log: node.log } : { file: node.file, id: path.basename(node.file, '.log') });
      }
      await openLogExplorer(insight, undefined, true);
    }),
    vscode.commands.registerCommand('salesgrid.debugLogs.openLocal', async () => {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Debug log': ['log', 'txt'], 'All files': ['*'] }, defaultUri: vscode.Uri.file(logFolder(insight.context)), openLabel: 'Use Log' });
      if (picked && picked[0]) {
        const file = picked[0].fsPath;
        const id = /^[a-zA-Z0-9]{15,18}$/.test(path.basename(file, path.extname(file))) ? path.basename(file, path.extname(file)) : undefined;
        await selectLog({ file, id, title: path.basename(file) });
      }
    }),
    vscode.commands.registerCommand('salesgrid.debugLogs.showSummary', async (node) => {
      if (node && node.log && insight.page) {
        await insight.page.showLog(node.org, node.log.id);
      }
    }),
    vscode.commands.registerCommand('salesgrid.debugLogs.openRaw', async (node) => {
      try {
        const file = node && node.file ? node.file : node && node.log ? await downloadLog(insight.context, insight.debugger, node.org, node.log.id) : insight.analysis && insight.analysis.file;
        if (file) {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
          if (await moveToNewWindow()) {
            await maximize();
          }
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Sales Grid: could not open the log. ${error.message}`);
      }
    }),
    // The log in the editor and, beside it, the class it ran with its lines highlighted.
    vscode.commands.registerCommand('salesgrid.debugLogs.openWithClass', async (node) => {
      try {
        const file = node && node.file ? node.file : node && node.log ? await downloadLog(insight.context, insight.debugger, node.org, node.log.id) : insight.analysis && insight.analysis.file;
        if (!file) {
          return;
        }
        const id = node && node.log ? node.log.id : path.basename(file, '.log');
        const log = node && node.log;
        await insight.select({ file, id, org: (node && node.org) || logOrg(insight.context, id), title: log ? log.operation || log.request || id : path.basename(file), start: log && log.start, user: log && log.user }, { highlight: true });
        const logDocument = await vscode.workspace.openTextDocument(file);
        if (!insight.highlightOn) {
          // Highlighting did not start (another org, declined): still show the log.
          await vscode.window.showTextDocument(logDocument, { preview: false });
          return;
        }
        // The log on the left; on the right one page with the code that ran:
        // the trigger first with all its lines, then the classes, the lines that
        // ran highlighted. Both start in one group and the group moves to a new
        // window as a whole, so nothing lands in the main window mid-move.
        if (!wantNewWindow()) {
          await vscode.window.showTextDocument(logDocument, { preview: false, viewColumn: vscode.ViewColumn.One });
          await createPanel(insight, insight.analysis, { coverage: true, viewColumn: vscode.ViewColumn.Beside });
          return;
        }
        const logEditor = await vscode.window.showTextDocument(logDocument, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        const panel = await createPanel(insight, insight.analysis, { coverage: true, viewColumn: logEditor.viewColumn });
        const moved = await moveGroupToNewWindow();
        panel.reveal(undefined, false);
        await vscode.commands.executeCommand('workbench.action.moveEditorToRightGroup');
        if (moved) {
          await maximize();
        }
      } catch (error) {
        insight.log(`FAILED: could not open the log with its class. ${error.message}`);
        vscode.window.showErrorMessage(`Sales Grid: could not open the log with its class. ${error.message}`);
      }
    }),
    vscode.commands.registerCommand('salesgrid.debugLogs.clearSelection', () => insight.clearSelection()),
    vscode.commands.registerCommand('salesgrid.highlightExecution', () => insight.setHighlight(true)),
    vscode.commands.registerCommand('salesgrid.highlightAndReveal', async () => {
      await insight.setHighlight(true);
      if (insight.highlightOn) {
        await insight.revealMain();
      }
    }),
    vscode.commands.registerCommand('salesgrid.clearHighlight', () => insight.setHighlight(false)),
    vscode.commands.registerCommand('salesgrid.inspectLine', (key, line) => insight.inspectLine(key, line)),
    vscode.commands.registerCommand('salesgrid.goToLocation', (key, line) => insight.goToLocation(key, line)),
    vscode.commands.registerCommand('salesgrid.showLogLine', (at) => insight.showLogLine(at)),
    vscode.commands.registerCommand('salesgrid.showPerformance', () => insight.showPerformance()),
    vscode.commands.registerCommand('salesgrid.replay.start', () => insight.startReplay(false)),
    vscode.commands.registerCommand('salesgrid.replay.next', () => insight.stepBy(1)),
    vscode.commands.registerCommand('salesgrid.replay.previous', () => insight.stepBy(-1)),
    vscode.commands.registerCommand('salesgrid.replay.stepOut', () => insight.stepOut(true)),
    vscode.commands.registerCommand('salesgrid.replay.nextException', () => insight.jumpTo(['exception', 'fatal'], true)),
    vscode.commands.registerCommand('salesgrid.replay.previousException', () => insight.jumpTo(['exception', 'fatal'], false)),
    vscode.commands.registerCommand('salesgrid.replay.goto', (index) => insight.goToStep(Number(index) || 0)),
    vscode.commands.registerCommand('salesgrid.replay.menu', () => insight.replayMenu()),
    vscode.commands.registerCommand('salesgrid.replay.stop', () => insight.stopReplay())
  ];
  return { view, disposables };
}

module.exports = { ExecutionInsight, DebugLogsView, register, keyOfDocument };
