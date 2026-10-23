const vscode = require('vscode');
const sfCli = require('./sfCli');
const { SfApi } = require('./sfApi');
const { Debugger } = require('./debug');
const { SalesGridPage } = require('./salesGridPage');
const executionView = require('./executionView');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveComponent, comparableSource, setupPath, userSetupPath } = require('./component');

const ORG_URI_SCHEME = 'salesgrid-org';
const ORG_FILE_SCHEME = 'salesgrid-orgfile';
const FAVOURITES_KEY = 'salesgrid.favourites';
const LABELS_KEY = 'salesgrid.labels';
const FILE_ORG_KEY = 'salesgrid.fileOrg';
const FILE_INFO_TTL_MS = 5 * 60 * 1000;
const ORG_LIST_CACHE_KEY = 'salesgrid.orgListCache';
const FILE_INFO_STORE_KEY = 'salesgrid.fileInfoStore';
const FILE_INFO_STORE_SIZE = 300;
const USER_ID = /^[a-zA-Z0-9]{15,18}$/;
// An org's connection status can go stale while VS Code sits in the background.
const ORG_LIST_STALE_MS = 10 * 60 * 1000;
const RECHECK_MIN_MS = 15 * 1000;
// After a save, a deploy-on-save usually lands within these delays.
const AFTER_SAVE_CHECKS_MS = [5000, 15000, 40000];

const COLOURS = {
  red: { label: 'Red', theme: 'charts.red' },
  orange: { label: 'Orange', theme: 'charts.orange' },
  yellow: { label: 'Yellow', theme: 'charts.yellow' },
  green: { label: 'Green', theme: 'charts.green' },
  blue: { label: 'Blue', theme: 'charts.blue' },
  purple: { label: 'Purple', theme: 'charts.purple' }
};

function config() {
  return vscode.workspace.getConfiguration('salesgrid');
}

// Whether the developer wants `field` shown in `place`: 'footer' (status bar),
// 'aboveFile' (links above line 1).
function shows(place, field) {
  return config().get(`${place}.${field}`) !== false;
}

// Whether an optional feature is switched on in the configuration page.
function feature(name) {
  return config().get(`features.${name}`) !== false;
}

function cliPath() {
  return config().get('cliPath') || 'sf';
}

// The CLI resolves the default org and local source files relative to the project.
function projectCwd(uri) {
  const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
  const first = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  const chosen = folder || first;
  return chosen ? chosen.uri.fsPath : undefined;
}

function orgName(org) {
  return org.alias || org.username;
}

function isConnected(org) {
  return !org.isExpired && /^(connected|active)$/i.test(org.status);
}

function expiryText(org) {
  if (org.daysLeft === undefined) {
    return '';
  }
  if (org.isExpired) {
    return 'expired';
  }
  return org.daysLeft === 1 ? '1 day left' : `${org.daysLeft} days left`;
}

function isExpiringSoon(org) {
  const threshold = config().get('expiryWarningDays');
  return org.daysLeft !== undefined && !org.isExpired && org.daysLeft <= (typeof threshold === 'number' ? threshold : 7);
}

