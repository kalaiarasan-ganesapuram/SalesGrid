// A small stand-in for the `vscode` module, enough to run activate() and the
// debug log highlighter under Node and look at what they draw.
const fs = require('fs');
const path = require('path');

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
    };
  }
  fire(value) {
    this.listeners.slice().forEach((listener) => listener(value));
  }
  dispose() {}
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) {
      this.start = a;
      this.end = b;
    } else {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    }
  }
}
class Selection extends Range {}

const Uri = {
  file: (p) => ({ scheme: 'file', fsPath: path.resolve(p), path: p, toString: () => `file://${path.resolve(p)}` }),
  from: (parts) => ({ ...parts, toString: () => `${parts.scheme}:${parts.path}` }),
  parse: (text) => ({ scheme: 'https', toString: () => text }),
  joinPath: (base, ...parts) => Uri.file(path.join(base.fsPath, ...parts))
};

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class MarkdownString {
  constructor(value = '', supportThemeIcons) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendMarkdown(text) {
    this.value += text;
    return this;
  }
}
class Hover {
  constructor(contents, range) {
    this.contents = [contents];
    this.range = range;
  }
}
class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
}

function document(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  return {
    uri: Uri.file(file),
    version: 1,
    isDirty: false,
    lineCount: lines.length,
    getText: () => text,
    lineAt: (i) => ({ text: lines[i], range: new Range(i, 0, i, lines[i].length) })
  };
}

function editor(doc) {
  return {
    document: doc,
    decorations: new Map(),
    setDecorations(type, ranges) {
      this.decorations.set(type.id, ranges);
    },
    revealRange() {}
  };
}

function create(options = {}) {
  const commands = new Map();
  const contexts = {};
  const hovers = [];
  const shown = [];
  const messages = [];
  const config = { ...(options.config || {}) };
  const uriHandlers = [];
  const panels = [];
  const treeViews = [];
  let decorationId = 0;
  const memento = () => {
    const store = {};
    return { get: (key, fallback) => (key in store ? store[key] : fallback), update: async (key, value) => (store[key] = value), keys: () => Object.keys(store) };
  };
  const activeEditorChanged = new EventEmitter();
  const statusItem = () => ({ show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} });
  const window = {
    state: { focused: true },
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createOutputChannel: () => ({ appendLine: (line) => messages.push(line), show() {}, dispose() {} }),
    createTreeView: (id, opts) => {
      const visibility = new EventEmitter();
      const view = { id, provider: opts.treeDataProvider, visible: true, onDidChangeVisibility: visibility.event, fireVisible: (visible) => visibility.fire({ visible }), dispose() {} };
      treeViews.push(view);
      return view;
    },
    registerFileDecorationProvider: () => ({ dispose() {} }),
    createStatusBarItem: () => statusItem(),
    createTextEditorDecorationType: (opts) => ({ id: ++decorationId, opts, dispose() {} }),
    onDidChangeActiveTextEditor: activeEditorChanged.event,
    onDidChangeVisibleTextEditors: new EventEmitter().event,
    onDidChangeWindowState: new EventEmitter().event,
    withProgress: (opts, task) => Promise.resolve(task({ report() {} })),
    showInformationMessage: async (...args) => messages.push(['info', args[0]]) && undefined,
    showWarningMessage: async (...args) => (messages.push(['warn', args[0]]), options.warningAnswer),
    showErrorMessage: async (...args) => messages.push(['error', args[0]]) && undefined,
    showQuickPick: async (items) => (options.pick ? options.pick(await items) : undefined),
    showInputBox: async () => undefined,
    setStatusBarMessage: () => ({ dispose() {} }),
    // Like VS Code, a file that is already visible keeps its editor.
    showTextDocument: async (doc) => {
      const target = doc.uri ? doc : document(doc.fsPath);
      let opened = window.visibleTextEditors.find((e) => e.document.uri.fsPath === target.uri.fsPath);
      if (!opened) {
        opened = editor(target);
        window.visibleTextEditors.push(opened);
      }
      shown.push(opened);
      window.activeTextEditor = opened;
      return opened;
    },
    showOpenDialog: async () => undefined,
    createWebviewPanel: (viewType, title, viewColumn) => {
      const panel = {
        viewType,
        title,
        viewColumn,
        revealed: 0,
        disposed: false,
        webview: { html: '', onDidReceiveMessage: (handler) => ((panel.receive = handler), { dispose() {} }), postMessage: async () => true, asWebviewUri: (uri) => uri, cspSource: 'mock' },
        reveal: () => panel.revealed++,
        dispose: () => {
          panel.disposed = true;
          (panel.onDispose || []).forEach((listener) => listener());
        },
        onDidDispose: (listener) => ((panel.onDispose = [...(panel.onDispose || []), listener]), { dispose() {} })
      };
      panels.push(panel);
      return panel;
    },
    registerUriHandler: (handler) => (uriHandlers.push(handler), { dispose() {} })
  };
  const workspace = {
    workspaceFolders: options.folder ? [{ uri: Uri.file(options.folder) }] : [],
    getWorkspaceFolder: () => (options.folder ? { uri: Uri.file(options.folder) } : undefined),
    getConfiguration: () => ({ get: (key) => config[key], update: async (key, value) => (config[key] = value) }),
    onDidSaveTextDocument: new EventEmitter().event,
    onDidChangeTextDocument: new EventEmitter().event,
    onDidCloseTextDocument: new EventEmitter().event,
    onDidChangeConfiguration: new EventEmitter().event,
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidCreate() {}, onDidDelete() {}, dispose() {} }),
    findFiles: async () => {
      const found = [];
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name);
          if (name.startsWith('.')) continue;
          if (fs.statSync(full).isDirectory()) walk(full);
          else if (/\.(cls|trigger)$/.test(name)) found.push(Uri.file(full));
        }
      };
      if (options.folder) walk(options.folder);
      return found;
    },
    openTextDocument: async (target) => document(typeof target === 'string' ? target : target.fsPath)
  };
  const vscode = {
    EventEmitter,
    Position,
    Range,
    Selection,
    Uri,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    Hover,
    CodeLens,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15, Window: 10 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    TextEditorRevealType: { InCenter: 2, InCenterIfOutsideViewport: 3 },
    ViewColumn: { Active: -1, Beside: -2 },
    ConfigurationTarget: { Global: 1 },
    window,
    workspace,
    languages: {
      registerCodeLensProvider: () => ({ dispose() {} }),
      registerHoverProvider: (selector, provider) => (hovers.push(provider), { dispose() {} })
    },
    commands: {
      registerCommand: (id, handler) => (commands.set(id, handler), { dispose: () => commands.delete(id) }),
      executeCommand: async (id, ...args) => {
        if (id === 'setContext') {
          contexts[args[0]] = args[1];
          return undefined;
        }
        return commands.has(id) ? commands.get(id)(...args) : undefined;
      },
      getCommands: async () => [...commands.keys()]
    },
    env: { clipboard: { writeText: async () => {} }, openExternal: async () => true },
    tasks: { onDidEndTaskProcess: new EventEmitter().event, onDidEndTask: new EventEmitter().event, executeTask: async () => ({}) }
  };
  return { vscode, commands, contexts, hovers, shown, messages, config, memento, document, editor, activeEditorChanged, uriHandlers, panels, treeViews };
}

module.exports = { create };
