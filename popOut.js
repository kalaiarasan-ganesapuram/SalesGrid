// Moves the active editor (or group) into a window of its own and maximizes
// that window, so a debug log (and the class it ran) can be followed without
// the rest of the workbench in the way. Off with salesgrid.debugLogs.openInNewWindow.

const vscode = require('vscode');
const { execFile } = require('child_process');

function wanted() {
  return vscode.workspace.getConfiguration('salesgrid').get('debugLogs.openInNewWindow') !== false;
}

// Returns true when the editor now sits in a new window. Builds without
// auxiliary windows reject the command; the editor then stays where it is.
async function moveToNewWindow() {
  if (!wanted()) {
    return false;
  }
  try {
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    return true;
  } catch {
    return false;
  }
}

// Moves the whole active editor group (for example a log and its class).
async function moveGroupToNewWindow() {
  if (!wanted()) {
    return false;
  }
  try {
    await vscode.commands.executeCommand('workbench.action.moveEditorGroupToNewWindow');
    return true;
  } catch {
    return false;
  }
}

// VS Code opens a new window at 800x640 and has no command to maximize it, and
// full screen would cover the taskbar. On Windows, ask the OS to maximize the
// window in front (the new one), which keeps the taskbar visible; only a VS
// Code window is touched. Elsewhere the window keeps its size and its own
// maximize button.
const MAXIMIZE_SCRIPT = [
  "Add-Type -Namespace SalesGrid -Name Win -MemberDefinition '",
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
  '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
  "';",
  '$h = [SalesGrid.Win]::GetForegroundWindow();',
  '$p = 0; [void][SalesGrid.Win]::GetWindowThreadProcessId($h, [ref]$p);',
  "if ((Get-Process -Id $p).ProcessName -match '^Code') { [void][SalesGrid.Win]::ShowWindow($h, 3) }"
].join(' ');

function maximize() {
  if (process.platform !== 'win32' || process.env.SALESGRID_NO_MAXIMIZE) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    // A moment for the new window to appear and take focus.
    setTimeout(() => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', MAXIMIZE_SCRIPT], { windowsHide: true, timeout: 10000 }, () => resolve());
    }, 400);
  });
}

module.exports = { moveToNewWindow, moveGroupToNewWindow, maximize, wanted };