function formatDate(value) {
  // Salesforce sends "+0000"; make the offset ISO-8601 before parsing.
  const date = new Date(String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Line endings and trailing blank lines differ between Windows checkouts and
// the org without the code being different.
function normaliseSource(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

// 'same' | 'different' | 'missing' (file not in the org), or undefined when
// this kind of file cannot be compared.
function syncState(text, info) {
  if (!info || info.orgSource === undefined) {
    return undefined;
  }
  if (info.orgSource === null) {
    return 'missing';
  }
  return normaliseSource(text) === normaliseSource(info.orgSource) ? 'same' : 'different';
}

// Test coverage of a class or trigger in the org, ready to display, or
// undefined for types that have none.
function coverageSummary(info) {
  if (!info || info.coverage === undefined) {
    return undefined;
  }
  const total = info.coverage ? info.coverage.covered + info.coverage.uncovered : 0;
  if (!total) {
    return { text: 'no data', detail: 'No test has run against it in the org yet', low: false };
  }
  const percent = Math.floor((info.coverage.covered / total) * 100);
  return { text: `${percent}%`, detail: `${info.coverage.covered} of ${total} lines covered`, low: percent < 75 };
}

// Favourites and colour labels, remembered across sessions.
class OrgPrefs {
  constructor(context) {
    this.state = context.globalState;
  }

  isFavourite(org) {
    return this.state.get(FAVOURITES_KEY, []).includes(org.username);
  }

  async setFavourite(org, on) {
    const others = this.state.get(FAVOURITES_KEY, []).filter((name) => name !== org.username);
    await this.state.update(FAVOURITES_KEY, on ? [...others, org.username] : others);
  }

  // Production is red unless the developer picked something else.
  colour(org) {
    const chosen = this.state.get(LABELS_KEY, {})[org.username];
    if (chosen === 'none') {
      return undefined;
    }
    return chosen || (org.isProduction ? 'red' : undefined);
  }

  async setColour(org, key) {
    const labels = { ...this.state.get(LABELS_KEY, {}) };
    if (key) {
      labels[org.username] = key;
    } else {
      delete labels[org.username];
    }
    await this.state.update(LABELS_KEY, labels);
  }
}

class OrgItem extends vscode.TreeItem {
  constructor(org, prefs) {
    super(orgName(org), vscode.TreeItemCollapsibleState.None);
    const favourite = prefs.isFavourite(org);
    const colour = prefs.colour(org);
    this.org = org;
    this.contextValue = ['org', isConnected(org) ? 'authOk' : 'authBad', favourite ? 'isFav' : 'notFav'].join(' ');
    this.resourceUri = orgUri(org);
    this.description = [
      org.alias ? org.username : '',
      org.isDevHub ? `${org.type} · Dev Hub` : org.type,
      org.isDefault ? 'default' : '',
      expiryText(org)
    ]
      .filter(Boolean)
      .join(' · ');
    this.iconPath = iconFor(org, favourite, colour);
    this.tooltip = tooltipFor(org, favourite);
  }
}

function orgUri(org) {
  return vscode.Uri.from({ scheme: ORG_URI_SCHEME, path: `/${org.username}` });
}

function iconFor(org, favourite, colour) {
  if (!isConnected(org)) {
    return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
  }
  if (isExpiringSoon(org)) {
    return new vscode.ThemeIcon('watch', new vscode.ThemeColor('list.warningForeground'));
  }
  const themeColour = colour ? new vscode.ThemeColor(COLOURS[colour].theme) : undefined;
  return new vscode.ThemeIcon(favourite ? 'star-full' : 'cloud', themeColour);
}

function tooltipFor(org, favourite) {
  const lines = [
    `**${orgName(org)}**${org.isProduction ? ' — PRODUCTION' : ''}`,
    '',
    `Username: ${org.username}`,
    `Type: ${org.type}${org.isDevHub ? ' (Dev Hub)' : ''}`,
    `Status: ${org.isExpired ? 'Expired' : org.status}`
  ];
  if (org.edition) {
    lines.push(`Edition: ${org.edition}`);
  }
  if (org.instanceUrl) {
    lines.push(`Instance: ${org.instanceUrl}`);
  }
  if (org.orgId) {
    lines.push(`Org ID: ${org.orgId}`);
  }
  if (org.expirationDate) {
    lines.push(`Expires: ${formatDate(org.expirationDate)} (${expiryText(org)})`);
  }
  if (org.isDefault) {
    lines.push('Default org');
  }
  if (org.isDefaultDevHub) {
    lines.push('Default Dev Hub');
  }
  if (favourite) {
    lines.push('Pinned to top');
  }
  return new vscode.MarkdownString(lines.join('  \n'));
}

class OrgProvider {
  constructor(output, prefs) {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._onDidChangeFileDecorations = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
    this._onDidLoad = new vscode.EventEmitter();
    this.onDidLoad = this._onDidLoad.event;
    this.output = output;
    this.prefs = prefs;
    this.orgs = undefined;
    this.loading = undefined;
    this.failed = false;
    this.loadedAt = 0;
    this.warned = new Set();
  }

  // Re-reads the org list from the CLI.
  refresh() {
    this.orgs = undefined;
    this.loading = undefined;
    this.failed = false;
    this.redraw();
  }

  // Repaints with the orgs already loaded, after a pin or colour change.
  redraw() {
    this._onDidChangeTreeData.fire();
    this._onDidChangeFileDecorations.fire(undefined);
  }

  getTreeItem(item) {
    return item;
  }

  async getChildren(element) {
    if (element) {
      return [];
    }
    const orgs = await this.load();
    // Pinned orgs first; expired or unreachable orgs last, even if pinned.
    const rank = (org) => (!isConnected(org) ? 2 : this.prefs.isFavourite(org) ? 0 : 1);
    return [...orgs].sort((a, b) => rank(a) - rank(b)).map((org) => new OrgItem(org, this.prefs));
  }

  load() {
    if (this.orgs) {
      return Promise.resolve(this.orgs);
    }
    // Stay failed until the developer refreshes, instead of retrying on every repaint.
    if (this.failed) {
      return Promise.resolve([]);
    }
    // At start-up, show the list from last time straight away (the CLI takes
    // a few seconds to answer) and replace it when the fresh one arrives.
    const remembered = !this.usedRemembered && this.prefs.state.get(ORG_LIST_CACHE_KEY);
    if (remembered && remembered.length) {
      this.usedRemembered = true;
      this.orgs = remembered;
      this.loading = this.fetch(true);
      return Promise.resolve(this.orgs);
    }
    if (!this.loading) {
      this.loading = this.fetch();
    }
    return this.loading;
  }

  async fetch(behindRemembered) {
    try {
      this.orgs = await sfCli.listOrgs(cliPath(), { cwd: projectCwd() });
      this.loadedAt = Date.now();
      log(this.output, `Loaded ${this.orgs.length} connected org(s).`);
      this.warnAboutExpiry(this.orgs);
      this.prefs.state.update(ORG_LIST_CACHE_KEY, this.orgs);
      if (behindRemembered) {
        this.redraw();
      }
      return this.orgs;
    } catch (error) {
      if (behindRemembered) {
        // Keep showing the remembered list; it is better than nothing.
        log(this.output, `FAILED: could not refresh the org list. ${error.message}`);
        return this.orgs;
      }
      this.failed = true;
      reportFailure(this.output, 'could not load the org list.', error, { retry: () => this.refresh() });
      return [];
    } finally {
      this.loading = undefined;
      this._onDidLoad.fire();
    }
  }

  // One warning per org per session, not one on every refresh.
  warnAboutExpiry(orgs) {
    const expiring = orgs.filter((org) => isExpiringSoon(org) && !this.warned.has(org.username));
    if (!expiring.length) {
      return;
    }
    expiring.forEach((org) => this.warned.add(org.username));
    const summary = expiring.map((org) => `${orgName(org)} (${org.type}, ${expiryText(org)})`).join(', ');
    log(this.output, `Expiring soon: ${summary}`);
    vscode.window.showWarningMessage(`Sales Grid: expiring soon — ${summary}.`);
  }

  provideFileDecoration(uri) {
    if (uri.scheme !== ORG_URI_SCHEME || !this.orgs) {
      return undefined;
    }
    const org = this.orgs.find((candidate) => `/${candidate.username}` === uri.path);
    if (!org) {
      return undefined;
    }
    const colour = this.prefs.colour(org);
    if (!colour && !org.isProduction) {
      return undefined;
    }
    return {
      badge: org.isProduction ? 'P' : undefined,
      tooltip: org.isProduction ? 'Production org' : undefined,
      color: colour ? new vscode.ThemeColor(COLOURS[colour].theme) : undefined
    };
  }
}

// Notices logins, logouts, alias changes and a new default org made outside
// Sales Grid (in a terminal, or by another extension) and reloads the org list.
class OrgListWatcher {
  constructor(provider) {
    this.provider = provider;
    this.authDir = path.join(os.homedir(), '.sfdx');
    this.last = this.signature();
    this.timer = undefined;
    try {
      this.watcher = fs.watch(this.authDir, () => this.checkSoon());
      this.watcher.on('error', () => {});
    } catch (error) {
      // No auth folder yet; the periodic check below still covers it.
      this.watcher = undefined;
    }
  }

  // The CLI rewrites auth files whenever it refreshes a token, so file
  // contents are ignored: only which orgs exist, their aliases and the
  // default-org settings count as a change.
  signature() {
    const parts = [];
    try {
      parts.push(...fs.readdirSync(this.authDir).filter((name) => /@.+\.json$/.test(name)).sort());
    } catch (error) {
      parts.push('no-auth-dir');
    }
    const folders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
    const settings = [
      path.join(this.authDir, 'alias.json'),
      path.join(this.authDir, 'sfdx-config.json'),
      path.join(os.homedir(), '.sf', 'config.json'),
      ...folders.flatMap((folder) => [path.join(folder, '.sf', 'config.json'), path.join(folder, '.sfdx', 'sfdx-config.json')])
    ];
    for (const file of settings) {
      try {
        parts.push(`${file}:${fs.statSync(file).mtimeMs}`);
      } catch (error) {
        parts.push(`${file}:none`);
      }
    }
    return parts.join('|');
  }

  checkSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.check(), 2000);
  }

  check() {
    if (this.provider.loading) {
      return;
    }
    const now = this.signature();
    const stale = this.provider.loadedAt && Date.now() - this.provider.loadedAt > ORG_LIST_STALE_MS;
    if (now !== this.last || stale) {
      this.last = now;
      // Nothing has asked for the list yet, so there is nothing on screen to update.
      if (this.provider.orgs || this.provider.failed) {
        this.provider.refresh();
      }
    }
  }

  dispose() {
    clearTimeout(this.timer);
    if (this.watcher) {
      this.watcher.close();
    }
  }
}

// Commands run from the tree get the clicked item; from the Command Palette
// they get nothing, so ask which org is meant.
async function resolveOrg(provider, item) {
  if (item && item.org) {
    return item.org;
  }
  return pickOrg(provider, 'Select an org');
}

async function pickOrg(provider, placeHolder) {
  const orgs = await provider.load();
  if (!orgs.length) {
    vscode.window.showInformationMessage('Sales Grid: no connected orgs found.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    orgs.map((org) => ({
      label: orgName(org),
      description: org.alias ? org.username : '',
      detail: `${org.type} · ${org.isExpired ? 'Expired' : org.status}`,
      org
    })),
    { placeHolder }
  );
  return picked && picked.org;
}

function withProgress(title, task) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    task
  );
}

