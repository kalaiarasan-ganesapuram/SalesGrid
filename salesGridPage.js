// The Sales Grid page: debug logs, anonymous Apex, trace flags and debug
// levels, and configuration, in one tabbed web view.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { parseLog, buildTimeline } = require('./logParser');
const { PRESETS, LEVELS, CATEGORIES } = require('./debug');
const configModel = require('./configPage');
const { moveToNewWindow, maximize } = require('./popOut');

const ORG_KEY = 'salesgrid.pageOrg';
const APEX_KEY = 'salesgrid.apexDraft';
const LOG_REFRESH_MS = 10 * 1000;
const SUMMARY_CACHE = 40;
const TIMELINE_CACHE = 6;
const SEARCH_CONCURRENCY = 6;
const REPLAY_COMMAND = 'sf.launch.apex.replay.debugger.with.current.file';
const DEFAULT_APEX = "System.debug('Hello from Sales Grid');\n";

// Letters and digits of a keyword with anything else allowed between them, so
// "attempt to dereference" also finds "Attempt to de-reference".
function keywordPattern(text, flags) {
  const chars = String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return chars ? new RegExp(chars.split('').join('[\\W_]*'), flags || 'i') : null;
}

const LOG_ORGS_KEY = 'salesgrid.logOrgs';

// Where downloaded logs are kept. Inside a Salesforce project this is the
// folder the Salesforce extensions use, so their tools find the files too.
const DELETE_WITH_FILES = 'Delete, and downloaded copies too';

function logFolder(context) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const base = folder ? path.join(folder.uri.fsPath, '.sfdx', 'tools', 'debug', 'logs') : path.join(context.globalStorageUri.fsPath, 'logs');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

// Which org each downloaded log came from, so a log is never matched against
// another org's code.
function logOrg(context, id) {
  return context.globalState.get(LOG_ORGS_KEY, {})[id];
}

function rememberLogOrg(context, id, org) {
  const known = { ...context.globalState.get(LOG_ORGS_KEY, {}) };
  delete known[id];
  known[id] = org;
  const ids = Object.keys(known);
  ids.slice(0, Math.max(0, ids.length - 1000)).forEach((old) => delete known[old]);
  return context.globalState.update(LOG_ORGS_KEY, known);
}

// Downloads a log once; a log never changes after it is written.
async function downloadLog(context, debug, org, id) {
  if (!/^[a-zA-Z0-9]{15,18}$/.test(id || '')) {
    throw new Error('Unsupported log id.');
  }
  const file = path.join(logFolder(context), `${id}.log`);
  if (!fs.existsSync(file)) {
    const body = await debug.logBody(org, id);
    await fs.promises.writeFile(file, body);
  }
  if (org && logOrg(context, id) !== org) {
    await rememberLogOrg(context, id, org);
  }
  return file;
}

function nonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

class SalesGridPage {
  // deps: { context, output, log, provider, debugger, defaultOrg() }
  constructor(deps) {
    Object.assign(this, deps);
    this.panel = undefined;
    this.tab = 'logs';
    this.org = deps.context.workspaceState.get(ORG_KEY);
    this.autoRefresh = false;
    this.logs = new Map(); // username -> { items, at }
    this.summaries = new Map(); // log id -> summary
    this.timelines = new Map(); // log id -> { entries, counts, views }
    this.searchRun = 0;
    this.listeners = [];
  }

  async open(tab) {
    if (tab) {
      this.tab = tab;
    }
    if (this.panel) {
      this.panel.reveal();
      this.post('tab', { tab: this.tab });
      return;
    }
    // Connect to the last org now, while the org list (a slow CLI call) loads,
    // so its logs and trace flags arrive seconds sooner.
    if (this.org) {
      Promise.resolve(this.debugger.userId(this.org)).catch(() => undefined);
    }
    const root = vscode.Uri.joinPath(this.context.extensionUri, 'resources');
    this.panel = vscode.window.createWebviewPanel('salesgrid.page', 'Sales Grid', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [root]
    });
    this.panel.iconPath = vscode.Uri.joinPath(root, 'toolbar.png');
    this.panel.webview.html = this.html(root);
    this.listeners = [
      this.panel.webview.onDidReceiveMessage((message) => this.handle(message).catch((error) => this.fail('Something went wrong.', error))),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('salesgrid')) {
          this.post('config', { config: configModel.readState() });
        }
      }),
      this.provider.onDidLoad(() => this.sendOrgs())
    ];
    // Only ask the org for new logs while the page is visible.
    this.timer = setInterval(() => {
      if (this.panel && this.panel.visible && this.autoRefresh && this.tab === 'logs') {
        this.refreshLogs(true);
      }
    }, LOG_REFRESH_MS);
    this.panel.onDidDispose(() => {
      this.poppedOut = false;
      clearInterval(this.timer);
      this.listeners.forEach((listener) => listener.dispose());
      this.panel = undefined;
    });
  }

  html(root) {
    const webview = this.panel.webview;
    const id = nonce();
    const asset = (...parts) => webview.asWebviewUri(vscode.Uri.joinPath(root, ...parts));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${id}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('page', 'page.css')}">
