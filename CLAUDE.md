# Sales Grid — developer notes

VS Code extension for Salesforce developers: connected orgs, per-file org details, debug logs with
source highlighting and replay, anonymous Apex, trace flags. Plain CommonJS JavaScript, no build step,
no npm dependencies (only `vscode` and Node built-ins). Engine `^1.85.0`.

## Rules that must not be broken

- **Never change `name` (`sales-grid`), `displayName` (`Sales Grid`) or `publisher` (`Kalaiarasan`)**
  in `package.json`. The extension is on the Marketplace as `kalaiarasan.sales-grid`.
- **Do not bump `version`** unless the user asks; rebuild the existing vsix (currently 0.1.5).
- No git repo here. Old `.vsix` files sit in the root; keep them.

## Build, test, install

```sh
node --test test/                      # all tests (mocked vscode, no org needed)
vsce package                           # -> sales-grid-<version>.vsix (overwrites the same version)
code --install-extension sales-grid-0.1.5.vsix --force
```

`.vscodeignore` excludes `.vscode/`, `*.vsix`, `video/`, `test/`, `CLAUDE.md`.

## Files

| File | What it does |
| --- | --- |
| `extension.js` | `activate()`. The side bar holds only the empty `salesgrid.launcher` view: showing it closes the side bar and opens the page (no welcome content, so nothing flashes). Org list (`OrgProvider` data, `OrgPrefs` pins/colours) feeds the page's Salesforce Orgs tab via `page.orgList`/`orgAction`. File details are shown only above line 1 (CodeLens) and in the status bar, `OrgListWatcher` (watches `~/.sfdx`), `Controller` (open org, re-login, remove, file org, compare/diff, toggle trigger/flow, file info cache), `FileInfoView` (Current File tree), `FileInfoLensProvider` (CodeLens on line 1), `FileInfoStatusBar`. Wires everything at the bottom. |
| `sfCli.js` | Runs `sf ... --json` via `exec`. `listOrgs`, `getOpenUrl`, `queryComponentInfo`, `queryCoverage`, `queryLastModified`, `queryLwcSource`, `setTriggerActive` (metadata deploy of org's own body), flow activation, `logout`. `query()` uses the direct API first and falls back to the CLI on connection problems. |
| `sfApi.js` | Direct REST client (`https`). Gets instanceUrl + access token from the CLI once per org (kept in memory 50 min, retries once on 401). `request`, `query` (follows `nextRecordsUrl`). |
| `component.js` | Maps a local path to a component type (`.cls`, `.trigger`, `.page`, `.component`, lwc/aura folders, flow, flexipage) + Setup URLs. |
| `debug.js` | `Debugger`: ApexLog list/body/delete, TraceFlag + DebugLevel CRUD (Tooling API), presets `SalesGrid_<key>`, the `Sales_Grid` level (FINER/FINEST Apex) used by highlighting, user search, Lightning debug mode, `executeAnonymous`. |
| `salesGridPage.js` | The Home webview (tabs: Debug Logs, Debug Mode, Run Apex, Trace Flags & Levels, Configuration). Message handler `handle()`. Also exports `logFolder` (`<workspace>/.sfdx/tools/debug/logs`), `logOrg`/`rememberLogOrg` (globalState map log id → org), `downloadLog`. |
| `resources/page/main.js`, `viewer.js`, `page.css` | Webview front end (CSP with nonce). |
| `configPage.js` | Model for the Configuration tab: `DETAILS` × `PLACES` grid, `FEATURES`, `GENERAL`. Any setting shown there must be listed here **and** in `package.json`. |
| `logParser.js` | Summary for the page (errors, debug, SOQL, DML, slowest methods, limits) and `buildTimeline`. |
| `executionAnalyzer.js` | Pure log analysis for highlighting (no vscode). `analyzeLog(text, { knownClasses })` → `files` (key `class:name` / `trigger:name`, lowercase) with per-line data, `steps` (replay), `exceptions`, `methods`, `queries`, `triggers`, `notes`. Also `findings`, `lineStates` (executed / exception / hot), `verifySource` (does the open file still match the log). |
| `logExplorer.js` | Webview for one log. `createPanel(insight, analysis, { coverage })`: the full Log Explorer, or with `coverage` only the code that ran (triggers first) used by Open Log with Class next to the log. No close button and no Escape: popped-out windows are closed with the window's own title-bar buttons (the user asked for that; there is no `salesgrid.closeLogWindow` any more). Opened (`salesgrid.openLogExplorer` on `.log` editor title, `salesgrid.debugLogs.openExplorer` in the tree, `explorer` act on the Home page). In the coverage view a trigger that ran more than once (BeforeUpdate, AfterUpdate…) gets one section per run (`triggerRuns`/`runLines`, by the run's frame id), and a line holding only `}` is green when a line inside its block ran (`closingBraceLines`). Hovering a red line shows its exception, and hovering a line with a blue dot shows its System.debug output for that run (hidden `pre#dbg-<section>-<line>`, steps carry `level`). The text can be selected, or copied with Copy. `buildHtml(analysis, sources, options)` is pure and tested; opens in a new window via `workbench.action.moveEditorToNewWindow`. |
| `popOut.js` | `moveToNewWindow()` (`workbench.action.moveEditorToNewWindow`, respects `salesgrid.debugLogs.openInNewWindow`) and `maximize()` (VS Code has no maximize command and full screen covers the taskbar, so on Windows it calls user32 ShowWindow(SW_MAXIMIZE) via PowerShell on the foreground window, only if it belongs to Code; `SALESGRID_NO_MAXIMIZE` turns it off in tests). Used by Open log, Open log with class and the Log Explorer. |
| `executionView.js` | `ExecutionInsight` (selected log, decorations, hover, status bar, replay, performance report, `revealMain`, `goToLocation`), `DebugLogsView` (log list provider; its sidebar panel was removed on request, so no tree view is created, but commands still use it), `register()` (commands + listeners, incl. auto-highlight when a `.log` is opened in the editor). |