// Every success and failure is written here so the developer can see what
// the CLI actually said, not just the one-line notification.
function log(output, message) {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function looksLikeAuthFailure(error) {
  return /expired|invalid_grant|no authorization|refresh token|session|not authenticated|INVALID_LOGIN/i.test(error.message);
}

// `actions.retry` reruns the operation; `actions.login` offers a fresh login
// when the failure looks like a dead session.
async function reportFailure(output, summary, error, actions = {}) {
  log(output, `FAILED: ${summary} ${error.message}`);
  const buttons = [];
  if (actions.login && looksLikeAuthFailure(error)) {
    buttons.push('Log In Again');
  }
  if (actions.retry) {
    buttons.push('Retry');
  }
  buttons.push('Show Log');
  const choice = await vscode.window.showErrorMessage(`Sales Grid: ${summary} ${error.message}`, ...buttons);
  if (choice === 'Log In Again') {
    actions.login();
  } else if (choice === 'Retry') {
    actions.retry();
  } else if (choice === 'Show Log') {
    output.show(true);
  }
}

// The URL is passed as text on purpose: turning it into a Uri first re-encodes
// the query and breaks deep links such as the Setup user page.
async function launch(url) {
  let opened;
  try {
    opened = await vscode.env.openExternal(url);
  } catch (error) {
    opened = await vscode.env.openExternal(vscode.Uri.parse(url, true));
  }
  if (!opened) {
    throw new Error('The browser was not launched. Use Copy Open URL and paste it into a browser instead.');
  }
}

// Runs the login in a terminal so the developer can watch it, and resolves
// with the CLI's exit code once the browser login finishes or is cancelled.
function runLoginTask(org) {
  const args = ['org', 'login', 'web', '--instance-url', org.instanceUrl || org.loginUrl];
  if (org.alias) {
    args.push('--alias', org.alias);
  }
  if (org.isDefault) {
    args.push('--set-default');
  }
  const task = new vscode.Task(
    { type: 'shell' },
    vscode.TaskScope.Workspace,
    `Log in to ${orgName(org)}`,
    'Sales Grid',
    new vscode.ShellExecution(cliPath(), args)
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: false, clear: true };

  return new Promise((resolve, reject) => {
    let execution;
    const listeners = [];
    const finish = (exitCode) => {
      listeners.forEach((listener) => listener.dispose());
      resolve(exitCode);
    };
    listeners.push(
      vscode.tasks.onDidEndTaskProcess((event) => {
        if (event.execution === execution) {
          finish(event.exitCode);
        }
      }),
      // Fires without a process event when the task could not start at all.
      vscode.tasks.onDidEndTask((event) => {
        if (event.execution === execution) {
          setTimeout(() => finish(undefined), 200);
        }
      })
    );
    vscode.tasks.executeTask(task).then(
      (started) => {
        execution = started;
      },
      (error) => {
        listeners.forEach((listener) => listener.dispose());
        reject(error);
      }
    );
  });
}

class Controller {
  constructor(context, output, prefs, provider) {
    this.context = context;
    this.output = output;
    this.prefs = prefs;
    this.provider = provider;
    this.fileInfoCache = new Map();
    this.orgSources = new Map();
    this.mismatchShown = new Set();
    this.openedVersion = new Map();
    this.checking = new Set();
    this.saveTimers = [];
    this._onDidChangeFileInfo = new vscode.EventEmitter();
    this.onDidChangeFileInfo = this._onDidChangeFileInfo.event;
    this._onDidChangeOrgSource = new vscode.EventEmitter();
    // Serves the org's copy of a file to the diff editor.
    this.orgFileProvider = {
      onDidChange: this._onDidChangeOrgSource.event,
      provideTextDocumentContent: (uri) => this.orgSources.get(uri.query) || ''
    };
  }

  async openOrg(org) {
    const name = orgName(org);
    try {
      await withProgress(`Opening ${name}...`, async () => {
        await launch(await sfCli.getOpenUrl(cliPath(), org.username));
      });
      log(this.output, `Opened ${name} (${org.username}) in the browser.`);
      vscode.window.showInformationMessage(`Sales Grid: opened ${name} in your browser.`);
    } catch (error) {
      reportFailure(this.output, `could not open ${name}.`, error, {
        retry: () => this.openOrg(org),
        login: () => this.reauthorize(org)
      });
    }
  }

  async copyOpenUrl(org) {
    const name = orgName(org);
    try {
      const url = await withProgress(`Getting open URL for ${name}...`, () =>
        sfCli.getOpenUrl(cliPath(), org.username)
      );
      await vscode.env.clipboard.writeText(url);
      log(this.output, `Copied open URL for ${name} (${org.username}).`);
      vscode.window.showInformationMessage(
        `Sales Grid: open URL for ${name} copied. It logs in without a password, so share it carefully.`
      );
    } catch (error) {
      reportFailure(this.output, `could not get the URL for ${name}.`, error, {
        retry: () => this.copyOpenUrl(org),
        login: () => this.reauthorize(org)
      });
    }
  }

  async reauthorize(org) {
    const name = orgName(org);
    if (org.type === 'Scratch' && org.isExpired) {
      vscode.window.showErrorMessage(
        `Sales Grid: ${name} is an expired scratch org and cannot be logged in to again. Create a new scratch org.`
      );
      return;
    }
    if (!/^https:\/\//i.test(org.instanceUrl || org.loginUrl || '')) {
      vscode.window.showErrorMessage(`Sales Grid: no login address is known for ${name}. Run "sf org login web" manually.`);
      return;
    }
    try {
      log(this.output, `Logging in to ${name} again. Finish the login in the browser.`);
      const exitCode = await withProgress(`Log in to ${name} in the browser that just opened...`, () =>
        runLoginTask(org)
      );
      if (exitCode !== 0) {
        throw new Error(
          exitCode === undefined
            ? 'The login did not start. See the terminal for details.'
            : `The login did not finish (exit code ${exitCode}). See the terminal for details.`
        );
      }
      this.api.forget(org.username);
      log(this.output, `Logged in to ${name} again.`);
      vscode.window.showInformationMessage(`Sales Grid: logged in to ${name} again.`);
      this.invalidateFileInfo();
      this.provider.refresh();
    } catch (error) {
      reportFailure(this.output, `could not log in to ${name}.`, error, { retry: () => this.reauthorize(org) });
    }
  }

  // Only for orgs that can no longer be used, and only after the developer confirms.
  async removeOrg(org) {
    const name = orgName(org);
    if (isConnected(org)) {
      vscode.window.showInformationMessage(
        `Sales Grid: ${name} is still connected. Only expired or unreachable orgs can be removed here.`
      );
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Remove ${name} from Sales Grid?`,
      {
        modal: true,
        detail: `This deletes the saved login for ${org.username} from this computer. The org itself is not changed. To use it again you would have to log in again.`
      },
      'Remove'
    );
    if (choice !== 'Remove') {
      log(this.output, `Remove cancelled for ${name}.`);
      return;
    }
    try {
      await withProgress(`Removing ${name}...`, () => sfCli.logout(cliPath(), org.username, { cwd: projectCwd() }));
      await this.prefs.setFavourite(org, false);
      await this.prefs.setColour(org, undefined);
      this.api.forget(org.username);
      log(this.output, `Removed ${name} (${org.username}).`);
      vscode.window.showInformationMessage(`Sales Grid: removed ${name}.`);
      this.invalidateFileInfo();
      this.provider.refresh();
    } catch (error) {
      reportFailure(this.output, `could not remove ${name}.`, error, { retry: () => this.removeOrg(org) });
    }
  }

  async setFavourite(org, on) {
    await this.prefs.setFavourite(org, on);
    this.provider.redraw();
  }

  async chooseColour(org) {
    const current = this.prefs.colour(org);
    const items = [
      { label: 'Automatic', description: 'Red for production, none otherwise', key: undefined },
      { label: 'None', description: 'Never colour this org', key: 'none' },
      ...Object.keys(COLOURS).map((key) => ({
        label: COLOURS[key].label,
        description: key === current ? 'current' : '',
        key
      }))
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Colour label for ${orgName(org)}`
    });
    if (picked) {
      await this.prefs.setColour(org, picked.key);
      this.provider.redraw();
    }
  }

  // The org used for the open file: the one the developer picked for this
  // workspace, else the project's default org, else the only org there is.
  async fileOrg() {
    return this.fileOrgFrom(await this.provider.load());
  }

  fileOrgFrom(orgs) {
    const chosen = this.context.workspaceState.get(FILE_ORG_KEY);
    return (
      orgs.find((org) => org.username === chosen) ||
      orgs.find((org) => org.isDefault) ||
      (orgs.length === 1 ? orgs[0] : undefined)
    );
  }

  async selectFileOrg() {
    const org = await pickOrg(this.provider, 'Org to use for the current file');
    if (org) {
      await this.context.workspaceState.update(FILE_ORG_KEY, org.username);
      this.invalidateFileInfo();
    }
    return org;
  }

  invalidateFileInfo() {
    this.fileInfoCache.clear();
    this._onDidChangeFileInfo.fire();
  }

  fileKey(component, org, uri) {
    const source = comparableSource(uri.fsPath, component);
    return [org.username, component.type, component.name, source && source.filePath].join('|');
  }

  // Notices a deploy made from anywhere: asks the org when the current
  // component was last modified and, only if that moved, re-reads its details
  // in the background. What is on screen stays until the new details arrive.
  async checkForOrgChange(force = false) {
    const file = currentFile();
    const orgs = this.provider.orgs;
    const org = orgs && this.fileOrgFrom(orgs);
    if (!file || !file.component.object || !org) {
      return;
    }
    const { component, uri } = file;
    const key = this.fileKey(component, org, uri);
    const entry = this.fileInfoCache.get(key);
    if (!entry || !entry.done || entry.error || this.checking.has(key)) {
      return;
    }
    // Switching between tabs must not turn into a stream of requests.
    if (!force && Date.now() - entry.at < RECHECK_MIN_MS) {
      return;
    }
    this.checking.add(key);
    try {
      const options = { cwd: projectCwd(uri) };
      const lastModified = await sfCli.queryLastModified(cliPath(), org.username, component, options);
      const known = entry.info ? entry.info.lastModifiedDate : null;
      if (lastModified === known) {
        entry.at = Date.now();
        return;
      }
      const source = comparableSource(uri.fsPath, component);
      const info = await this.loadFileInfo(component, org, uri, source);
      if (this.fileInfoCache.get(key) !== entry) {
        return;
      }
      this.fileInfoCache.set(key, { at: Date.now(), done: true, info, error: undefined, promise: Promise.resolve() });
      log(this.output, `${component.name} changed in ${orgName(org)}; details updated.`);
      this._onDidChangeFileInfo.fire();
    } catch (error) {
      log(this.output, `FAILED: could not check ${component.name} for changes in ${orgName(org)}. ${error.message}`);
    } finally {
      this.checking.delete(key);
    }
  }

  checkAfterSave() {
    this.saveTimers.forEach((timer) => clearTimeout(timer));
    this.saveTimers = AFTER_SAVE_CHECKS_MS.map((delay) => setTimeout(() => this.checkForOrgChange(true), delay));
  }

  dispose() {
    this.saveTimers.forEach((timer) => clearTimeout(timer));
  }

  // Starts, or reuses, the lookup of a file's component in the org. The entry
  // comes back at once so the caller can show a spinner until `done` is set.
  fileEntry(component, org, uri) {
    const source = comparableSource(uri.fsPath, component);
    const key = this.fileKey(component, org, uri);
    const cached = this.fileInfoCache.get(key);
    if (cached && Date.now() - cached.at < FILE_INFO_TTL_MS) {
      return cached;
    }
    // Details remembered from an earlier session are shown at once while the
    // org is asked again; the code comparison waits for the fresh answer.
    const remembered = cached ? undefined : this.rememberedInfo(key);
    const entry = { at: Date.now(), done: !!remembered, info: remembered, error: undefined };
    entry.promise = this.loadFileInfo(component, org, uri, source)
      .then(
        (info) => {
          entry.info = info;
          this.rememberInfo(key, info);
        },
        (error) => {
          if (!remembered) {
            entry.error = error;
          }
          log(this.output, `FAILED: could not read ${component.name} from ${orgName(org)}. ${error.message}`);
        }
      )
      .then(() => {
        entry.done = true;
        this._onDidChangeFileInfo.fire();
      });
    this.fileInfoCache.set(key, entry);
    return entry;
  }

  rememberedInfo(key) {
    const store = this.context.workspaceState.get(FILE_INFO_STORE_KEY, {});
    return store[key] ? { ...store[key] } : undefined;
  }

  // Keeps the small part of the details (not the code) for next time.
  rememberInfo(key, info) {
    const store = { ...this.context.workspaceState.get(FILE_INFO_STORE_KEY, {}) };
    delete store[key];
    if (info) {
      const { body, orgSource, ...small } = info;
      store[key] = small;
    }
    const keys = Object.keys(store);
    keys.slice(0, Math.max(0, keys.length - FILE_INFO_STORE_SIZE)).forEach((old) => delete store[old]);
    this.context.workspaceState.update(FILE_INFO_STORE_KEY, store);
  }

  // `orgSource` on the result is the org's copy of this exact file: a string,
  // null when the org has no such file, undefined when it cannot be compared.
  async loadFileInfo(component, org, uri, source) {
    const options = { cwd: projectCwd(uri) };
    const info = await sfCli.queryComponentInfo(cliPath(), org.username, component, options);
    if (!info) {
      return null;
    }
    if (source && source.kind === 'body') {
      info.orgSource = info.body;
    }
    const [lwcSource, coverage] = await Promise.all([
      source && source.kind === 'lwc' ? sfCli.queryLwcSource(cliPath(), org.username, info.id, source.filePath, options) : undefined,
      // Coverage is a bonus: without it the rest is still worth showing.
      component.coverage
        ? sfCli.queryCoverage(cliPath(), org.username, info.id, options).catch((error) => {
            log(this.output, `FAILED: could not read test coverage of ${component.name} from ${orgName(org)}. ${error.message}`);
            return undefined;
          })
        : undefined
    ]);
    if (source && source.kind === 'lwc') {
      info.orgSource = lwcSource;
    }
    if (component.coverage) {
      info.coverage = coverage;
    }
    return info;
  }

  async fileInfo(component, org, uri) {
    const entry = this.fileEntry(component, org, uri);
    await entry.promise;
    if (entry.error) {
      throw entry.error;
    }
    return entry.info;
  }

  // Switches the trigger or flow in the open file on or off in the org,
  // after the developer confirms.
  async toggleActive(uri) {
    const file = uri ? { uri, component: uri.scheme === 'file' ? resolveComponent(uri.fsPath) : undefined } : currentFile();
    const component = file && file.component;
    if (!feature('activateDeactivate')) {
      vscode.window.showInformationMessage('Sales Grid: activating and deactivating is switched off. Turn it on in Sales Grid: Open Configuration.');
      return;
    }
    if (!component || !component.statusField) {
      vscode.window.showInformationMessage('Sales Grid: open an Apex trigger or a Flow first. Only those can be activated or deactivated.');
      return;
    }
    const target = file.uri;
    const org = (await this.fileOrg()) || (await this.selectFileOrg());
    if (!org) {
      return;
    }
    const name = orgName(org);
    const what = `${component.label} ${component.name}`;
    const options = { cwd: projectCwd(target) };
    const retry = { retry: () => this.toggleActive(target), login: () => this.reauthorize(org) };

    // Ask the org now: the cached answer may be minutes old.
    let info;
    let flow;
    try {
      info = await withProgress(`Checking ${component.name} in ${name}...`, async () => {
        this.fileInfoCache.clear();
        const fresh = await this.fileInfo(component, org, target);
        if (fresh && component.type === 'Flow') {
          flow = await sfCli.getFlowVersions(cliPath(), org.username, fresh.id, options);
        }
        return fresh;
      });
    } catch (error) {
      reportFailure(this.output, `could not check ${what} in ${name}.`, error, retry);
      return;
    }
    this._onDidChangeFileInfo.fire();
    if (!info) {
      vscode.window.showErrorMessage(`Sales Grid: ${what} does not exist in ${name}. Deploy it first.`);
      return;
    }
    const activate = !info.active;
    if (activate && flow && !flow.latestVersion) {
      vscode.window.showErrorMessage(`Sales Grid: ${what} has no version in ${name} that can be activated.`);
      return;
    }

    const verb = activate ? 'Activate' : 'Deactivate';
    const details = [];
    if (org.isProduction) {
      details.push(`${name} is a PRODUCTION org.`);
    }
    if (component.type === 'Flow') {
      details.push(
        activate
          ? `Version ${flow.latestVersion}, the latest, becomes the active version.`
          : `Version ${flow.activeVersion} stops being active, so the flow no longer runs.`
      );
    } else {
      details.push(
        activate ? 'The trigger starts running on every matching record change.' : 'The trigger stops running.',
        "Salesforce only allows this through a deployment. The trigger is redeployed with the code already in the org, so your local edits are not sent.",
        org.isProduction ? 'Salesforce runs the Apex tests first, which can take several minutes.' : ''
      );
    }
    const choice = await vscode.window.showWarningMessage(
      `${verb} ${what} in ${name}?`,
      { modal: true, detail: details.filter(Boolean).join('\n\n') },
      verb
    );
    if (choice !== verb) {
      log(this.output, `${verb} cancelled for ${what} in ${name}.`);
      return;
    }

    try {
      await withProgress(`${activate ? 'Activating' : 'Deactivating'} ${component.name} in ${name}...`, async () => {
        if (component.type === 'Flow') {
          await sfCli.setFlowActiveVersion(cliPath(), org.username, info.id, activate ? flow.latestVersion : 0, org.apiVersion, options);
        } else {
          await sfCli.setTriggerActive(cliPath(), org.username, info.id, activate, options);
        }
      });
      const state = activate ? 'active' : 'inactive';
      const localNote = component.type === 'ApexTrigger' && (await this.syncLocalTriggerStatus(target, component, activate));
      log(this.output, `${what} is now ${state} in ${name}.${localNote ? ` ${localNote}` : ''}`);
      vscode.window.showInformationMessage(`Sales Grid: ${what} is now ${state} in ${name}.${localNote ? ` ${localNote}` : ''}`);
    } catch (error) {
      reportFailure(this.output, `could not ${verb.toLowerCase()} ${what} in ${name}.`, error, retry);
    } finally {
      // Whatever happened, show what the org says now, everywhere it is shown.
      this.invalidateFileInfo();
    }
  }

  // Keeps the trigger's local metadata file in step, so the next deploy of the
  // project does not quietly switch the trigger back.
  async syncLocalTriggerStatus(uri, component, active) {
    const metaPath = path.join(path.dirname(uri.fsPath), `${component.name}.trigger-meta.xml`);
    const status = active ? 'Active' : 'Inactive';
    try {
      const xml = await fs.promises.readFile(metaPath, 'utf8');
      const updated = xml.replace(/<status>[^<]*<\/status>/, `<status>${status}</status>`);
      if (updated === xml) {
        return '';
      }
      await fs.promises.writeFile(metaPath, updated);
      return `${path.basename(metaPath)} was updated to match.`;
    } catch (error) {
      return '';
    }
  }

  // Tells the developer once per org version that the open file has drifted.
  notifyMismatch(document, org, info) {
    const key = [document.uri.toString(), org.username, info.lastModifiedDate].join('|');
    // Edited since it was opened: the difference is the developer's own work.
    const editedSinceOpen = this.openedVersion.get(document.uri.toString()) !== document.version;
    if (!feature('mismatchWarning') || document.isDirty || editedSinceOpen || this.mismatchShown.has(key)) {
      return;
    }
    this.mismatchShown.add(key);
    const file = path.basename(document.uri.fsPath);
    log(this.output, `${file} is different from ${orgName(org)}.`);
    vscode.window
      .showWarningMessage(
        `Sales Grid: ${file} is different from ${orgName(org)}. Last changed in the org by ${info.lastModifiedByName} on ${formatDate(info.lastModifiedDate)}.`,
        'Compare'
      )
      .then((choice) => {
        if (choice === 'Compare') {
          this.compareWithOrg(document.uri);
        }
      });
  }

  async compareWithOrg(uri) {
    const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    const component = target && target.scheme === 'file' ? resolveComponent(target.fsPath) : undefined;
    const org = component && ((await this.fileOrg()) || (await this.selectFileOrg()));
    if (!org) {
      return;
    }
    const name = orgName(org);
    const file = path.basename(target.fsPath);
    try {
      const info = await withProgress(`Getting ${file} from ${name}...`, () => this.fileInfo(component, org, target));
      if (!info || typeof info.orgSource !== 'string') {
        vscode.window.showInformationMessage(
          info && info.orgSource === undefined
            ? `Sales Grid: ${file} is a kind of file that cannot be compared with the org.`
            : `Sales Grid: ${file} does not exist in ${name}, so there is nothing to compare.`
        );
        return;
      }
      const key = target.toString();
      const orgCopy = vscode.Uri.from({ scheme: ORG_FILE_SCHEME, path: `/${file}`, query: key });
      this.orgSources.set(key, info.orgSource);
      this._onDidChangeOrgSource.fire(orgCopy);
      await vscode.commands.executeCommand('vscode.diff', orgCopy, target, `${file}: ${name} ↔ Local`);
    } catch (error) {
      reportFailure(this.output, `could not compare ${file} with ${name}.`, error, {
        retry: () => this.compareWithOrg(target),
        login: () => this.reauthorize(org)
      });
    }
  }

  async openFileInOrg(uri) {
    const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    const component = target && target.scheme === 'file' ? resolveComponent(target.fsPath) : undefined;
    if (!component) {
      vscode.window.showInformationMessage(
        'Sales Grid: open an Apex class, trigger, Visualforce page or component, LWC, Aura component, Flow or Lightning Page file first.'
      );
      return;
    }
    const org = (await this.fileOrg()) || (await this.selectFileOrg());
    if (!org) {
      return;
    }
    const name = orgName(org);
    const what = `${component.label} ${component.name}`;
    try {
      await withProgress(`Opening ${component.name} in ${name}...`, async () => {
        const cwd = projectCwd(target);
        let destination;
        if (component.viaCli) {
          destination = { sourceFile: target.fsPath };
        } else {
          const info = await this.fileInfo(component, org, target);
          if (!info) {
            throw new Error(`${what} does not exist in ${name}. Deploy it first.`);
          }
          destination = { path: setupPath(component, info.id) };
        }
        await launch(await sfCli.getOpenUrl(cliPath(), org.username, destination, { cwd }));
      });
      log(this.output, `Opened ${what} in ${name}.`);
      vscode.window.showInformationMessage(`Sales Grid: opened ${what} in ${name}.`);
    } catch (error) {
      reportFailure(this.output, `could not open ${what} in ${name}.`, error, {
        retry: () => this.openFileInOrg(target),
        login: () => this.reauthorize(org)
      });
    }
  }

  async openUser(userId, userName) {
    if (!USER_ID.test(userId || '')) {
      return;
    }
    const org = (await this.fileOrg()) || (await this.selectFileOrg());
    if (!org) {
      return;
    }
    const name = orgName(org);
    const who = userName || userId;
    try {
      await withProgress(`Opening user ${who} in ${name}...`, async () => {
        await launch(
          await sfCli.getOpenUrl(cliPath(), org.username, { path: userSetupPath(userId) }, { cwd: projectCwd() })
        );
      });
      log(this.output, `Opened user ${who} in Setup in ${name}.`);
      vscode.window.showInformationMessage(`Sales Grid: opened user ${who} in Setup in ${name}.`);
    } catch (error) {
      reportFailure(this.output, `could not open user ${who} in ${name}.`, error, {
        retry: () => this.openUser(userId, userName),
        login: () => this.reauthorize(org)
      });
    }
  }
}

