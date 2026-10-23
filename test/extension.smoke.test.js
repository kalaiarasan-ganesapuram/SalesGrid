// Runs the real activate() against a stand-in `vscode` module and checks what
// the debug log highlighter draws. Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const { create } = require('./vscodeMock');
// Never maximize a real window while testing.
process.env.SALESGRID_NO_MAXIMIZE = '1';

const fixtures = path.join(__dirname, 'fixtures');
const classes = path.join(fixtures, 'force-app', 'main', 'default', 'classes');
const mock = create({ folder: fixtures, config: { cliPath: 'sf', autoRefreshSeconds: 0, 'executionHighlight.showCounts': true, 'executionHighlight.hotLineThreshold': 50 } });

// Answer every Salesforce CLI call with "no orgs" so nothing reaches a real org.
childProcess.exec = (command, options, callback) => {
  setImmediate(() => callback(null, JSON.stringify({ status: 0, result: { nonScratchOrgs: [] } }), ''));
  return { kill() {} };
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'vscode' ? 'vscode' : resolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: mock.vscode };

const extension = require('../extension');
const context = {
  subscriptions: [],
  workspaceState: mock.memento(),
  globalState: mock.memento(),
  extensionUri: mock.vscode.Uri.file(path.join(__dirname, '..')),
  globalStorageUri: mock.vscode.Uri.file(path.join(fixtures, '.storage'))
};

const lines = (ranges) => ranges.map((r) => r.range.end.line + 1).sort((a, b) => a - b);
// Decoration types are created in this order by executionView: executed, exception, hot, replay.
const TYPE = { executed: 1, exception: 2, hot: 3, replay: 4 };

test.before(() => extension.activate(context));
test.after(() => {
  context.subscriptions.forEach((d) => d && d.dispose && d.dispose());
  fs.rmSync(path.join(fixtures, '.sfdx'), { recursive: true, force: true });
  fs.rmSync(path.join(fixtures, '.storage'), { recursive: true, force: true });
});

test('a local log is picked, the toolbar button appears, and highlighting colours the right lines', async () => {
  await mock.vscode.commands.executeCommand('salesgrid.debugLogs.select', { file: path.join(fixtures, 'same-class.log'), title: 'same-class.log' });
  assert.equal(mock.contexts['salesgrid.logSelected'], true, 'toolbar icon is shown once a log is in use');

  const editor = mock.editor(mock.document(path.join(classes, 'OrderService.cls')));
  mock.vscode.window.visibleTextEditors = [editor];
  mock.vscode.window.activeTextEditor = editor;
  await mock.vscode.commands.executeCommand('salesgrid.highlightExecution');
  assert.equal(mock.contexts['salesgrid.highlightOn'], true);

  // Closing braces 11, 13 and 22 ran with their blocks; 19 did not (validate threw), nor the class's own 23.
  assert.deepEqual(lines(editor.decorations.get(TYPE.executed)), [3, 4, 6, 9, 10, 11, 12, 13, 15, 16, 21, 22]);
  assert.deepEqual(lines(editor.decorations.get(TYPE.exception)), [17]);
  assert.deepEqual(lines(editor.decorations.get(TYPE.hot)), []);
  const exceptionLabel = editor.decorations.get(TYPE.exception)[0].renderOptions.after.contentText;
  assert.match(exceptionLabel, /NullPointerException/);
});

test('hover shows the recorded details, and nothing for lines the log did not record', async () => {
  const doc = mock.document(path.join(classes, 'OrderService.cls'));
  const hover = mock.hovers[0].provideHover(doc, new mock.vscode.Position(16, 4));
  const text = hover.contents[0].value;
  assert.match(text, /System\\\.NullPointerException/);
  assert.match(text, /execution continued afterwards/);
  assert.match(text, /^`[\d:.]+` /, 'starts with the log timestamp');
  assert.doesNotMatch(text, /Sales Grid|Replay from here|Executed/, 'only what happened on the line');

  const catchLine = mock.hovers[0].provideHover(doc, new mock.vscode.Position(8, 4)).contents[0].value;
  assert.match(catchLine, /Resumed here/);
  assert.match(catchLine, /caught Attempt/);

  assert.equal(mock.hovers[0].provideHover(doc, new mock.vscode.Position(6, 4)), undefined, 'line 7 never ran: no hover');
  assert.equal(mock.hovers[0].provideHover(doc, new mock.vscode.Position(17, 4)), undefined, 'line 18 after the throw: no hover');
});

test('replay walks the recorded steps and jumps to the exception', async () => {
  await mock.vscode.commands.executeCommand('salesgrid.replay.start');
  assert.equal(mock.contexts['salesgrid.replayActive'], true);
  await mock.vscode.commands.executeCommand('salesgrid.replay.nextException');
  const active = mock.vscode.window.activeTextEditor;
  assert.equal(path.basename(active.document.uri.fsPath), 'OrderService.cls');
  assert.deepEqual(lines(active.decorations.get(TYPE.replay)), [17]);
  await mock.vscode.commands.executeCommand('salesgrid.replay.next');
  await mock.vscode.commands.executeCommand('salesgrid.replay.next');
  assert.deepEqual(lines(mock.vscode.window.activeTextEditor.decorations.get(TYPE.replay)), [9], 'after the exception, replay moves to the catch block');
  await mock.vscode.commands.executeCommand('salesgrid.replay.stop');
  assert.equal(mock.contexts['salesgrid.replayActive'], false);
});