## How log → source highlighting works

1. A log is selected (`insight.select(entry, { highlight })`): from the Home page
   (`page.highlightLog`), `Open a log file…`, or **just opening a `.log` in the editor**
   (`logOpened` in `register()`, setting `salesgrid.executionHighlight.highlightOnLogOpen`).
2. `load()` reads the file (downloads it if needed) and calls `analyzeLog` with every class name in
   the workspace (`index()`, `**/*.{cls,trigger}`, prefers `force-app` copies).
3. Code units map to files in `unitFrame`: triggers via `__sfdc_trigger/Name` or `01q` ids; classes via
   `01p` ids. A scheduled job logs the **job name** (e.g. `SendConfirmTicketBatch_00`), so an unknown
   name is matched to the longest known class it starts with.
4. `apply(editor)` decorates lines by `lineStates`; hover = `describeLine`; status bar shows
   `N lines ran` and `changed?` when `verifySource` finds mismatches.
5. Below `APEX_CODE,FINER` there are no `STATEMENT_EXECUTE` events: only lines with calls, SOQL, DML,
   debug output or exceptions can be highlighted (a note says so). FINER is what the "Sales Grid" debug
   level turns on.
6. Logs without METHOD_ENTRY (Apex Code below FINE) give a line but not the class. `readSourceIfNeeded` passes the workspace source as `options.source` (Map key → `{ name, lines }`); `placeAt` keeps an event on the unit's class only if `sourceFit` says the line holds it, else moves it to the single best-matching class, else drops the line (still counted).
7. `inferredLines(analysis, key, lineText, count)` (below FINER only): code lines between consecutive recorded steps of the same frame (`step.fid`) with no branch keyword between, plus the call line in the caller when the log jumps into another method (`methodSpans` from source). Shown as the `inferred` decoration; never counted as recorded.
8. Event times: `step.time` / `debug[].time` etc. are clock times = first line's printed time + elapsed nanos (`clockTime`). `at` is the log *line number*.
9. The org copy may differ from local code; `orgMatches()` asks once when the log's org differs from
   the project's org.

## Conventions

- User-facing text: plain, short sentences, "Sales Grid: …" prefix in notifications. Every failure is
  also logged to the "Sales Grid" output channel via `log()` with a `FAILED:` prefix.
- Anything put into a shell command or SOQL is validated by a whitelist regex (`SAFE_TARGET`,
  `SAFE_NAME`, `RECORD_ID`) rather than escaped.
- Settings live under `salesgrid.*`; features default on and are read as `!== false`.
- Comments explain *why*, one or two lines, above the code.
- New behaviour gets a test: pure logic in `test/executionAnalyzer.test.js` / `test/debug.test.js`,
  wiring in `test/extension.smoke.test.js` (uses `test/vscodeMock.js`; fire
  `mock.activeEditorChanged` to simulate switching editors). Fixtures are in `test/fixtures/`.