let lastFile;

// The component the developer is working on. When focus moves to something
// that is not a file (a chat panel, a web view, the org side of a comparison)
// the last component stays, so its details do not vanish.
function currentFile() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    const component = resolveComponent(editor.document.uri.fsPath);
    lastFile = component ? { uri: editor.document.uri, component, document: editor.document } : undefined;
  }
  return lastFile ? { ...lastFile, text: lastFile.document.getText() } : undefined;
}

// The active status is always readable; it is only clickable while the
// activate / deactivate feature is switched on.
function activeLabel(info, whenActive, whenInactive) {
  const hint = feature('activateDeactivate') ? (info.active ? whenActive : whenInactive) : '';
  return `${info.active ? 'Active' : 'Inactive'}${hint}`;
}

function activeTooltip(component, info, org) {
  const state = `${component.name} is ${info.active ? 'active' : 'not active'} in ${org}.`;
  return feature('activateDeactivate') ? `${state} Click to ${info.active ? 'deactivate' : 'activate'} it.` : state;
}

function toggleCommand(uri) {
  return feature('activateDeactivate')
    ? { command: 'salesgrid.toggleActive', title: 'Activate or Deactivate', arguments: [uri] }
    : undefined;
}


// The same details as clickable links above the first line of the file.
class FileInfoLensProvider {
  constructor(controller) {
    this.controller = controller;
    this._onDidChangeCodeLenses = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  }