<title>Sales Grid</title>
</head>
<body data-tab="${/^[a-z]+$/.test(this.tab) ? this.tab : 'logs'}">
<header class="top">
  <div class="bar">
    <div class="brand"><img src="${asset('icon.png')}" alt=""><div><h1>Sales <b>Grid</b></h1><small>Debug logs, Apex and configuration</small></div></div>
    <div class="spacer"></div>
    <label class="orgpick"><span>Org</span><select id="org" aria-label="Org"></select></label>
    <button class="winbtn" id="winBtn" data-act="popOut" title="Open this page in a new maximized window">Open in new window</button>
  </div>
  <nav class="tabs">
    <button class="tab" data-tab="orgs"><span data-icon="cloud"></span>Salesforce Orgs</button>
    <button class="tab" data-tab="logs"><span data-icon="bug"></span>Debug Logs</button>
    <button class="tab" data-tab="debugmode"><span data-icon="bolt"></span>Debug Mode</button>
    <button class="tab" data-tab="apex"><span data-icon="code"></span>Run Apex</button>
    <button class="tab" data-tab="trace"><span data-icon="flag"></span>Trace Flags &amp; Levels</button>
    <button class="tab" data-tab="config"><span data-icon="gear"></span>Configuration</button>
  </nav>
</header>
<main>
  <section class="view" id="view-logs">
    <div class="card status" id="status"></div>
    <div class="split">
      <div class="card list">
        <div class="tools">
          <div class="toolrow">
          <input class="input" id="search" type="search" placeholder="Filter, or Enter to search inside logs…" aria-label="Search logs" title="Typing filters by operation, user and status. Press Enter to find logs whose contents contain the words, for example: attempt to dereference">
          <div class="seg" id="filters"><button data-filter="all">All</button><button data-filter="mine">Mine</button><button data-filter="errors">Errors</button></div>
          <button class="btn ghost icon" data-act="refresh" title="Refresh" data-icon="refresh"></button>
          <button class="btn ghost" id="moreToggle" title="User filter, live updates">More</button>
          <button class="btn danger" id="deleteLogs" data-act="deleteAll" title="Delete the debug logs in this org (only the ones shown when a filter is on)">Delete all</button>
          </div>
          <div class="toolrow" id="moreTools" hidden>
          <select class="input" id="userFilter" aria-label="User" title="Show logs of one user"></select>
          <label class="switch" title="Only logs of users whose logging you turned on, recorded while it was on, and your own logs"><input type="checkbox" id="requested"><i></i><span>Requested by me</span></label>
          <label class="switch" title="Check for new logs every 10 seconds while this page is open"><input type="checkbox" id="auto"><i></i><span>Live</span></label>
          </div>
        </div>
        <div class="scroll"><table><thead><tr><th>Log</th><th class="st"></th><th class="num">Duration</th><th class="open"></th></tr></thead><tbody id="logrows"></tbody></table></div>
        <div class="listfoot" id="logfoot"></div>
      </div>
      <div class="card detail" id="detail"></div>
    </div>
  </section>

  <section class="view" id="view-debugmode">
    <div class="card">
      <h2>Turn on Lightning debug mode for a user</h2>
      <p class="hint">Lightning components then run unminified, so browser errors show readable code and real line numbers. For example, to read the real error someone sees in a Lightning page. Needs the Manage Users permission.</p>
      <div class="userpick">
        <input class="input" id="dmSearch" type="search" placeholder="Search active users…" aria-label="Search users" autocomplete="off">
        <div id="dmResults" class="userresults"></div>
      </div>
    </div>
    <div class="card">
      <h2>Users with debug mode on</h2>
      <p class="hint">Debug mode makes Lightning pages slower, so turn it off when it is no longer needed.</p>
      <div id="dmUsers"></div>
    </div>
  </section>

  <section class="view" id="view-apex">
    <div class="card">
      <div class="apexhead"><h2>Run anonymous Apex</h2><button class="playbtn" id="runApex" title="Run" aria-label="Run" data-icon="play"></button></div>
      <p class="hint">Runs in the selected org as you, like the Developer Console. If debug logging is off, it is switched on for 15 minutes so the run produces a log.</p>
      <textarea class="editor" id="apex" spellcheck="false" aria-label="Apex code">${DEFAULT_APEX.replace(/</g, '&lt;')}</textarea>
    </div>
    <div id="apexResult" style="margin-top:14px"></div>
  </section>

  <section class="view" id="view-trace">
    <div class="card">
      <h2>Debug logging for any user</h2>
      <p class="hint">Record logs while someone else uses the org, for example to see what fails for a particular user. Find them by name or username.</p>
      <div class="userpick">
        <input class="input" id="userSearch" type="search" placeholder="Search active users…" aria-label="Search users" autocomplete="off">
        <div id="userResults" class="userresults"></div>
      </div>
      <div id="userChosen"></div>
    </div>
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px"><h2 style="flex:1">Trace flags</h2><button class="btn danger" data-act="deleteExpired" data-icon="trash" title="Delete every trace flag that has already expired"> Delete expired</button><button class="btn ghost" data-act="refreshTrace" data-icon="refresh"> Refresh</button></div>
      <p class="hint">Who and what is being logged in this org, and until when.</p>
      <div id="flags"></div>
    </div>
    <div class="card">
      <h2>Debug levels</h2>
      <p class="hint">How much each category records. Higher levels give more detail and larger logs. Sales Grid's own levels start with SalesGrid_.</p>
      <div id="levels"></div>
    </div>
  </section>

  <section class="view" id="view-orgs">
    <div class="card">
      <div class="cardhead"><h2>Salesforce orgs</h2><span class="spacer"></span><button class="btn ghost" data-act="orgsRefresh" data-icon="refresh"> Refresh</button></div>
      <p class="hint">Pinned orgs first; orgs whose login has expired last. Authorize a new one with <span class="mono">sf org login web</span>, then refresh.</p>
      <div id="orgList"></div>
    </div>
  </section>

  <section class="view" id="view-config">
    <div class="card">
      <h2>Where details are shown</h2>
      <p class="hint">Switch each detail on or off in each place. Changes apply at once.</p>
      <div style="overflow:auto"><table class="grid" id="grid"></table></div>
    </div>
    <div class="cfgcols">
      <div class="card"><h2>Features</h2><p class="hint">Turn off anything you do not want.</p><div class="opts" id="features"></div></div>
      <div class="card"><h2>General</h2><p class="hint">&nbsp;</p><div class="opts" id="general"></div>
        <div style="margin-top:14px"><button class="btn ghost" data-act="reset">Reset everything to defaults</button></div></div>
    </div>
  </section>