test('a trigger chain highlights every participating file, and turning it off clears them', async () => {
  await mock.vscode.commands.executeCommand('salesgrid.debugLogs.select', { file: path.join(fixtures, 'trigger-chain.log'), title: 'trigger-chain.log' });
  const handler = mock.editor(mock.document(path.join(classes, 'AccountTriggerHandler.cls')));
  const service = mock.editor(mock.document(path.join(classes, 'AccountService.cls')));
  const trigger = mock.editor(mock.document(path.join(fixtures, 'force-app', 'main', 'default', 'triggers', 'AccountTrigger.trigger')));
  mock.vscode.window.visibleTextEditors = [handler, service, trigger];
  mock.vscode.window.activeTextEditor = handler;
  await mock.vscode.commands.executeCommand('salesgrid.highlightExecution');
  // The handler caught the exception, so the trigger reached its closing brace.
  assert.deepEqual(lines(trigger.decorations.get(TYPE.executed)), [2, 3, 4]);
  assert.deepEqual(lines(service.decorations.get(TYPE.hot)), [4], 'query in a loop is yellow');
  // Braces 10, 13, 15, 19 and 20 close blocks that ran to their end.
  assert.deepEqual(lines(handler.decorations.get(TYPE.executed)), [2, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20]);
  const count = handler.decorations.get(TYPE.executed).find((r) => r.range.end.line === 13).renderOptions.after.contentText;
  assert.match(count, /×2/);

  const tree = await context.subscriptions.find((d) => d && d.provider && d.id === 'salesgrid.debugLogs').provider.getChildren();
  const selected = tree.find((node) => node.group === 'selected');
  assert.ok(selected, 'the log in use is listed in the sidebar');

  await mock.vscode.commands.executeCommand('salesgrid.clearHighlight');
  assert.deepEqual(handler.decorations.get(TYPE.executed), []);
  assert.equal(mock.contexts['salesgrid.highlightOn'], false);
});

test('opening a debug log in the editor highlights it and opens the class it ran beside it', async () => {
  await mock.vscode.commands.executeCommand('salesgrid.clearHighlight');
  const log = mock.editor(mock.document(path.join(fixtures, 'scheduled-job.log')));
  mock.vscode.window.visibleTextEditors = [log];
  mock.vscode.window.activeTextEditor = log;
  mock.activeEditorChanged.fire(log);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(mock.contexts['salesgrid.highlightOn'], true);
  const opened = mock.vscode.window.visibleTextEditors.find((e) => path.basename(e.document.uri.fsPath) === 'OrderService.cls');
  assert.ok(opened, 'the class the log ran is opened');
  assert.deepEqual(lines(opened.decorations.get(TYPE.executed)), [3, 4]);

  // A file that is not an Apex debug log is left alone.
  const other = mock.editor(mock.document(path.join(classes, 'OrderService.cls')));
  mock.activeEditorChanged.fire(other);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(context.workspaceState.get('salesgrid.highlightLog').title, /scheduled-job.log/);
});

test('Open log with class: the log and a "code that ran" page go to one new window, the page split to the right', async () => {
  await mock.vscode.commands.executeCommand('salesgrid.clearHighlight');
  const ran = [];
  const original = mock.vscode.commands.executeCommand;
  mock.vscode.commands.executeCommand = async (id, ...args) => {
    ran.push(id);
    return original(id, ...args);
  };
  try {
    mock.vscode.window.visibleTextEditors = [];
    await original('salesgrid.debugLogs.openWithClass', { file: path.join(fixtures, 'same-class.log') });
    const windowSteps = ran.filter((id) => /NewWindow|RightGroup|FullScreen|closeWindow/.test(id));
    assert.deepEqual(windowSteps, ['workbench.action.moveEditorGroupToNewWindow', 'workbench.action.moveEditorToRightGroup'], 'no full screen: it would cover the taskbar');
    assert.ok(mock.vscode.window.visibleTextEditors.some((e) => path.basename(e.document.uri.fsPath) === 'same-class.log'), 'the log is open');
    const panel = mock.panels[mock.panels.length - 1];
    assert.equal(panel.viewType, 'salesgrid.coverage');
    assert.match(panel.webview.html, /class="row err"/, "the line that threw is red");
    assert.match(panel.webview.html, /class="row ran"/, "lines that ran are green");
    assert.doesNotMatch(panel.webview.html, /class="notes"|class="legend"/, "no extra explanation");
    assert.doesNotMatch(panel.webview.html, /id="close"/, 'no Close button: the window has its own');
    assert.doesNotMatch(panel.webview.html, /'Escape'/, 'Escape does not close it');

    // The error shows only on hover over the red line, and can be copied.
    assert.match(panel.webview.html, /class="row err" data-ex="0"/);
    assert.match(panel.webview.html, /<pre class="exsrc" id="ex-0" hidden>System\.NullPointerException/);
    assert.match(panel.webview.html, /id="expopCopy">Copy</);
    let copied;
    const clipboard = mock.vscode.env.clipboard.writeText;
    mock.vscode.env.clipboard.writeText = async (text) => (copied = text);
    await panel.receive({ type: 'copy', text: 'System.NullPointerException\nStack trace' });
    mock.vscode.env.clipboard.writeText = clipboard;
    assert.equal(copied, 'System.NullPointerException\nStack trace');
    // With the setting off, nothing leaves the main window.
    ran.length = 0;
    mock.config['debugLogs.openInNewWindow'] = false;
    await original('salesgrid.debugLogs.openWithClass', { file: path.join(fixtures, 'same-class.log') });
    assert.deepEqual(ran.filter((id) => /NewWindow|RightGroup|FullScreen/.test(id)), []);
  } finally {
    mock.vscode.commands.executeCommand = original;
    delete mock.config['debugLogs.openInNewWindow'];
  }
});