  refresh() {
    this._onDidChangeCodeLenses.fire();
  }

  // Returns straight away: a spinner while the org is being asked, then the
  // real links once `refresh` is fired by the finished lookup.
  provideCodeLenses(document) {
    if (!config().get('showFileInfoCodeLens')) {
      return [];
    }
    const component = resolveComponent(document.uri.fsPath);
    if (!component || !component.object) {
      return [];
    }
    const range = new vscode.Range(0, 0, 0, 0);
    const lens = (title, tooltip, command, args) =>
      new vscode.CodeLens(range, { title, tooltip, command: command || '', arguments: args });

    const provider = this.controller.provider;
    if (!provider.orgs) {
      if (provider.failed) {
        return [];
      }
      provider.load();
      return [lens('$(loading~spin) Sales Grid: loading orgs...', 'Reading your connected orgs')];
    }
    const org = this.controller.fileOrgFrom(provider.orgs);
    if (!org) {
      return [];
    }
    const name = orgName(org);
    const entry = this.controller.fileEntry(component, org, document.uri);
    if (!entry.done) {
      return [lens(`$(loading~spin) Sales Grid: checking ${name}...`, `Reading ${component.name} from ${name}`)];
    }
    if (entry.error) {
      return [
        lens(`$(warning) Sales Grid: could not check ${name} · Retry`, entry.error.message, 'salesgrid.refreshFileInfo')
      ];
    }
    const info = entry.info;
    if (!info) {
      return [lens(`$(cloud) Not in ${name} yet · Check again`, 'Deploy it, then check again', 'salesgrid.refreshFileInfo')];
    }

    const lenses = [];
    if (shows('aboveFile', 'openInSalesforce')) {
      lenses.push(
        lens(`$(link-external) Open in Salesforce (${name})`, `Open ${component.name} in ${name}`, 'salesgrid.openFileInOrg', [document.uri])
      );
    }
    const uriKey = document.uri.toString();
    if (!this.controller.openedVersion.has(uriKey)) {
      this.controller.openedVersion.set(uriKey, document.version);
    }
    const state = syncState(document.getText(), info);
    const showComparison = shows('aboveFile', 'codeComparison');
    if (state === 'different') {
      // The warning popup is separate from the link, so it still fires.
      this.controller.notifyMismatch(document, org, info);
    }
    if (showComparison && state === 'same') {
      lenses.push(lens(`$(check) Same as ${name}`, 'Local code matches the org'));
    } else if (showComparison && state === 'different') {
      lenses.push(
        lens(
          `$(warning) Different from ${name} · Compare`,
          'Show the differences between the org and this file',
          'salesgrid.compareWithOrg',
          [document.uri]
        )
      );
    } else if (showComparison && state === 'missing') {
      lenses.push(lens(`$(warning) This file is not in ${name}`, 'Deploy it to add it to the org'));
    }
    if (info.active !== undefined && shows('aboveFile', 'activeStatus')) {
      lenses.push(
        lens(
          `$(${info.active ? 'pass' : 'circle-slash'}) ${activeLabel(info, ' · Deactivate', ' · Activate')}`,
          activeTooltip(component, info, name),
          feature('activateDeactivate') ? 'salesgrid.toggleActive' : undefined,
          [document.uri]
        )
      );
    }
    const coverage = shows('aboveFile', 'testCoverage') ? coverageSummary(info) : undefined;
    if (coverage) {
      lenses.push(
        lens(
          `$(${coverage.low ? 'warning' : 'beaker'}) Coverage ${coverage.text}`,
          `${coverage.detail}. Apex test coverage in ${name}, from its last test runs.`
        )
      );
    }
    if (shows('aboveFile', 'createdBy')) {
      lenses.push(
        lens(
          `$(person) Created by ${info.createdByName} · ${formatDate(info.createdDate)}`,
          `Open ${info.createdByName} in Setup`,
          'salesgrid.openUser',
          [info.createdById, info.createdByName]
        )
      );
    }
    if (shows('aboveFile', 'lastModifiedBy')) {
      lenses.push(
        lens(
          `$(history) Last modified by ${info.lastModifiedByName} · ${formatDate(info.lastModifiedDate)}`,
          `Open ${info.lastModifiedByName} in Setup`,
          'salesgrid.openUser',
          [info.lastModifiedById, info.lastModifiedByName]
        )
      );
    }
    return lenses;
  }
}