</main>
<div id="toast" role="status"></div>
<script nonce="${id}" src="${asset('page', 'viewer.js')}"></script>
<script nonce="${id}" src="${asset('page', 'main.js')}"></script>
</body>
</html>`;
  }

  // Salesforce Orgs tab (formerly the Connected Orgs side bar panel): sent
  // when it is shown and whenever the org list changes.
  async refreshSideTabs() {
    if (!this.panel) {
      return;
    }
    try {
      if (this.tab === 'orgs' && this.orgList) {
        this.post('orgList', { orgList: await this.orgList() });
      }
    } catch (error) {
      this.log(`FAILED: could not refresh the ${this.tab} tab. ${error.message}`);
    }
  }

  post(type, data) {
    if (this.panel) {
      this.panel.webview.postMessage({ type, ...data });
    }
  }

  toast(kind, text) {
    this.post('toast', { kind, text });
  }

  fail(summary, error) {
    this.log(`FAILED: ${summary} ${error.message}`);
    this.toast('bad', `${summary} ${error.message}`);
  }

  async handle(message) {
    switch (message.type) {
      case 'ready': {
        const commands = await vscode.commands.getCommands(true);
        this.post('init', {
          tab: this.tab,
          model: { DETAILS: configModel.DETAILS, PLACES: configModel.PLACES, FEATURES: configModel.FEATURES, GENERAL: configModel.GENERAL },
          presets: Object.fromEntries(Object.entries(PRESETS).map(([key, p]) => [key, { label: p.label, about: p.about }])),
          levels: LEVELS,
          categories: CATEGORIES,
          replay: commands.includes(REPLAY_COMMAND),
          config: configModel.readState(),
          apexCode: this.context.workspaceState.get(APEX_KEY),
          // A log the sidebar asked to show before the page existed.
          select: this.pendingLog
        });
        this.pendingLog = undefined;
        if (this.poppedOut) {
          this.post('window', { popped: true });
        }
        await this.sendOrgs();
        this.loadOrgData();
        break;
      }
      case 'tab':
        this.tab = message.tab;
        if (message.tab === 'orgs') {
          this.refreshSideTabs();
        }
        if (message.tab === 'trace' || message.tab === 'debugmode') {
          this.refreshTrace();
        }
        break;
      case 'org':
        this.org = message.username;
        await this.context.workspaceState.update(ORG_KEY, this.org);
        this.post('detail', { detail: null });
        this.loadOrgData();
        break;
      case 'refreshLogs':
        await this.refreshLogs();
        break;
      case 'autoRefresh':
        this.autoRefresh = !!message.on;
        break;
      case 'openLog':
        await this.openLog(message.id, message.quiet);
        break;
      case 'openInEditor':
        await this.openInEditor(message.id);
        break;
      case 'orgsRefresh':
        await vscode.commands.executeCommand('salesgrid.refresh');
        break;
      case 'orgAct':
        if (this.orgAction) {
          await this.orgAction(message.action, message.username);
          this.refreshSideTabs();
        }
        break;
      case 'popOut':
        // A maximized window of its own for more width; the button then hides
        // and the window's own buttons close it.
        this.panel.reveal(undefined, false);
        try {
          await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
          this.poppedOut = true;
          this.post('window', { popped: true });
          await maximize();
        } catch (error) {
          this.fail('Could not open the page in a new window.', error);
        }
        break;
      case 'openWithClass':
        if (this.openLogWithClass) {
          await this.openLogWithClass(this.org, this.findLog(message.id) || { id: message.id });
        }
        break;
      case 'highlight':
        // Hands the log to the source highlighter, which opens the code it ran.
        if (this.highlightLog) {
          const log = this.findLog(message.id) || { id: message.id };
          await this.highlightLog({ org: this.org, id: message.id, log });
          this.toast('ok', 'Highlighting the code this log ran. Open any class or trigger it touched.');
        }
        break;
      case 'explorer':
        // Full-screen view of the log with the code of every class and trigger it ran.
        if (this.openLogExplorer) {
          await this.openLogExplorer({ org: this.org, id: message.id, log: this.findLog(message.id) || { id: message.id } });
        }
        break;
      case 'replay':
        await this.replay(message.id);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(message.text || ''));
        this.toast('ok', 'Copied.');
        break;
      case 'pageError':
        // The page already shows a toast; keep a record for troubleshooting.
        this.log(`FAILED: error in the Sales Grid page. ${String(message.text || '').slice(0, 500)}`);
        break;
      case 'deleteLogs':
        await this.deleteLogs(message);
        break;
      case 'startLogging':
        await this.traceAction('Debug logging is on.', () => this.debugger.startLogging(this.org, message.minutes, message.preset, undefined, message.levelId));
        break;
      case 'searchUsers':
        await this.searchUsers(message.text);
        break;
      case 'startLoggingFor':
        await this.traceAction(`Debug logging is on for ${message.name}.`, () =>
          this.debugger.startLogging(this.org, message.minutes, message.preset, message.userId, message.levelId)
        );
        break;
      case 'timeline':
        await this.sendTimeline(message);
        break;
      case 'findInLogs':
        await this.findInLogs(String(message.text || ''));
        break;
      case 'saveLog':
        await this.saveLog(message.id);
        break;
      case 'copyDebug':
        await this.copyDebug(message.id);
        break;
      case 'deleteExpired':
        await this.deleteExpiredFlags();
        break;
      case 'stopLogging':
        await this.traceAction('Debug logging is off.', () => this.debugger.deleteFlag(this.org, message.id));
        break;
      case 'extend':
        await this.traceAction('Extended by 30 minutes.', () => this.debugger.extendFlag(this.org, message.id, message.minutes || 30));
        break;
      case 'deleteFlag':
        await this.traceAction('Trace flag deleted.', () => this.debugger.deleteFlag(this.org, message.id));
        break;
      case 'refreshTrace':
        await this.refreshTrace();
        break;
      case 'saveLevel':
        await this.traceAction('Debug level saved.', () => this.debugger.saveDebugLevel(this.org, message.id, message.levels));
        break;
      case 'debugMode': {
        const who = message.name ? ` for ${message.name}` : '';
        await this.traceAction(`Lightning debug mode is ${message.on ? 'on' : 'off'}${who}.`, () =>
          this.debugger.setDebugMode(this.org, message.on, message.userId)
        );
        break;
      }
      case 'runApex':
        await this.runApex(message.code);
        break;
      case 'apexDraft':
        await this.context.workspaceState.update(APEX_KEY, String(message.code || ''));
        break;
      case 'set':
        if (configModel.allKeys().includes(message.key)) {
          await vscode.workspace.getConfiguration('salesgrid').update(message.key, message.value, vscode.ConfigurationTarget.Global);
        }
        break;
      case 'reset':
        await this.resetConfig();
        break;
      default:
        break;
    }
  }

  async sendOrgs() {
    const orgs = await this.provider.load();
    if (!orgs.some((org) => org.username === this.org)) {
      const preferred = await this.defaultOrg();
      this.org = (preferred && preferred.username) || (orgs[0] && orgs[0].username);
    }
    this.post('orgs', {
      org: this.org,
      orgs: orgs.map((org) => ({
        username: org.username,
        label: org.alias ? `${org.alias} · ${org.username}` : org.username,
        connected: !org.isExpired && /^(connected|active)$/i.test(org.status)
      }))
    });
  }

  loadOrgData() {
    if (!this.org) {
      return;
    }
    // Show what is already known for this org at once, then refresh it.
    const cached = this.logs.get(this.org);
    if (cached) {
      this.post('logs', { logs: { ...cached, loading: true }, me: cached.me });
    }
    this.refreshLogs();
    this.refreshTrace();
  }

  async refreshLogs(quiet) {
    const org = this.org;
    if (!org) {
      return;
    }
    const cached = this.logs.get(org) || { items: [] };
    if (!quiet) {
      this.post('logs', { logs: { ...cached, loading: true }, me: cached.me });
    }
    try {
      const [items, me] = await Promise.all([this.debugger.listLogs(org), this.debugger.userId(org)]);
      const changed = !cached.items.length || !items.length || cached.items[0].id !== items[0].id || cached.items.length !== items.length;
      const entry = { items, at: new Date().toISOString(), me };
      this.logs.set(org, entry);
      if (org === this.org && (changed || !quiet)) {
        this.post('logs', { logs: { ...entry, loading: false }, me });
      }
    } catch (error) {
      if (org === this.org) {
        this.post('logs', { logs: { ...cached, loading: false, error: error.message }, me: cached.me });
      }
      this.log(`FAILED: could not list debug logs. ${error.message}`);
    }
  }

  async refreshTrace() {
    const org = this.org;
    if (!org) {
      return;
    }
    try {
      const [flags, levels, debugMode, me, debugModeUsers] = await Promise.all([
        this.debugger.traceFlags(org),
        this.debugger.debugLevels(org),
        this.debugger.debugMode(org),
        this.debugger.userId(org),
        this.debugger.debugModeUsers(org).catch(() => undefined)
      ]);
      const mine = flags.find((flag) => flag.active && flag.entityId === me && flag.logType === 'DEVELOPER_LOG');
      if (org === this.org) {
        this.post('trace', { trace: { flags, levels, debugMode, debugModeUsers, me, mine, loading: false } });
      }
      return mine;
    } catch (error) {
      if (org === this.org) {
        this.post('trace', { trace: { flags: [], levels: [], loading: false, error: error.message } });
      }
      this.log(`FAILED: could not read trace flags. ${error.message}`);
      return undefined;
    }
  }

  async searchUsers(text) {
    const org = this.org;
    try {
      const users = await this.debugger.searchUsers(org, text);
      if (org === this.org) {
        this.post('users', { users, text });
      }
    } catch (error) {
      this.post('users', { users: [], text, error: error.message });
    }
  }

  async traceAction(success, task) {
    try {
      await task();
      this.log(success);
      this.toast('ok', success);
    } catch (error) {
      this.fail('That did not work.', error);
    }
    await this.refreshTrace();
  }

  logFolder() {
    return logFolder(this.context);
  }

  // A log never changes once written, so a downloaded copy is reused.
  async logFile(id, org = this.org) {
    return downloadLog(this.context, this.debugger, org, id);
  }

  async summary(id) {
    if (this.summaries.has(id)) {
      return this.summaries.get(id);
    }
    const text = await fs.promises.readFile(await this.logFile(id), 'utf8');
    const result = parseLog(text);
    this.summaries.set(id, result);
    if (this.summaries.size > SUMMARY_CACHE) {
      this.summaries.delete(this.summaries.keys().next().value);
    }
    return result;
  }

  async timeline(id) {
    if (!this.timelines.has(id)) {
      const text = await fs.promises.readFile(await this.logFile(id), 'utf8');
      const entries = buildTimeline(text);
      const counts = {};
      for (const entry of entries) {
        counts[entry.cat] = (counts[entry.cat] || 0) + 1;
      }
      this.timelines.set(id, { entries, counts, views: new Map() });
      if (this.timelines.size > TIMELINE_CACHE) {
        this.timelines.delete(this.timelines.keys().next().value);
      }
    }
    return this.timelines.get(id);
  }

  // One page of the timeline for the page's current filters. The filtered
  // list of positions is worked out once per filter and kept.
  async sendTimeline(message) {
    try {
      const timeline = await this.timeline(message.id);
      const kinds = new Set(message.kinds || []);
      const viewKey = `${[...kinds].sort().join(',')}|${message.keyword || ''}`;
      let view = timeline.views.get(viewKey);
      if (!view) {
        const pattern = keywordPattern(message.keyword);
        view = [];
        timeline.entries.forEach((entry, index) => {
          if (kinds.has(entry.cat) && (!pattern || pattern.test(`${entry.event} ${entry.text}`))) {
            view.push(index);
          }
        });
        timeline.views.set(viewKey, view);
      }
      const offset = Math.max(0, Number(message.offset) || 0);
      const limit = Math.min(500, Number(message.limit) || 200);
      const rows = view.slice(offset, offset + limit).map((index) => {
        const entry = timeline.entries[index];
        return { i: index, ms: entry.ms, event: entry.event, cat: entry.cat, line: entry.line, text: entry.text.length > 6000 ? `${entry.text.slice(0, 6000)} …` : entry.text };
      });
      this.post('timeline', { key: message.key, offset, rows, total: view.length, all: timeline.entries.length, counts: timeline.counts });
    } catch (error) {
      this.fail('Could not read this log.', error);
    }
  }

  // Finds the logs whose contents contain the keyword. Logs are downloaded
  // once and kept, so searching again is quick.
  async findInLogs(text) {
    const run = ++this.searchRun;
    const pattern = keywordPattern(text, 'gi');
    const entry = this.logs.get(this.org);
    if (!pattern || !entry) {
      this.post('found', { text, results: {}, scanned: 0, total: 0, done: true });
      return;
    }
    const items = entry.items;
    const results = {};
    let scanned = 0;
    let next = 0;
    let lastPost = 0;
    const post = (done) => this.post('found', { text, results, scanned, total: items.length, done });
    const worker = async () => {
      while (next < items.length && run === this.searchRun) {
        const log = items[next++];
        try {
          const body = await fs.promises.readFile(await this.logFile(log.id), 'utf8');
          const re = new RegExp(pattern.source, 'gi');
          let count = 0;
          let firstAt = -1;
          let match;
          while ((match = re.exec(body)) && match[0]) {
            if (firstAt < 0) firstAt = match.index;
            count++;
          }
          if (count) {
            const start = body.lastIndexOf('\n', firstAt) + 1;
            const end = body.indexOf('\n', firstAt);
            const raw = body.slice(start, end < 0 ? undefined : end);
            const offset = firstAt - start;
            const from = Math.max(0, offset - 40);
            const piece = raw.slice(from, from + 220);
            results[log.id] = { count, snippet: `${from > 0 ? '…' : ''}${piece}${from + 220 < raw.length ? '…' : ''}` };
          }
        } catch (error) {
          results[log.id] = { error: error.message };
        }
        scanned++;
        if (Date.now() - lastPost > 250) {
          lastPost = Date.now();
          post(false);
        }
      }
    };
    await Promise.all(Array.from({ length: SEARCH_CONCURRENCY }, worker));
    if (run === this.searchRun) {
      post(true);
      this.log(`Searched ${scanned} logs for "${text}": ${Object.values(results).filter((r) => r.count).length} contain it.`);
    }
  }

  async saveLog(id) {
    try {
      const source = await this.logFile(id);
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('os').homedir(), `${id}.log`)), filters: { 'Debug log': ['log'], 'All files': ['*'] } });
      if (target) {
        await fs.promises.copyFile(source, target.fsPath);
        this.toast('ok', `Saved to ${target.fsPath}`);
      }
    } catch (error) {
      this.fail('Could not save the log.', error);
    }
  }

  async copyDebug(id) {
    try {
      const { entries } = await this.timeline(id);
      const lines = entries.filter((entry) => entry.event === 'USER_DEBUG').map((entry) => `[${entry.line || ''}] ${entry.text}`);
      await vscode.env.clipboard.writeText(lines.join('\n'));
      this.toast('ok', `Copied ${lines.length} debug line${lines.length === 1 ? '' : 's'}.`);
    } catch (error) {
      this.fail('Could not copy the debug output.', error);
    }
  }

  async deleteExpiredFlags() {
    try {
      const expired = (await this.debugger.traceFlags(this.org)).filter((flag) => new Date(flag.expires).getTime() < Date.now());
      if (!expired.length) {
        this.toast('info', 'There are no expired trace flags.');
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete ${expired.length} expired trace flag${expired.length === 1 ? '' : 's'}?`,
        { modal: true, detail: 'They no longer record anything. Active trace flags are kept.' },
        'Delete'
      );
      if (choice !== 'Delete') {
        return;
      }
      let deleted = 0;
      for (let i = 0; i < expired.length; i += 5) {
        const batch = await Promise.allSettled(expired.slice(i, i + 5).map((flag) => this.debugger.deleteFlag(this.org, flag.id)));
        deleted += batch.filter((result) => result.status === 'fulfilled').length;
      }
      this.log(`Deleted ${deleted} expired trace flag(s).`);
      this.toast(deleted === expired.length ? 'ok' : 'bad', `Deleted ${deleted} of ${expired.length} expired trace flags.`);
    } catch (error) {
      this.fail('Could not delete the expired trace flags.', error);
    }
    await this.refreshTrace();
  }

  findLog(id) {
    const entry = this.logs.get(this.org);
    return entry && entry.items.find((item) => item.id === id);
  }

  async openLog(id, quiet) {
    this.post('detail', { detail: { loading: true } });
    try {
      const summary = await this.summary(id);
      this.post('detail', { detail: { log: this.findLog(id) || { id }, summary } });
    } catch (error) {
      if (quiet) {
        this.post('detail', { detail: { missing: true } });
        return;
      }
      this.post('detail', { detail: { error: `Could not read this log. ${error.message}` } });
      this.log(`FAILED: could not read log ${id}. ${error.message}`);
    }
  }

  // Opens the page on one log of one org, for the sidebar's "Show Summary".
  async showLog(org, id) {
    if (org && org !== this.org) {
      this.org = org;
      await this.context.workspaceState.update(ORG_KEY, org);
      if (this.panel) {
        await this.sendOrgs();
        this.loadOrgData();
      }
    }
    if (!this.panel) {
      // A new page cannot take messages until it says it is ready.
      this.pendingLog = id;
      await this.open('logs');
      return;
    }
    await this.open('logs');
    await this.openLog(id);
  }

  async openInEditor(id) {
    try {
      const document = await vscode.workspace.openTextDocument(await this.logFile(id));
      await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      if (await moveToNewWindow()) {
        await maximize();
      }
    } catch (error) {
      this.fail('Could not open the log.', error);
    }
  }

  async replay(id) {
    try {
      const uri = vscode.Uri.file(await this.logFile(id));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false, viewColumn: vscode.ViewColumn.Beside });
      await vscode.commands.executeCommand(REPLAY_COMMAND, uri);
    } catch (error) {
      this.fail('Could not start the Apex Replay Debugger.', error);
    }
  }

  async deleteLogs(message) {
    const all = !!message.all;
    const count = all ? 0 : (message.ids || []).length;
    if (!all && !count) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      all ? 'Delete every debug log in this org?' : count === 1 ? 'Delete this debug log?' : `Delete the ${count} debug logs shown?`,
      { modal: true, detail: all ? 'This removes the logs for all users, not only yours. It cannot be undone.' : count === 1 ? 'It cannot be undone.' : 'Only the logs in the list as it is filtered now. It cannot be undone.' },
      'Delete',
      DELETE_WITH_FILES
    );
    if (choice !== 'Delete' && choice !== DELETE_WITH_FILES) {
      return;
    }
    try {
      const ids = all ? await this.debugger.allLogIds(this.org) : message.ids;
      const deleted = await this.debugger.deleteLogs(this.org, ids);
      let removed = 0;
      if (choice === DELETE_WITH_FILES) {
        removed = await this.removeDownloadedLogs(all ? undefined : ids);
      }
      this.toast('ok', `Deleted ${deleted} log${deleted === 1 ? '' : 's'}${choice === DELETE_WITH_FILES ? ` and ${removed} downloaded cop${removed === 1 ? 'y' : 'ies'}` : ''}.`);
      this.log(`Deleted ${deleted} debug log(s).`);
      this.post('detail', { detail: null });
    } catch (error) {
      this.fail('Could not delete logs.', error);
    }
    await this.refreshLogs();
  }

  // Downloaded copies in the project's log folder: the given log ids, or every
  // .log file there when `ids` is undefined. Returns how many were removed.
  async removeDownloadedLogs(ids) {
    const folder = logFolder(this.context);
    let names;
    try {
      names = (await fs.promises.readdir(folder)).filter((name) => /\.log$/i.test(name));
    } catch {
      return 0;
    }
    const wanted = ids && new Set(ids.map((id) => `${id}.log`.toLowerCase()));
    let removed = 0;
    for (const name of names) {
      if (!wanted || wanted.has(name.toLowerCase())) {
        try {
          await fs.promises.unlink(path.join(folder, name));
          removed++;
        } catch (error) {
          this.log(`FAILED: could not remove ${name}. ${error.message}`);
        }
      }
    }
    return removed;
  }

  async runApex(code) {
    const org = this.org;
    this.post('apex', { apex: { running: true } });
    await this.context.workspaceState.update(APEX_KEY, code);
    try {
      let note = '';
      const mine = await this.refreshTrace();
      if (!mine) {
        await this.debugger.startLogging(org, 15, 'Standard');
        note = 'Debug logging was off, so Sales Grid switched it on for 15 minutes.';
        this.refreshTrace();
      }
      const started = Date.now();
      const result = await this.debugger.executeAnonymous(org, code);
      this.log(`Ran anonymous Apex in ${org}: ${result.success ? 'success' : result.compiled ? 'failed' : 'did not compile'}.`);
      let logId;
      let summary;
      if (result.compiled) {
        // The log appears a moment after the run.
        const me = await this.debugger.userId(org);
        for (let attempt = 0; attempt < 6 && !logId; attempt++) {
          const logs = await this.debugger.listLogs(org, 5);
          const fresh = logs.find((log) => log.userId === me && new Date(log.start).getTime() >= started - 60000);
          if (fresh) {
            logId = fresh.id;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
        }
        if (logId) {
          summary = await this.summary(logId);
        } else {
          note = `${note} No log arrived for this run.`.trim();
        }
        this.refreshLogs(true);
      }
      this.post('apex', { apex: { result, note, logId, summary } });
    } catch (error) {
      this.post('apex', { apex: { error: error.message } });
      this.log(`FAILED: could not run anonymous Apex. ${error.message}`);
    }
  }

  async resetConfig() {
    const choice = await vscode.window.showWarningMessage(
      'Reset every Sales Grid setting to its default?',
      { modal: true, detail: 'Pinned orgs and colour labels are kept.' },
      'Reset'
    );
    if (choice !== 'Reset') {
      return;
    }
    const config = vscode.workspace.getConfiguration('salesgrid');
    for (const key of configModel.allKeys()) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    this.post('config', { config: configModel.readState() });
    this.toast('ok', 'Settings reset.');
  }

  dispose() {
    if (this.panel) {
      this.panel.dispose();
    }
  }
}

module.exports = { SalesGridPage, logFolder, logOrg, downloadLog };
