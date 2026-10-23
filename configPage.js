// What the Configuration tab of the Sales Grid page offers: which details
// appear where, which features are on, and a few general settings.

const vscode = require('vscode');

const DETAILS = [
  ['openInSalesforce', 'Open in Salesforce', 'Link that opens the current component in the org'],
  ['codeComparison', 'Same as / Different from org', 'Whether the code in the file matches the code in the org'],
  ['activeStatus', 'Active / Inactive', 'Whether a trigger or flow is active'],
  ['testCoverage', 'Test coverage', 'Apex test coverage of a class or trigger in the org'],
  ['createdBy', 'Created by', 'Who created the component, with date and time'],
  ['lastModifiedBy', 'Last modified by', 'Who last changed the component, with date and time']
];

// [settings prefix, heading, where it is, master switch for the whole place]
const PLACES = [
  ['footer', 'Footer', 'Status bar at the bottom', 'showFileInfoStatusBar'],
  ['aboveFile', 'Inside the file', 'Links above line 1', 'showFileInfoCodeLens']
];

const FEATURES = [
  ['features.activateDeactivate', 'Activate / deactivate', 'Let me switch a trigger or flow on or off by clicking its status. When off, the status is still shown but cannot be clicked.'],
  ['features.mismatchWarning', 'Mismatch warning', 'Show a warning when a file I open is different from the org.'],
  ['features.editorToolbarButtons', 'Editor toolbar buttons', 'Show the Open in Salesforce and Sales Grid buttons at the top right of the editor.'],
  ['features.rightClickMenus', 'Right-click menu entries', 'Show Open in Salesforce and Compare with Org when I right-click a file.'],
  ['debugLogs.openInNewWindow', 'Open logs in a new window', 'Open log, Open log with class and the Log Explorer open in a new maximized window (the taskbar stays visible), for following a log without the rest of VS Code in the way. Close it with the title-bar close button.'],
  ['executionHighlight.highlightOnLogOpen', 'Highlight a log when I open it', 'When I open an Apex debug log (.log) in the editor, highlight the lines it ran and open the class or trigger beside it.'],
  ['executionHighlight.showCounts', 'Run counts on highlighted lines', 'When a debug log is highlighted on my code, show how many times each line ran (×12) at the end of the line.'],
  ['executionHighlight.showDebugOutput', 'Debug output on highlighted lines', 'When a debug log is highlighted on my code, show each line’s System.debug output at the end of the line.'],
  ['executionHighlight.inferLines', 'Mark lines that most likely ran', 'For logs below Apex Code FINER, mark (dotted edge) the plain lines between two recorded lines that almost certainly ran. They are inferred, not in the log.']
];

const GENERAL = [
  ['expiryWarningDays', 'number', 'Expiry warning (days)', 'Warn when a scratch or trial org expires within this many days.'],
  ['autoRefreshSeconds', 'number', 'Auto refresh (seconds)', 'How often to ask the org whether the open component changed. 0 turns it off; a new value applies after a window reload.'],
  ['executionHighlight.hotLineThreshold', 'number', 'Busy line (runs)', 'A highlighted line that ran this many times or more is shown in yellow as a possible performance issue.'],
  ['cliPath', 'text', 'Salesforce CLI', 'Command or full path used to run the Salesforce CLI.']
];

function allKeys() {
  return [
    ...PLACES.flatMap(([place, , , master]) => [...(master ? [master] : []), ...DETAILS.map(([detail]) => `${place}.${detail}`)]),
    ...FEATURES.map(([key]) => key),
    ...GENERAL.map(([key]) => key)
  ];
}

function readState() {
  const config = vscode.workspace.getConfiguration('salesgrid');
  return Object.fromEntries(allKeys().map((key) => [key, config.get(key)]));
}

module.exports = { DETAILS, PLACES, FEATURES, GENERAL, allKeys, readState };