// The footer: who created and last changed the current component, always
// visible without opening the Sales Grid panel.
class FileInfoStatusBar {
  constructor(controller) {
    this.controller = controller;
    // Just below zero, so these sit to the right of other extensions' items
    // (such as Salesforce's code coverage button) and never push them out of
    // view. A hair apart, so nothing can be placed between them.
    this.open = vscode.window.createStatusBarItem('salesgrid.openInSalesforce', vscode.StatusBarAlignment.Left, -0.01);
    this.sync = vscode.window.createStatusBarItem('salesgrid.codeComparison', vscode.StatusBarAlignment.Left, -0.015);
    this.sync.name = 'Sales Grid: Same as Org';
    this.state = vscode.window.createStatusBarItem('salesgrid.activeState', vscode.StatusBarAlignment.Left, -0.02);
    this.coverage = vscode.window.createStatusBarItem('salesgrid.coverage', vscode.StatusBarAlignment.Left, -0.03);
    this.state.name = 'Sales Grid: Active or Inactive';
    this.coverage.name = 'Sales Grid: Test Coverage';
    this.open.name = 'Sales Grid: Open in Salesforce';
    this.created = vscode.window.createStatusBarItem('salesgrid.createdBy', vscode.StatusBarAlignment.Left, -0.04);
    this.modified = vscode.window.createStatusBarItem('salesgrid.lastModifiedBy', vscode.StatusBarAlignment.Left, -0.05);
    this.created.name = 'Sales Grid: Created By';
    this.modified.name = 'Sales Grid: Last Modified By';
  }