test('a vscode:// link opens a workspace log with its class; files outside the workspace are refused', async () => {
  const ran = [];
  const original = mock.vscode.commands.executeCommand;
  mock.vscode.commands.executeCommand = async (id, ...args) => (ran.push([id, args[0]]), id === 'salesgrid.debugLogs.openWithClass' ? undefined : original(id, ...args));
  try {
    const handler = mock.uriHandlers[0];
    const link = (file) => ({ path: '/openWithClass', query: new URLSearchParams({ file }).toString() });
    await handler.handleUri(link(path.join(fixtures, 'same-class.log')));
    assert.deepEqual(ran.filter((r) => r[0] === 'salesgrid.debugLogs.openWithClass').map((r) => path.basename(r[1].file)), ['same-class.log']);
    ran.length = 0;
    await handler.handleUri(link(path.join(__dirname, '..', 'package.json')));
    await handler.handleUri(link(path.join(require('os').tmpdir(), 'x.log')));
    assert.equal(ran.filter((r) => r[0] === 'salesgrid.debugLogs.openWithClass').length, 0);
  } finally {
    mock.vscode.commands.executeCommand = original;
  }
});

test('Open log with class on a trigger log: the page shows the trigger first with all its lines, then the classes', async () => {
  mock.vscode.window.visibleTextEditors = [];
  await mock.vscode.commands.executeCommand('salesgrid.debugLogs.openWithClass', { file: path.join(fixtures, 'trigger-chain.log') });
  const html = mock.panels[mock.panels.length - 1].webview.html;
  const sections = [...html.matchAll(/<h2 id="(trigger|class):[^"]+">/g)].map((m) => m[1]);
  assert.equal(sections[0], 'trigger', 'trigger first');
  const firstClass = sections.indexOf('class');
  assert.ok(firstClass > 0 && sections.slice(firstClass).every((kind) => kind === 'class'), 'then the classes');
  const trigger = fs.readFileSync(path.join(fixtures, 'force-app', 'main', 'default', 'triggers', 'AccountTrigger.trigger'), 'utf8').split(/\r?\n/);
  const triggerSection = html.slice(html.indexOf('<h2 id="trigger:'), html.indexOf('<h2', html.indexOf('<h2 id="trigger:') + 1));
  assert.equal((triggerSection.match(/class="row[ "]/g) || []).length, trigger.length, 'every line of the trigger is shown');
});

test('clicking the Sales Grid icon opens the full page in the editor area and closes the side bar', async () => {
  const ran = [];
  const original = mock.vscode.commands.executeCommand;
  mock.vscode.commands.executeCommand = async (id, ...args) => (ran.push(id), original(id, ...args));
  try {
    const launcher = mock.treeViews.find((view) => view.id === 'salesgrid.launcher');
    assert.ok(launcher, 'only a placeholder view remains in the side bar');
    assert.ok(!mock.treeViews.some((view) => view.id === 'salesgrid.orgs' || view.id === 'salesgrid.fileInfo'), 'the old panels are gone');
    const before = mock.panels.length;
    launcher.fireVisible(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(mock.panels.slice(before).some((panel) => panel.viewType === 'salesgrid.page'), 'the Sales Grid page opens');
    assert.ok(ran.includes('workbench.action.closeSidebar'));
    const html = mock.panels.find((panel) => panel.viewType === 'salesgrid.page').webview.html;
    assert.match(html, /data-tab="orgs"><span data-icon="cloud"><\/span>Salesforce Orgs/);
    assert.doesNotMatch(html, /data-tab="file"/, 'no Current File tab');
    // Close the page so its refresh timer does not keep the test run alive.
    mock.panels.filter((panel) => panel.viewType === 'salesgrid.page').forEach((panel) => panel.dispose());
  } finally {
    mock.vscode.commands.executeCommand = original;
  }
});
