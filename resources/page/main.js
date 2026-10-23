// Sales Grid page: debug logs, anonymous Apex, trace flags and configuration.
// Everything shown comes from messages sent by the extension; every action is
// a message back to it.
(function () {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const send = (type, data) => vscode.postMessage({ type, ...(data || {}) });
  const viewer = window.createLogViewer({ send, esc });

  const ICON = {
    refresh: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/></svg>',
    trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/></svg>',
    play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>',
    stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>',
    file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3"/></svg>',
    replay: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v3h3"/><path d="M7 5.8v4.4L10.3 8z" fill="currentColor" stroke="none"/></svg>',
    plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 3v10M3 8h10"/></svg>',
    log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 3h9l4 4v14H6z M15 3v4h4 M9 12h7 M9 15.5h7 M9 9h3"/></svg>',
    bug: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><ellipse cx="8" cy="9" rx="3.5" ry="4.5"/><path d="M8 4.5V13.5M4.5 9H2M14 9h-2.5M4.8 6 3 4.5M11.2 6 13 4.5M4.8 12 3 13.5M11.2 12 13 13.5M6.3 4.8 5.5 3M9.7 4.8l.8-1.8"/></svg>',
    code: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5.5 4 2 8l3.5 4M10.5 4 14 8l-3.5 4"/></svg>',
    flag: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3.5 14.5V2M3.5 2.5h8l-1.6 3 1.6 3h-8"/></svg>',
    gear: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg>',
    bolt: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/></svg>',
    cloud: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4.5 12.5h7.25a2.75 2.75 0 0 0 .4-5.47A4 4 0 0 0 4.4 6.3 3.1 3.1 0 0 0 4.5 12.5z"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V2.5H2.5V11H5"/></svg>'
  };

  let S = {
    // The tab the extension opened the page on wins over the one last shown.
    tab: document.body.dataset.tab || (saved.tab && saved.tab !== 'file' ? saved.tab : 'logs'),
    orgs: [],
    org: '',
    logs: { items: [], loading: true },
    filter: saved.filter || 'all',
    userFilter: '',
    requested: !!saved.requested,
    found: null,
    detailView: 'summary',
    search: '',
    selected: saved.selected || '',
    detail: null,
    trace: { loading: true, flags: [], levels: [] },
    apex: {},
    config: {},
    model: null,
    presets: {},
    levels: [],
    categories: [],
    replay: false,
    autoRefresh: !!saved.autoRefresh,
    me: '',
    users: { items: [], text: '' },
    dmSearch: { items: [], text: '' },
    chosenUser: null
  };
  S.moreTools = !!saved.moreTools;
  const remember = () => vscode.setState({ ...(vscode.getState() || {}), tab: S.tab, filter: S.filter, selected: S.selected, autoRefresh: S.autoRefresh, requested: S.requested, moreTools: S.moreTools });
  const BUSY_ACTS = new Set(['refresh', 'startLogging', 'stopLogging', 'extend', 'deleteFlag', 'refreshTrace', 'saveLevel', 'deleteExpired', 'startLoggingFor', 'dmOn', 'dmOff', 'highlight']);

  // ---------- formatting ----------
  const kb = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
  const ms = (value) => (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`);
  const when = (iso) => {
    const d = new Date(String(iso).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (Number.isNaN(d.getTime())) return esc(iso);
    const today = new Date().toDateString() === d.toDateString();
    return today ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };
  const minutesLeft = (iso) => Math.max(0, Math.round((new Date(String(iso).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime() - Date.now()) / 60000));
  const left = (iso) => {
    const m = minutesLeft(iso);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
  };
  const statusPill = (status) => (/^success$/i.test(status) ? '<span class="pill ok">Success</span>' : `<span class="pill bad" title="${esc(status)}">${esc(status.length > 24 ? status.slice(0, 22) + '…' : status || 'Failed')}</span>`);
  const count = (n) => Number(n).toLocaleString();
  const bytes = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  // Shown in the one part of the page that is waiting for the org.
  const spinner = (text) => `<div class="loading"><span class="spinner"></span>${text ? `<span>${esc(text)}</span>` : ''}</div>`;
  const miniSpinner = '<span class="spinner mini"></span>';

  // ---------- tabs ----------
  function showTab(tab) {
    S.tab = tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('on', v.id === `view-${tab}`));
    remember();
    if (tab === 'orgs') renderOrgList();
    send('tab', { tab });
  }

  // ---------- Salesforce Orgs tab (was the Connected Orgs side bar panel) ----------
  const ORG_COLOURS = { red: '#e5534b', orange: '#e08a2e', yellow: '#d4b106', green: '#3fb950', blue: '#4493f8', purple: '#a371f7' };
  function renderOrgList() {
    const host = $('orgList');
    const list = S.orgList;
    if (!list) {
      host.innerHTML = spinner('Loading orgs…');
      return;
    }
    if (!list.length) {
      host.innerHTML = `<div class="empty">${ICON.cloud}<b>No connected orgs</b>Authorize one with sf org login web, then refresh.</div>`;
      return;
    }
    const button = (org, action, label, title, cls = 'ghost') => `<button class="btn ${cls}" data-act="orgAct" data-action="${action}" data-username="${esc(org.username)}" title="${esc(title)}">${label}</button>`;
    host.innerHTML = `<table class="orgtable"><tbody>${list
      .map((o) => {
        const dot = !o.connected ? '⚠' : o.expiringSoon ? '⏱' : o.favourite ? '★' : '●';
        const colour = !o.connected || o.expiringSoon ? 'var(--sg-amber, #d29922)' : ORG_COLOURS[o.colour] || 'var(--muted, #888)';
        const facts = [o.alias ? o.username : '', o.devHub ? `${o.type} · Dev Hub` : o.type, o.isDefault ? 'default' : '', o.expiry, o.connected ? '' : 'login expired'].filter(Boolean).join(' · ');
        const details = [o.edition, o.instanceUrl, o.orgId ? `Org ID ${o.orgId}` : '', o.status].filter(Boolean).join(' · ');
        const actions = o.connected
          ? button(o, 'open', 'Open', 'Open the org in the browser', 'primary') + button(o, 'copyUrl', 'Copy URL', 'Copy a front-door URL that opens the org')
          : button(o, 'relogin', 'Re-login', 'Log in to this org again', 'primary') + button(o, 'remove', 'Remove', 'Log out and remove this org', 'danger');
        return `<tr style="cursor:default"><td class="orgdot" style="color:${colour}">${dot}</td>
          <td><b>${esc(o.name)}</b>${o.production ? ' <span class="pill bad">PRODUCTION</span>' : ''}${o.isDefault ? ' <span class="pill info">Default</span>' : ''}<br><small>${esc(facts)}</small>${details ? `<br><small class="dim">${esc(details)}</small>` : ''}</td>
          <td class="num orgacts">${actions}
            <details class="menu"><summary class="btn ghost">More</summary><div class="menu-items">
              ${o.connected ? button(o, 'relogin', 'Re-login', 'Log in to this org again') : ''}
              ${button(o, o.favourite ? 'unpin' : 'pin', o.favourite ? 'Unpin' : 'Pin to top', o.favourite ? 'Stop pinning this org to the top' : 'Keep this org at the top of the list')}
              ${button(o, 'colour', 'Colour…', 'Give this org a colour')}
              ${button(o, 'copyUser', 'Copy username', 'Copy the username')}
            </div></details></td></tr>`;
      })
      .join('')}</tbody></table>`;
  }

  // ---------- org picker ----------
  function renderOrgs() {
    $('org').innerHTML = S.orgs
      .map((o) => `<option value="${esc(o.username)}" ${o.username === S.org ? 'selected' : ''}>${esc(o.label)}${o.connected ? '' : ' (login expired)'}</option>`)
      .join('');
  }

  // ---------- logging status ----------
  function renderStatus() {
    const t = S.trace;
    const host = $('status');
    if (t.loading && !t.flags.length) {
      host.innerHTML = spinner('Checking debug logging…');
      return;
    }
    const mine = t.mine;
    const state = mine
      ? `<span class="dot on"></span><div><b>Logging on</b><small>${esc(left(mine.expires))} · ${esc(mine.level)}</small></div>`
      : `<span class="dot off"></span><div><b>Logging off</b></div>`;
    // The everyday action is one button; level, duration and other users sit under Options.
    const controls = mine
      ? `<button class="btn ghost" data-act="extend" data-id="${esc(mine.id)}">${ICON.plus} 30 min</button>
         <button class="btn danger" data-act="stopLogging" data-id="${esc(mine.id)}">${ICON.stop} Stop</button>`
      : `<button class="btn primary" data-act="startLogging">${ICON.play} Start logging</button>
         <details class="menu"><summary class="btn ghost" title="Detail level, duration, other users">Options</summary><div class="menu-items wide">
           <label>Debug level<select class="input" id="preset" title="Which debug level the trace flag uses">${presetOptions()}</select></label>
           <label>For<select class="input" id="minutes"><option value="30">30 min</option><option value="60" selected>1 hour</option><option value="240">4 hours</option><option value="1440">24 hours</option></select></label>
           <button class="btn ghost" data-act="otherUser" title="Turn on debug logging for someone else">For another user…</button>
         </div></details>`;
    host.innerHTML = `
      <div class="state">${state}</div>
      <div class="ctrl">${controls}</div>
      ${t.error ? `<div class="error" style="flex-basis:100%">${esc(t.error)}</div>` : ''}`;
  }

  // ---------- log list ----------
  // Content search is active while the search box still holds what was searched.
  const finding = () => S.found && S.found.text === S.search.trim() ? S.found : null;

  // Time windows in which I asked for someone's logs: trace flags I created
  // on users (ids starting 005), from when they started to when they expire.
  function requestedWindows() {
    const parse = (iso) => new Date(String(iso).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')).getTime();
    return (S.trace.flags || [])
      .filter((f) => f.createdById === S.me && /^005/.test(f.entityId || ''))
      .map((f) => ({ user: f.entityId, from: parse(f.start || f.created) - 60000, to: parse(f.expires) + 60000 }));
  }

  function wasRequested(log, windows) {
    const at = new Date(log.start).getTime();
    return log.userId === S.me || windows.some((w) => w.user === log.userId && at >= w.from && at <= w.to);
  }

  const filtering = () => !!(S.requested || S.userFilter || S.filter !== 'all' || S.search.trim());

  function visibleLogs() {
    const q = S.search.trim().toLowerCase();
    const found = finding();
    const windows = S.requested ? requestedWindows() : null;
    return S.logs.items.filter((l) => {
      if (S.userFilter && l.user !== S.userFilter) return false;
      if (windows && !wasRequested(l, windows)) return false;
      if (found) {
        if (S.filter === 'mine' && l.userId !== S.me) return false;
        if (S.filter === 'errors' && /^success$/i.test(l.status)) return false;
        return !!(found.results[l.id] && found.results[l.id].count);
      }
      if (S.filter === 'mine' && l.userId !== S.me) return false;
      if (S.filter === 'errors' && /^success$/i.test(l.status)) return false;
      if (!q) return true;
      return `${l.operation} ${l.user} ${l.status} ${l.request} ${l.application}`.toLowerCase().includes(q);
    });
  }

  function renderUserFilter() {
    const users = [...new Set(S.logs.items.map((l) => l.user).filter(Boolean))].sort();
    if (S.userFilter && !users.includes(S.userFilter)) users.unshift(S.userFilter);
    $('userFilter').innerHTML = '<option value="">All users</option>' + users.map((u) => `<option ${u === S.userFilter ? 'selected' : ''}>${esc(u)}</option>`).join('');
  }

  function renderLogs() {
    const L = S.logs;
    renderUserFilter();
    const found = finding();
    document.querySelectorAll('#filters button').forEach((b) => b.classList.toggle('on', b.dataset.filter === S.filter));
    $('auto').checked = S.autoRefresh;
    $('deleteLogs').textContent = filtering() ? 'Delete shown' : 'Delete all';
    $('requested').checked = S.requested;
    $('deleteLogs').title = filtering() ? 'Delete the logs shown' : 'Delete all logs in the org';
    const body = $('logrows');
    $('moreTools').hidden = !S.moreTools;
    $('moreToggle').classList.toggle('on', !!S.moreTools || !!(S.requested || S.userFilter || S.autoRefresh));
    if (L.loading && !L.items.length) {
      body.innerHTML = `<tr><td colspan="4">${spinner('Loading logs…')}</td></tr>`;
      $('logfoot').textContent = '';
      return;
    }
    const rows = visibleLogs();
    if (L.error) {
      body.innerHTML = `<tr><td colspan="4"><div class="error">${esc(L.error)}</div></td></tr>`;
    } else if (!rows.length) {
      body.innerHTML = found && !found.done
        ? `<tr><td colspan="4">${spinner(`Searching inside logs… ${found.scanned}/${found.total}`)}</td></tr>`
        : `<tr><td colspan="4"><div class="empty">${ICON.log}<b>${L.items.length ? 'No logs match' : 'No debug logs yet'}</b>${L.items.length ? 'Try another filter.' : 'Start logging above, then run your code in the org.'}</div></td></tr>`;
    } else {
      // One line per log: what ran, then who and when underneath. Failed logs get a red dot.
      body.innerHTML = rows
        .map(
          (l) => `<tr data-id="${esc(l.id)}" class="${l.id === S.selected ? 'sel' : ''}">
            <td><span class="op" title="${esc(l.operation)}">${esc(l.operation || l.request)}</span><small>${when(l.start)} · ${esc(l.user)}</small>${found && found.results[l.id] && found.results[l.id].count ? `<span class="find" title="${esc(found.results[l.id].snippet)}"><span class="pill warn">${found.results[l.id].count}×</span> ${viewer.highlight(found.results[l.id].snippet, found.text)}</span>` : ''}</td>
            <td class="st">${/^success$/i.test(l.status) ? '<span class="sdot ok" title="Success"></span>' : `<span class="sdot bad" title="${esc(l.status || 'Failed')}"></span>`}</td>
            <td class="num">${ms(l.durationMs)}<small>${kb(l.bytes)}</small></td>
            <td class="open"><button class="btn ghost icon" data-act="openInEditor" data-id="${esc(l.id)}" title="Open log" aria-label="Open log">${ICON.file}</button><button class="btn ghost icon" data-act="openWithClass" data-id="${esc(l.id)}" title="Open log with class" aria-label="Open log with class">${ICON.code}</button></td></tr>`
        )
        .join('');
    }
    const searchNote = found ? (found.done ? ` · ${rows.length} contain “${esc(found.text)}”` : ` · searching ${found.scanned}/${found.total}…`) : '';
    $('logfoot').innerHTML = `<span>${rows.length} of ${L.items.length} logs${searchNote}</span><span>${L.loading ? `${miniSpinner} Refreshing…` : L.at ? 'Updated ' + when(L.at) : ''}</span>`;
  }

  // ---------- log detail ----------
  // `format` turns a raw figure into display text (counts, milliseconds, bytes).
  function tile(label, used, max, format) {
    if (used === undefined || used === null) return '';
    const show = format || count;
    const pct = max ? Math.min(100, (used / max) * 100) : 0;
    const level = pct >= 80 ? 'high' : pct >= 50 ? 'mid' : '';
    return `<div class="tile" title="${max ? `${pct.toFixed(0)}% of the limit` : ''}"><small>${esc(label)}</small><b>${esc(show(used))}${max ? ` <span>/ ${esc(show(max))}</span>` : ''}</b>${max ? `<div class="meter"><i class="${level}" style="width:${pct.toFixed(1)}%"></i></div>` : ''}</div>`;
  }

  function section(title, count, open, inner, kind) {
    if (!count) return '';
    return `<details class="sec" ${open ? 'open' : ''}><summary>${esc(title)} <span class="pill ${kind || 'mute'}">${esc(count)}</span></summary><div class="body">${inner}</div></details>`;
  }

  function renderSummary(summary, log) {
    const s = summary;
    const lim = s.limits || {};
    // The four figures people look at first; the remaining limits are one click away.
    const tiles = [
      `<div class="tile"><small>Duration</small><b>${ms(s.durationMs)}</b></div>`,
      tile('SOQL queries', lim.soql ? lim.soql.used : s.counts.soql, lim.soql && lim.soql.max),
      tile('DML statements', lim.dml ? lim.dml.used : s.counts.dml, lim.dml && lim.dml.max),
      tile('CPU time', lim.cpu && lim.cpu.used, lim.cpu && lim.cpu.max, (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`))
    ].join('');
    const otherTiles = [
      tile('Query rows', lim.queryRows && lim.queryRows.used, lim.queryRows && lim.queryRows.max),
      tile('Heap', lim.heap && lim.heap.used, lim.heap && lim.heap.max, bytes),
      tile('Callouts', lim.callouts && lim.callouts.used, lim.callouts && lim.callouts.max)
    ].filter(Boolean);
    const errors = s.errors
      .map((e) => `<div class="errline" data-jump="${e.ti}" title="Show in the timeline"><span class="pill ${e.kind === 'Fatal error' ? 'bad' : 'warn'}">${esc(e.kind)}</span> ${e.line ? `<span class="mono">line ${esc(e.line)}</span>` : ''} <small class="mono" style="color:var(--muted)">+${ms(e.ms)}</small><pre>${esc(e.text)}</pre></div>`)
      .join('');
    const debug = s.debug.map((d) => `<div class="logline" data-jump="${d.ti}" title="Show in the timeline"><span class="ln">${d.line ? 'L' + esc(d.line) : ''}</span><span class="lvl ${esc(d.level)}">${esc(d.level)}</span><pre>${esc(d.text)}</pre></div>`).join('');
    const queries = `<table><thead><tr><th>Line</th><th>Query</th><th class="num">Rows</th><th class="num">Time</th></tr></thead><tbody>${s.queries
      .map((q) => `<tr data-jump="${q.ti}" title="Show in the timeline"><td class="mono">${esc(q.line || '')}</td><td class="qtext">${esc(q.text)}</td><td class="num">${esc(q.rows === undefined ? '' : q.rows)}</td><td class="num">${q.durationMs === undefined ? '' : ms(q.durationMs)}</td></tr>`)
      .join('')}</tbody></table>`;
    const dml = `<table><thead><tr><th>Line</th><th>Operation</th><th>Object</th><th class="num">Rows</th></tr></thead><tbody>${s.dml
      .map((d) => `<tr><td class="mono">${esc(d.line || '')}</td><td>${esc(d.operation)}</td><td>${esc(d.object)}</td><td class="num">${esc(d.rows === undefined ? '' : d.rows)}</td></tr>`)
      .join('')}</tbody></table>`;
    const errorCount = s.counts.errors + s.counts.exceptions;
    return `
      <div class="tiles">${tiles}</div>
      ${section('Errors and exceptions', errorCount, true, errors, 'bad')}
      ${section('Debug output', s.counts.debug, !errorCount, debug + (s.counts.debug > s.debug.length ? `<p class="hint">Showing the first ${s.debug.length} of ${s.counts.debug}. Open the log for all of them.</p>` : ''), 'info')}
      ${section('SOQL queries', s.counts.soql, false, queries)}
      ${section('DML', s.counts.dml, false, dml)}
      ${section('Other limits', otherTiles.length, false, `<div class="tiles" style="margin:0">${otherTiles.join('')}</div>`)}
      ${!errorCount && !s.counts.debug && !s.counts.soql && !s.counts.dml ? '<p class="hint" style="margin-top:12px">Nothing notable in this log. Open it to read every line.</p>' : ''}
      <p class="hint" style="margin-top:12px">${esc(s.lines.toLocaleString())} lines · ${kb(s.bytes)}${log ? ` · ID <span class="mono">${esc(log.id)}</span>` : ''}</p>`;
  }

  function renderDetail() {
    const host = $('detail');
    const d = S.detail;
    if (!d) {
      host.innerHTML = `<div class="empty">${ICON.log}<b>Pick a log</b>Its errors, debug output, queries and limits appear here.</div>`;
      return;
    }
    if (d.loading) {
      host.innerHTML = spinner('Reading log…');
      return;
    }
    if (d.error) {
      host.innerHTML = `<div class="error">${esc(d.error)}</div>`;
      return;
    }
    const l = d.log || {};
    const found = finding();
    host.innerHTML = `
      <h3>${esc(l.operation || 'Debug log')}</h3>
      <div class="meta">${esc(l.user)} · ${when(l.start)} · ${statusPill(l.status || 'Success')}</div>
      <div class="actions">
        <button class="btn primary" data-act="highlight" data-id="${esc(l.id)}" title="Colour the Apex lines this log ran, in your classes and triggers">${ICON.code} Highlight in code</button>
        <button class="btn primary" data-act="explorer" data-id="${esc(l.id)}" title="Open this log in a new window with the code of every class and trigger it ran, debug output and exceptions">${ICON.code} Log Explorer</button>
        <button class="btn ghost" data-act="openInEditor" data-id="${esc(l.id)}">${ICON.file} Open log</button>
        <button class="btn ghost" data-act="openWithClass" data-id="${esc(l.id)}" title="Open the log, with the class it ran beside it and its lines highlighted">${ICON.code} Open log with class</button>
        <details class="menu"><summary class="btn ghost">More</summary><div class="menu-items">
          ${S.replay ? `<button data-act="replay" data-id="${esc(l.id)}" title="Step through this log in the Apex Replay Debugger">${ICON.replay} Apex Replay Debugger</button>` : ''}
          <button data-act="copyDebug" data-id="${esc(l.id)}">${ICON.copy} Copy debug output</button>
          <button data-act="saveLog" data-id="${esc(l.id)}">${ICON.file} Save log as…</button>
          <button data-act="copy" data-text="${esc(l.id)}">${ICON.copy} Copy log ID</button>
          <button class="danger" data-act="deleteOne" data-id="${esc(l.id)}">${ICON.trash} Delete log</button>
        </div></details>
      </div>
      ${found && found.results[l.id] && found.results[l.id].count ? `<div class="findnote"><span class="pill warn">${found.results[l.id].count}×</span> “${esc(found.text)}” appears in this log. The timeline shows each place.</div>` : ''}
      <div class="dtabs"><button data-dview="summary" class="${S.detailView === 'summary' ? 'on' : ''}">Summary</button><button data-dview="timeline" class="${S.detailView === 'timeline' ? 'on' : ''}">Timeline</button></div>
      <div id="dbody">${S.detailView === 'summary' ? renderSummary(d.summary, l) : ''}</div>`;
    if (S.detailView === 'timeline') viewer.mount($('dbody'), l.id, found ? found.text : undefined);
  }

  // ---------- run apex ----------
  function renderApex() {
    const a = S.apex;
    $('runApex').disabled = !!a.running;
    $('runApex').innerHTML = a.running ? '<span class="spinner mini light"></span>' : ICON.play;
    $('runApex').title = a.running ? 'Running…' : 'Run';
    const host = $('apexResult');
    if (!a.result && !a.error && !a.running) {
      host.innerHTML = '';
      return;
    }
    if (a.running) {
      host.innerHTML = `<div class="card">${spinner('Running Apex in the org…')}</div>`;
      return;
    }
    if (a.error) {
      host.innerHTML = `<div class="card"><div class="error">${esc(a.error)}</div></div>`;
      return;
    }
    const r = a.result;
    let head;
    if (!r.compiled) head = `<span class="pill bad">Did not compile</span><div><div class="big">Line ${esc(r.line)}, column ${esc(r.column)}</div><pre>${esc(r.compileProblem)}</pre></div>`;
    else if (!r.success) head = `<span class="pill bad">Failed</span><div><div class="big">${esc(r.exceptionMessage)}</div><pre>${esc(r.exceptionStackTrace || '')}</pre></div>`;
    else head = `<span class="pill ok">Success</span><div><div class="big">Ran without errors</div></div>`;
    host.innerHTML = `
      <div class="card"><div class="result">${head}</div>${a.note ? `<p class="hint" style="margin:10px 0 0">${esc(a.note)}</p>` : ''}</div>
      ${a.summary ? `<div class="card detail"><div class="actions"><b style="align-self:center;flex:1">Log of this run</b><button class="btn primary" data-act="openInEditor" data-id="${esc(a.logId)}">${ICON.file} Open log</button>${S.replay ? `<button class="btn ghost" data-act="replay" data-id="${esc(a.logId)}">${ICON.replay} Replay debugger</button>` : ''}</div>${renderSummary(a.summary)}</div>` : ''}`;
  }

  // ---------- trace flags & levels ----------
  function renderTrace() {
    const t = S.trace;
    const flags = $('flags');
    if (t.loading && !t.flags.length) {
      flags.innerHTML = spinner('Loading trace flags…');
    } else if (!t.flags.length) {
      flags.innerHTML = `<div class="empty">${ICON.flag}<b>No trace flags</b>Start logging on the Debug Logs tab to create one for you.</div>`;
    } else {
      flags.innerHTML = `<table><thead><tr><th>Traced</th><th>Type</th><th>Debug level</th><th>Expires</th><th></th></tr></thead><tbody>${t.flags
        .map(
          (f) => `<tr style="cursor:default"><td><b>${esc(f.entity)}</b></td><td><span class="pill mute">${esc(f.logType.replace('_', ' ').toLowerCase())}</span></td><td class="mono">${esc(f.level)}</td>
          <td>${f.active ? `<span class="pill ok">${esc(left(f.expires))}</span>` : `<span class="pill mute">Expired ${when(f.expires)}</span>`}</td>
          <td class="num">${f.active ? `<button class="btn ghost icon" data-act="extend" data-id="${esc(f.id)}" title="Add 30 minutes">${ICON.plus}</button> ` : ''}<button class="btn danger icon" data-act="deleteFlag" data-id="${esc(f.id)}" title="Delete trace flag">${ICON.trash}</button></td></tr>`
        )
        .join('')}</tbody></table>`;
    }
    const levels = $('levels');
    if (t.loading && !t.levels.length) {
      levels.innerHTML = spinner('Loading debug levels…');
      return;
    }
    if (!t.levels.length) {
      levels.innerHTML = `<div class="empty"><b>No debug levels</b>One is created when you first start logging.</div>`;
      return;
    }
    const options = (current) => S.levels.map((l) => `<option ${l === current ? 'selected' : ''}>${l}</option>`).join('');
    levels.innerHTML = `<div style="overflow:auto"><table class="levels"><thead><tr><th>Debug level</th>${S.categories.map((c) => `<th>${esc(c)}</th>`).join('')}<th></th></tr></thead><tbody>${t.levels
      .map(
        (lv) => `<tr style="cursor:default" data-level="${esc(lv.id)}"><td>${esc(lv.name)}</td>${S.categories
          .map((c) => `<td><select class="input" data-cat="${esc(c)}">${options(lv.levels[c])}</select></td>`)
          .join('')}<td><button class="btn ghost" data-act="saveLevel" data-id="${esc(lv.id)}">Save</button></td></tr>`
      )
      .join('')}</tbody></table></div>`;
  }

  // ---------- debug logging for any user ----------
  const initials = (name) => String(name || '?').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  // Debug levels to choose from when starting logging: Sales Grid's presets by
  // their level name (created on first use), then every other level in the org.
  // Values are "preset:<key>" or "level:<id>"; SalesGrid_Standard is the default.
  function presetOptions() {
    const chosen = saved.level || 'preset:Standard';
    const presetNames = new Set(Object.keys(S.presets).map((key) => `salesgrid_${key.toLowerCase()}`));
    const option = (value, label, about) => `<option value="${esc(value)}" ${value === chosen ? 'selected' : ''} title="${esc(about)}">${esc(label)}</option>`;
    const presets = Object.entries(S.presets).map(([key, p]) => option(`preset:${key}`, `SalesGrid_${key}`, `${p.label}: ${p.about}`));
    const others = (S.trace.levels || [])
      .filter((lv) => !presetNames.has(String(lv.name).toLowerCase()))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((lv) => option(`level:${lv.id}`, lv.name, `Apex Code ${lv.levels.ApexCode || '?'}`));
    return `<optgroup label="Sales Grid">${presets.join('')}</optgroup>${others.length ? `<optgroup label="In this org">${others.join('')}</optgroup>` : ''}`;
  }

  // "preset:<key>" / "level:<id>" -> what startLogging needs.
  function levelChoice(value) {
    saved.level = value;
    vscode.setState({ ...(vscode.getState() || {}), level: value });
    return value.startsWith('level:') ? { preset: 'Standard', levelId: value.slice(6) } : { preset: value.replace(/^preset:/, '') || 'Standard' };
  }

  function renderUsers() {
    const u = S.users;
    const host = $('userResults');
    // Closed once a user is picked; typing or focusing the search opens it again.
    if (u.closed || !u.text || u.text.trim().length < 2) {
      host.innerHTML = '';
    } else if (u.loading) {
      host.innerHTML = spinner('Searching users…');
    } else if (u.error) {
      host.innerHTML = `<div class="error" style="margin:8px">${esc(u.error)}</div>`;
    } else if (!u.items.length) {
      host.innerHTML = '<p class="hint">No active user matches.</p>';
    } else {
      host.innerHTML = u.items
        .map((user) => `<div class="user ${S.chosenUser && S.chosenUser.id === user.id ? 'on' : ''}" data-user="${esc(user.id)}"><span class="avatar">${esc(initials(user.name))}</span><div><b>${esc(user.name)}${user.id === S.me ? ' <span class="pill info">You</span>' : ''}</b><small>${esc(user.username)}${user.profile ? ' · ' + esc(user.profile) : ''}</small></div></div>`)
        .join('');
    }
    const chosen = S.chosenUser;
    if (!chosen) {
      $('userChosen').innerHTML = '';
      return;
    }
    const existing = S.trace.flags.find((f) => f.active && f.entityId === chosen.id);
    $('userChosen').innerHTML = `<div class="chosen">
      <div class="who"><span class="avatar">${esc(initials(chosen.name))}</span><div><b>${esc(chosen.name)}</b><small>${existing ? `Already logging: ${esc(left(existing.expires))}. Starting again replaces that time.` : esc(chosen.username)}</small></div></div>
      <select class="input" id="userPreset" title="Which debug level the trace flag uses">${presetOptions()}</select>
      <select class="input" id="userMinutes"><option value="30">30 min</option><option value="60" selected>1 hour</option><option value="240">4 hours</option><option value="1440">24 hours</option></select>
      <button class="btn primary" data-act="startLoggingFor">${ICON.play} Start logging</button>
      <button class="btn ghost" data-act="clearUser">Cancel</button></div>`;
  }

  // ---------- debug mode ----------
  function renderDebugMode() {
    const t = S.trace;
    if (t.loading && t.debugMode === undefined) {
      $('dmUsers').innerHTML = spinner('Loading users…');
      return;
    }
    const users = t.debugModeUsers;
    if (!users) {
      $('dmUsers').innerHTML = `${t.error ? `<div class="error">${esc(t.error)}</div>` : ''}<p class="hint">Could not read the list of users. You may not have permission to view users.</p>`;
    } else if (!users.length) {
      $('dmUsers').innerHTML = `<div class="empty">${ICON.bolt}<b>Nobody has debug mode on</b>Search for a user above to turn it on.</div>`;
    } else {
      $('dmUsers').innerHTML = `<table><thead><tr><th>User</th><th>Profile</th><th></th></tr></thead><tbody>${users
        .map(
          (u) => `<tr style="cursor:default"><td><div class="who" style="display:flex;gap:10px;align-items:center"><span class="avatar">${esc(initials(u.name))}</span><div><b>${esc(u.name)}</b>${u.id === t.me ? ' <span class="pill info">You</span>' : ''}<br><small>${esc(u.username)}</small></div></div></td><td>${esc(u.profile)}</td>
          <td class="num"><button class="btn danger" data-act="dmOff" data-id="${esc(u.id)}" data-name="${esc(u.name)}">Turn off</button></td></tr>`
        )
        .join('')}</tbody></table>`;
    }
    renderDmSearch();
  }

  function renderDmSearch() {
    const u = S.dmSearch;
    const host = $('dmResults');
    if (!u.text || u.text.trim().length < 2) {
      host.innerHTML = '';
      return;
    }
    if (u.loading) {
      host.innerHTML = spinner('Searching users…');
      return;
    }
    if (u.error) {
      host.innerHTML = `<div class="error" style="margin:8px">${esc(u.error)}</div>`;
      return;
    }
    if (!u.items.length) {
      host.innerHTML = '<p class="hint">No active user matches.</p>';
      return;
    }
    const on = new Set((S.trace.debugModeUsers || []).map((x) => x.id));
    host.innerHTML = u.items
      .map(
        (user) => `<div class="user" style="cursor:default"><span class="avatar">${esc(initials(user.name))}</span><div style="flex:1"><b>${esc(user.name)}</b><small>${esc(user.username)}${user.profile ? ' · ' + esc(user.profile) : ''}</small></div>
        ${on.has(user.id) ? '<span class="pill ok">On</span>' : `<button class="btn primary" data-act="dmOn" data-id="${esc(user.id)}" data-name="${esc(user.name)}">Turn on</button>`}</div>`
      )
      .join('');
  }

  // ---------- configuration ----------
  function renderConfig() {
    const m = S.model;
    if (!m) return;
    const c = S.config;
    const box = (key, label) => `<label class="switch" title="${esc(label)}"><input type="checkbox" data-key="${esc(key)}" ${c[key] !== false ? 'checked' : ''}><i></i></label>`;
    $('grid').innerHTML = `<thead><tr><th>Detail</th>${m.PLACES.map(([, heading, where]) => `<th>${esc(heading)}<small>${esc(where)}</small></th>`).join('')}</tr></thead><tbody>
      <tr class="all"><td>Show this place at all</td>${m.PLACES.map(([, heading, , master]) => `<td>${master ? box(master, 'Show ' + heading) : '<small>Always</small>'}</td>`).join('')}</tr>
      ${m.DETAILS.map(([detail, label, about]) => `<tr><td><b>${esc(label)}</b><br><small>${esc(about)}</small></td>${m.PLACES.map(([place, heading, , master]) => `<td class="${master && c[master] === false ? 'off' : ''}">${box(place + '.' + detail, label + ' in ' + heading)}</td>`).join('')}</tr>`).join('')}
    </tbody>`;
    $('features').innerHTML = m.FEATURES.map(([key, label, about]) => `<div class="opt"><div class="t"><b>${esc(label)}</b><small>${esc(about)}</small></div>${box(key, label)}</div>`).join('');
    $('general').innerHTML = m.GENERAL.map(
      ([key, type, label, about]) => `<div class="opt"><div class="t"><b>${esc(label)}</b><small>${esc(about)}</small></div><input class="input" type="${type}" min="0" data-general="${esc(key)}" data-type="${type}" value="${esc(c[key] === undefined ? '' : c[key])}"></div>`
    ).join('');
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(kind, text) {
    const el = $('toast');
    el.className = `show ${kind}`;
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.className = ''), kind === 'bad' ? 7000 : 3500);
  }

  // A bug in this page must never fail silently: show it and log it.
  const pageError = (text) => {
    toast('bad', `Something went wrong on this page: ${text}`);
    send('pageError', { text: String(text).slice(0, 500) });
  };
  window.addEventListener('error', (event) => pageError(event.message || 'unknown error'));
  window.addEventListener('unhandledrejection', (event) => pageError((event.reason && event.reason.message) || String(event.reason)));

  // ---------- events ----------
  // Double-clicking a log in the list opens it in the editor.
  document.addEventListener('dblclick', (event) => {
    const row = !event.target.closest('[data-act]') && event.target.closest('#logrows tr[data-id]');
    if (row) send('openInEditor', { id: row.dataset.id });
  });

  document.addEventListener('click', (event) => {
    if (viewer.onClick(event)) return undefined;
    const dview = event.target.closest('[data-dview]');
    if (dview) {
      S.detailView = dview.dataset.dview;
      return renderDetail();
    }
    const jump = event.target.closest('[data-jump]');
    if (jump && S.detail && S.detail.log && !S.apex.running && jump.closest('#detail')) {
      S.detailView = 'timeline';
      renderDetail();
      viewer.jumpToEvent(Number(jump.dataset.jump));
      return undefined;
    }
    const tabButton = event.target.closest('.tab');
    if (tabButton) return showTab(tabButton.dataset.tab);
    const filter = event.target.closest('#filters button');
    if (filter) {
      S.filter = filter.dataset.filter;
      remember();
      return renderLogs();
    }
    const pick = event.target.closest('[data-user]');
    if (pick) {
      S.chosenUser = S.users.items.find((user) => user.id === pick.dataset.user) || null;
      S.users.closed = true;
      return renderUsers();
    }
    const row = !event.target.closest('[data-act]') && event.target.closest('#logrows tr[data-id]');
    if (row) {
      S.selected = row.dataset.id;
      remember();
      document.querySelectorAll('#logrows tr').forEach((r) => r.classList.toggle('sel', r === row));
      if (finding()) S.detailView = 'timeline';
      return send('openLog', { id: S.selected });
    }
    if (event.target.closest('#moreToggle')) {
      S.moreTools = !S.moreTools;
      remember();
      return renderLogs();
    }
    // Clicking anywhere else closes an open drop-down menu.
    document.querySelectorAll('details.menu[open]').forEach((menu) => {
      if (!menu.contains(event.target) || event.target.closest('.menu-items button')) menu.open = false;
    });
    const act = event.target.closest('[data-act]');
    if (!act) return;
    const id = act.dataset.id;
    // Buttons that wait for the org show a spinner until the answer redraws them.
    if (BUSY_ACTS.has(act.dataset.act) && act.tagName === 'BUTTON' && !act.closest('.menu-items')) {
      act.disabled = true;
      act.classList.add('busy');
      act.insertAdjacentHTML('afterbegin', miniSpinner);
    }
    switch (act.dataset.act) {
      case 'highlight': return send('highlight', { id });
      case 'explorer': return send('explorer', { id });
      case 'refresh': return send('refreshLogs');
      case 'deleteAll':
        // With a filter on, only what is shown; otherwise every log in the org.
        return filtering() ? send('deleteLogs', { ids: visibleLogs().map((l) => l.id) }) : send('deleteLogs', { all: true });
      case 'deleteOne': return send('deleteLogs', { ids: [id] });
      case 'openInEditor': return send('openInEditor', { id });
      case 'openWithClass': return send('openWithClass', { id });
      case 'popOut': return send('popOut');
      case 'orgsRefresh': S.orgList = null; renderOrgList(); return send('orgsRefresh');
      case 'orgAct': return send('orgAct', { action: act.dataset.action, username: act.dataset.username });

      case 'replay': return send('replay', { id });
      case 'copy': return send('copy', { text: act.dataset.text });
      case 'copyDebug': return send('copyDebug', { id });
      case 'saveLog': return send('saveLog', { id });
      case 'deleteExpired': return send('deleteExpired');
      case 'startLogging': {
        return send('startLogging', { ...levelChoice($('preset').value), minutes: Number($('minutes').value) });
      }
      case 'stopLogging': return send('stopLogging', { id });
      case 'dmOn': return send('debugMode', { on: true, userId: id, name: act.dataset.name });
      case 'dmOff': return send('debugMode', { on: false, userId: id, name: act.dataset.name });
      case 'otherUser':
        showTab('trace');
        $('userSearch').focus();
        return undefined;
      case 'clearUser':
        S.chosenUser = null;
        return renderUsers();
      case 'startLoggingFor': {
        const chosen = S.chosenUser;
        if (!chosen) return undefined;
        // Read the choices before renderUsers() removes their controls.
        const level = levelChoice($('userPreset').value);
        const minutes = Number($('userMinutes').value);
        S.chosenUser = null;
        $('userSearch').value = '';
        S.users = { items: [], text: '' };
        renderUsers();
        return send('startLoggingFor', { userId: chosen.id, name: chosen.name, ...level, minutes });
      }
      case 'extend': return send('extend', { id, minutes: 30 });
      case 'deleteFlag': return send('deleteFlag', { id });
      case 'refreshTrace': return send('refreshTrace');
      case 'saveLevel': {
        const tr = act.closest('tr');
        const levels = {};
        tr.querySelectorAll('select[data-cat]').forEach((s) => (levels[s.dataset.cat] = s.value));
        return send('saveLevel', { id, levels });
      }
      case 'reset': return send('reset');
      default: return undefined;
    }
  });

  document.addEventListener('change', (event) => {
    const t = event.target;
    if (t.id === 'org') return send('org', { username: t.value });
    if (t.id === 'userFilter') {
      S.userFilter = t.value;
      return renderLogs();
    }
    if (t.id === 'requested') {
      S.requested = t.checked;
      remember();
      return renderLogs();
    }
    if (t.id === 'auto') {
      S.autoRefresh = t.checked;
      remember();
      return send('autoRefresh', { on: t.checked });
    }
    if (t.dataset.key) {
      S.config[t.dataset.key] = t.checked;
      renderConfig();
      return send('set', { key: t.dataset.key, value: t.checked });
    }
    if (t.dataset.general) {
      const value = t.dataset.type === 'number' ? Math.max(0, Number(t.value) || 0) : t.value.trim() || 'sf';
      return send('set', { key: t.dataset.general, value });
    }
    return undefined;
  });

  let dmTimer;
  $('dmSearch').addEventListener('input', (event) => {
    const text = event.target.value;
    S.dmSearch = { items: S.dmSearch.items, text, loading: text.trim().length >= 2 };
    renderDmSearch();
    clearTimeout(dmTimer);
    if (text.trim().length >= 2) {
      dmTimer = setTimeout(() => send('searchUsers', { text }), 250);
    }
  });

  let userTimer;
  $('userSearch').addEventListener('focus', () => {
    if (S.users.closed) {
      S.users.closed = false;
      renderUsers();
    }
  });
  $('userSearch').addEventListener('input', (event) => {
    const text = event.target.value;
    S.users = { items: S.users.items, text, loading: text.trim().length >= 2 };
    renderUsers();
    clearTimeout(userTimer);
    if (text.trim().length >= 2) {
      userTimer = setTimeout(() => send('searchUsers', { text }), 250);
    }
  });

  $('search').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const text = event.target.value.trim();
    S.search = text;
    if (text.replace(/[^a-z0-9]/gi, '').length < 2) return;
    S.found = { text, results: {}, scanned: 0, total: S.logs.items.length, done: false };
    renderLogs();
    send('findInLogs', { text });
  });

  let searchTimer;
  $('search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      S.search = event.target.value;
      renderLogs();
    }, 120);
  });

  const runApex = () => {
    const code = $('apex').value;
    if (!code.trim() || S.apex.running) return;
    send('runApex', { code });
  };
  $('runApex').addEventListener('click', runApex);
  $('apex').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      runApex();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const el = event.target;
      const start = el.selectionStart;
      el.value = el.value.slice(0, start) + '    ' + el.value.slice(el.selectionEnd);
      el.selectionStart = el.selectionEnd = start + 4;
    }
  });
  let apexTimer;
  $('apex').addEventListener('input', (event) => {
    clearTimeout(apexTimer);
    apexTimer = setTimeout(() => send('apexDraft', { code: event.target.value }), 500);
  });

  // Countdown on the logging status, without asking the org again.
  setInterval(() => {
    if (S.tab === 'logs' && S.trace.mine) renderStatus();
  }, 30000);

  // Puts back buttons that were showing a spinner once the extension answers.
  function clearBusy() {
    document.querySelectorAll('button.busy').forEach((button) => {
      button.classList.remove('busy');
      button.disabled = false;
      const spin = button.querySelector('.spinner');
      if (spin) spin.remove();
    });
  }

  // ---------- messages from the extension ----------
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'toast' || data.type === 'trace' || data.type === 'detail' || (data.type === 'logs' && !data.logs.loading)) clearBusy();
    switch (data.type) {
      case 'orgList':
        S.orgList = data.orgList;
        renderOrgList();
        break;
      case 'window': {
        // Already in its own window: the window's own buttons close it.
        $('winBtn').hidden = !!data.popped;
        break;
      }
      case 'init':
        Object.assign(S, { model: data.model, presets: data.presets, levels: data.levels, categories: data.categories, replay: data.replay, config: data.config });
        if (data.tab) S.tab = data.tab;
        // Drafts saved by older versions start with a hint comment that is no longer wanted.
        $('apex').value = (data.apexCode || '').replace(/^\/\/ Runs in the selected org as you\. Ctrl\+Enter runs it\.\r?\n/, '') || $('apex').value;
        showTab(S.tab);
        renderConfig();
        renderStatus();
        send('autoRefresh', { on: S.autoRefresh });
        if (data.select) {
          S.selected = data.select;
          remember();
        }
        if (S.selected) send('openLog', { id: S.selected, quiet: true });
        break;
      case 'tab':
        showTab(data.tab);
        break;
      case 'orgs':
        S.orgs = data.orgs;
        S.org = data.org;
        renderOrgs();
        break;
      case 'logs':
        S.logs = data.logs;
        S.me = data.me || S.me;
        renderLogs();
        break;
      case 'trace':
        S.trace = data.trace;
        renderStatus();
        renderTrace();
        renderUsers();
        renderDebugMode();
        if (S.requested) renderLogs();
        break;
      case 'users':
        // Ignore answers to an older search.
        if (data.text === $('userSearch').value) {
          S.users = { items: data.users, text: data.text, error: data.error };
          renderUsers();
        }
        if (data.text === $('dmSearch').value) {
          S.dmSearch = { items: data.users, text: data.text, error: data.error };
          renderDmSearch();
        }
        break;
      case 'timeline':
        viewer.onData(data);
        break;
      case 'found':
        if (S.found && data.text === S.found.text) {
          S.found = data;
          renderLogs();
          if (data.done && S.detail && S.detail.log) renderDetail();
        }
        break;
      case 'detail':
        S.detail = data.detail;
        if (data.detail && data.detail.missing) {
          S.detail = null;
          S.selected = '';
          remember();
        }
        renderDetail();
        break;
      case 'apex':
        S.apex = data.apex;
        renderApex();
        break;
      case 'config':
        S.config = data.config;
        if (!document.activeElement || !document.activeElement.dataset || !document.activeElement.dataset.general) renderConfig();
        break;
      case 'toast':
        toast(data.kind, data.text);
        break;
      default:
        break;
    }
  });

  // Static icons in the page skeleton.
  document.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = ICON[el.dataset.icon] + el.innerHTML));
  showTab(S.tab);
  renderLogs();
  renderDetail();
  send('ready');
})();