  dispose() {
    this.open.dispose();
    this.sync.dispose();
    this.state.dispose();
    this.coverage.dispose();
    this.created.dispose();
    this.modified.dispose();
  }

  show(item, text, tooltip, command) {
    item.text = text;
    item.tooltip = tooltip;
    item.command = command;
    item.show();
  }

  // One line of status (spinner, error, "not in org") uses the first item only.
  showStatus(text, tooltip, command) {
    this.show(this.created, text, tooltip, command);
    this.modified.hide();
  }

  hide() {
    this.open.hide();
    this.sync.hide();
    this.state.hide();
    this.coverage.hide();
    this.created.hide();
    this.modified.hide();
  }

  update() {
    const file = currentFile();
    this.open.hide();
    this.sync.hide();
    this.state.hide();
    this.coverage.hide();
    if (!config().get('showFileInfoStatusBar') || !file) {
      this.hide();
      return;
    }
    const provider = this.controller.provider;
    if (!provider.orgs) {
      if (provider.failed) {
        this.hide();
        return;
      }
      provider.load();
      this.showStatus('$(loading~spin) Sales Grid: loading orgs...', 'Reading your connected orgs');
      return;
    }
    const org = this.controller.fileOrgFrom(provider.orgs);
    if (!org) {
      this.hide();
      return;
    }
    const name = orgName(org);
    const { component, uri } = file;
    if (shows('footer', 'openInSalesforce')) {
      this.show(this.open, '$(link-external) Open in Salesforce', `Open ${component.label} ${component.name} in ${name}`, {
        command: 'salesgrid.openFileInOrg',
        title: 'Open in Salesforce',
        arguments: [uri]
      });
    }
    // Lightning Pages can be opened but have no created or modified details.
    if (!component.object) {
      this.created.hide();
      this.modified.hide();
      return;
    }
    const entry = this.controller.fileEntry(component, org, uri);
    if (!entry.done) {
      this.showStatus(`$(loading~spin) Sales Grid: checking ${name}...`, `Reading ${component.name} from ${name}`);
      return;
    }
    if (entry.error) {
      this.showStatus(`$(warning) Sales Grid: could not check ${name}`, `${entry.error.message} Click to try again.`, 'salesgrid.refreshFileInfo');
      return;
    }
    const info = entry.info;
    if (!info) {
      this.showStatus(`$(cloud) ${component.name} is not in ${name} yet`, 'Click to check again', 'salesgrid.refreshFileInfo');
      return;
    }
    // The spinner borrowed these two; show them again only if wanted.
    this.created.hide();
    this.modified.hide();
    const state = shows('footer', 'codeComparison') ? syncState(file.text, info) : undefined;
    if (state === 'same') {
      this.show(this.sync, `$(check) Same as ${name}`, 'Local code matches the org');
    } else if (state === 'different') {
      this.show(this.sync, `$(warning) Different from ${name}`, 'Click to compare the org with this file', {
        command: 'salesgrid.compareWithOrg',
        title: 'Compare with Org',
        arguments: [uri]
      });
    } else if (state === 'missing') {
      this.show(this.sync, `$(warning) Not in ${name}`, 'Deploy this file to add it to the org');
    }
    if (info.active !== undefined && shows('footer', 'activeStatus')) {
      this.show(
        this.state,
        info.active ? '$(pass) Active' : '$(circle-slash) Inactive',
        activeTooltip(component, info, name),
        toggleCommand(uri)
      );
    }
    const coverage = shows('footer', 'testCoverage') ? coverageSummary(info) : undefined;
    if (coverage) {
      this.show(
        this.coverage,
        `$(${coverage.low ? 'warning' : 'beaker'}) Org coverage ${coverage.text}`,
        `${coverage.detail}. Apex test coverage of ${component.name} in ${name}, from its last test runs.`
      );
    }
    if (shows('footer', 'createdBy')) {
      this.show(
        this.created,
        `$(person) Created by ${info.createdByName} · ${formatDate(info.createdDate)}`,
        `${component.name} in ${name}. Click to open ${info.createdByName} in Setup.`,
        { command: 'salesgrid.openUser', title: 'Open User', arguments: [info.createdById, info.createdByName] }
      );
    }
    if (shows('footer', 'lastModifiedBy')) {
      this.show(
        this.modified,
        `$(history) Last modified by ${info.lastModifiedByName} · ${formatDate(info.lastModifiedDate)}`,
        `${component.name} in ${name}. Click to open ${info.lastModifiedByName} in Setup.`,
        { command: 'salesgrid.openUser', title: 'Open User', arguments: [info.lastModifiedById, info.lastModifiedByName] }
      );
    }
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Sales Grid');
  // One fast API client for everything; the CLI is only used to sign it in.
  const api = new SfApi((args, options) => sfCli.runSf(cliPath(), args, options));
  sfCli.useApi(api);
  const prefs = new OrgPrefs(context);
  const provider = new OrgProvider(output, prefs);
  const controller = new Controller(context, output, prefs, provider);
  controller.api = api;
  const debug = new Debugger(api);
  const page = new SalesGridPage({
    context,
    output,
    log: (message) => log(output, message),
    provider,
    debugger: debug,
    defaultOrg: () => controller.fileOrg()
  });
  // Debug Logs sidebar, source highlighting, hovers and replay.
  const insight = new executionView.ExecutionInsight({
    context,
    output,
    log: (message) => log(output, message),
    provider,
    debugger: debug,
    page,
    fileOrg: () => controller.fileOrg(),
    selectFileOrg: () => controller.selectFileOrg()
  });
  const insightParts = executionView.register(insight);
  page.highlightLog = async ({ org, id, log: entry }) => {
    await insight.select({ id, org, title: entry.operation || entry.request || id, start: entry.start, user: entry.user }, { highlight: true });
    if (insight.highlightOn) {
      await insight.revealMain();
    }
  };
  page.openLogWithClass = (org, log) => vscode.commands.executeCommand('salesgrid.debugLogs.openWithClass', { org, log });
  page.openLogExplorer = async ({ org, id, log: entry }) => {
    await insight.select({ id, org, title: entry.operation || entry.request || id, start: entry.start, user: entry.user }, { highlight: true });
    await vscode.commands.executeCommand('salesgrid.debugLogs.openExplorer');
  };
  const lenses = new FileInfoLensProvider(controller);
  const statusBar = new FileInfoStatusBar(controller);
  const orgListWatcher = new OrgListWatcher(provider);

  // The Connected Orgs side bar panel became the page's Salesforce Orgs tab;
  // the page reads the same data the panel showed.
  page.orgList = async () => {
    const orgs = await provider.load();
    const rank = (org) => (!isConnected(org) ? 2 : prefs.isFavourite(org) ? 0 : 1);
    return [...orgs]
      .sort((a, b) => rank(a) - rank(b))
      .map((org) => ({
        username: org.username,
        name: orgName(org),
        alias: org.alias,
        type: org.type,
        devHub: !!org.isDevHub,
        isDefault: !!org.isDefault,
        production: !!org.isProduction,
        connected: isConnected(org),
        expiringSoon: isExpiringSoon(org),
        expiry: expiryText(org),
        status: org.isExpired ? 'Expired' : org.status,
        edition: org.edition,
        instanceUrl: org.instanceUrl,
        orgId: org.orgId,
        favourite: prefs.isFavourite(org),
        colour: prefs.colour(org)
      }));
  };
  const ORG_ACTIONS = { open: 'salesgrid.openOrg', copyUrl: 'salesgrid.copyOpenUrl', relogin: 'salesgrid.reauthorize', remove: 'salesgrid.removeOrg', pin: 'salesgrid.addFavourite', unpin: 'salesgrid.removeFavourite', colour: 'salesgrid.setColour', copyUser: 'salesgrid.copyUsername' };
  page.orgAction = async (action, username) => {
    const org = (provider.orgs || []).find((candidate) => candidate.username === username);
    if (org && ORG_ACTIONS[action]) {
      await vscode.commands.executeCommand(ORG_ACTIONS[action], { org });
    }
  };
  const refreshFileInfo = () => {
    lenses.refresh();
    statusBar.update();
  };

  // Picks up deploys made outside Sales Grid while the window is in use.
  const seconds = Number(config().get('autoRefreshSeconds'));
  const autoRefresh =
    seconds > 0
      ? setInterval(() => {
          if (vscode.window.state.focused) {
            orgListWatcher.check();
            controller.checkForOrgChange();
          }
        }, Math.max(10, seconds) * 1000)
      : undefined;

  let typingTimer;
  // The Activity Bar icon needs a view to show; it is an empty placeholder.
  // Clicking the icon opens the Sales Grid page in the editor area instead and
  // closes the side bar again.
  const launcher = vscode.window.createTreeView('salesgrid.launcher', { treeDataProvider: { getChildren: () => [], getTreeItem: (item) => item } });
  const orgCommand = (id, handler) =>
    vscode.commands.registerCommand(id, async (item) => {
      const org = await resolveOrg(provider, item);
      if (org) {
        await handler(org);
      }
    });

  context.subscriptions.push(
    ...insightParts.disposables,
    // vscode://kalaiarasan.sales-grid/openWithClass?file=<path to a .log> runs
    // Open Log with Class, so a script can hand a fresh log straight to the
    // new window. Only .log files inside the open workspace are accepted,
    // since any link can call this.
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        // vscode://kalaiarasan.sales-grid/reload reloads the window, so a freshly
        // installed build can be loaded without looking for the command.
        if (uri.path === '/reload') {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
          return;
        }
        if (uri.path !== '/openWithClass') {
          return;
        }
        const file = path.resolve(new URLSearchParams(uri.query).get('file') || '');
        const folders = (vscode.workspace.workspaceFolders || []).map((f) => path.resolve(f.uri.fsPath).toLowerCase() + path.sep);
        if (!/\.log$/i.test(file) || !folders.some((f) => file.toLowerCase().startsWith(f)) || !fs.existsSync(file)) {
          log(output, `FAILED: ignored a link to open ${file}: only .log files inside this workspace can be opened that way.`);
          return;
        }
        await vscode.commands.executeCommand('salesgrid.debugLogs.openWithClass', { file });
      }
    }),
    controller.onDidChangeFileInfo(() => {
      // A different org chosen for the project means a different log list.
      const org = controller.fileOrgFrom(provider.orgs || []);
      if (org && org.username !== insightParts.view.lastOrg) {
        insightParts.view.lastOrg = org.username;
        insightParts.view.refresh();
      }
    }),
    output,
    launcher,
    launcher.onDidChangeVisibility(async (event) => {
      // Close the side bar first so only the page shows, with no panel
      // flashing beside it.
      if (event.visible) {
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await page.open();
      }
    }),
    // Keep the page's Salesforce Orgs tab up to date.
    provider.onDidChangeTreeData(() => page.refreshSideTabs()),
    vscode.window.registerFileDecorationProvider(provider),
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, lenses),
    vscode.workspace.registerTextDocumentContentProvider(ORG_FILE_SCHEME, controller.orgFileProvider),
    vscode.workspace.onDidSaveTextDocument(() => {
      controller.checkAfterSave();
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (lastFile && event.document === lastFile.document) {
        // Repaint once typing pauses, not on every keystroke.
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => statusBar.update(), 300);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => controller.openedVersion.delete(document.uri.toString())),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        orgListWatcher.check();
        controller.checkForOrgChange();
      }
    }),
    controller,
    orgListWatcher,
    { dispose: () => clearInterval(autoRefresh) },

    statusBar,
    vscode.window.onDidChangeActiveTextEditor(() => {
      statusBar.update();
      controller.checkForOrgChange();
    }),
    controller.onDidChangeFileInfo(refreshFileInfo),
    provider.onDidLoad(refreshFileInfo),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('salesgrid')) {
        provider.redraw();
        refreshFileInfo();
      }
    }),

    vscode.commands.registerCommand('salesgrid.refresh', () => {
      controller.fileInfoCache.clear();
      provider.refresh();
    }),
    orgCommand('salesgrid.openOrg', (org) => controller.openOrg(org)),
    orgCommand('salesgrid.copyOpenUrl', (org) => controller.copyOpenUrl(org)),
    orgCommand('salesgrid.reauthorize', (org) => controller.reauthorize(org)),
    orgCommand('salesgrid.removeOrg', (org) => controller.removeOrg(org)),
    orgCommand('salesgrid.addFavourite', (org) => controller.setFavourite(org, true)),
    orgCommand('salesgrid.removeFavourite', (org) => controller.setFavourite(org, false)),
    orgCommand('salesgrid.setColour', (org) => controller.chooseColour(org)),

    vscode.commands.registerCommand('salesgrid.copyUsername', async (item) => {
      if (item && item.org) {
        await vscode.env.clipboard.writeText(item.org.username);
        vscode.window.showInformationMessage(`Sales Grid: copied ${item.org.username}`);
      }
    }),

    vscode.commands.registerCommand('salesgrid.openFileInOrg', (uri) =>
      controller.openFileInOrg(uri instanceof vscode.Uri ? uri : undefined)
    ),
    vscode.commands.registerCommand('salesgrid.openUser', (userId, userName) => controller.openUser(userId, userName)),
    vscode.commands.registerCommand('salesgrid.compareWithOrg', (uri) =>
      controller.compareWithOrg(uri instanceof vscode.Uri ? uri : undefined)
    ),
    vscode.commands.registerCommand('salesgrid.toggleActive', (uri) =>
      controller.toggleActive(uri instanceof vscode.Uri ? uri : undefined)
    ),
    page,
    { dispose: () => clearTimeout(typingTimer) },
    vscode.commands.registerCommand('salesgrid.configure', () => page.open('config')),
    vscode.commands.registerCommand('salesgrid.openDebugLogs', () => page.open('logs')),
    vscode.commands.registerCommand('salesgrid.home', () => page.open()),
    vscode.commands.registerCommand('salesgrid.selectFileOrg', () => controller.selectFileOrg()),
    vscode.commands.registerCommand('salesgrid.refreshFileInfo', () => controller.invalidateFileInfo()),
    // The Sales Grid button on the editor toolbar opens the Sales Grid page.
    vscode.commands.registerCommand('salesgrid.showCurrentFile', () => page.open())
  );

  // Fill the footer for a file that is already open when VS Code starts.
  statusBar.update();
}

function deactivate() {}

module.exports = { activate, deactivate };
