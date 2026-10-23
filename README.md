# Sales Grid

A VS Code extension for Salesforce developers. It lists every org you are connected to, opens any of them in the browser, and tells you whether the file you are editing matches the org and who last changed it there.

## Requirements

- VS Code 1.85 or later
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) on your PATH, with at least one authorized org (`sf org login web`)

## Connected Orgs

Click the Sales Grid icon in the Activity Bar: the Sales Grid page opens in the editor area (the side bar closes again). Its **Salesforce Orgs** tab shows each org by alias, with its username, type, edition, instance and days left before it expires; pinned orgs come first and orgs whose login has expired last.

| Action | How |
| --- | --- |
| Open org in browser | **Open** |
| Copy open URL | **Copy URL** |
| Log in again | **Re-login** (shown first on an org whose login expired) |
| Remove an org | **Remove**, on an org whose login expired |
| Pin to top, colour, copy username | **More** |
| Reload the list | **Refresh** |


**Keeps itself up to date.** The list reloads by itself when you log in to or out of an org, change an alias or change the default org anywhere, including in a terminal, and after any Sales Grid action that changes an org. It also reloads when you come back to VS Code after ten minutes or more, since an org's connection can expire in the meantime.

**Order.** Pinned orgs come first. Orgs that are expired or cannot be reached are always listed last.

**Icons.** A star marks a pinned org, a cloud a connected org, a watch an org that expires soon, and a warning triangle an org whose login has expired or cannot be reached.

**Production.** Production orgs are shown in red with a **P** badge so they are hard to open by mistake. An org counts as production when the CLI reports an edition other than Developer Edition and it is not a sandbox, scratch org or trial. You can override the colour of any org with **Set Colour Label...**.

**Expiry.** Scratch orgs and trial orgs show the days they have left. You get one warning per session for each org that expires within `salesgrid.expiryWarningDays` days.

**Log In Again.** Runs `sf org login web` for that org in a terminal and tells you whether the login finished. The same button is offered when opening an org fails because its session has expired. Expired scratch orgs cannot be logged in to again.

**Remove Org.** Only offered for orgs that are expired or cannot be reached, and always asks for confirmation first. It deletes the saved login from your computer (`sf org logout`); the org itself is not changed.

## The file you are editing

When you open an Apex class, Apex trigger, Visualforce page or component, Lightning web component, Aura component or Flow, Sales Grid looks it up in your org and shows the result in two places: as links above the first line of the file, and in the status bar at the bottom of the window. A spinner is shown in both while the org is being asked. Nothing has to be opened first; the details appear as soon as the file does.

| Shown | Click it to |
| --- | --- |
| **Open in Salesforce** | Open the component in the org's Setup page, or in its builder for Flows and Lightning Pages |
| **Same as _org_** / **Different from _org_** | Open a side-by-side comparison of the org's code and yours |
| **Active** / **Inactive** (Apex triggers and Flows) | Switch it on or off in the org, after you confirm |
| **Coverage** _percent_ | Apex test coverage of a class or trigger in the org, from its last test runs |
| **Created by** _name_ · _date and time_ | Open that user in Setup |
| **Last modified by** _name_ · _date and time_ | Open that user in Setup |

**Status bar.** Shows **Open in Salesforce**, the active state, org test coverage, **Created by** and **Last modified by** with date and time for the current component. These sit to the right of other extensions' status bar items. Click the first to open the component in the org, or a name to open that user in Setup.

**Toolbar icons.** At the top right of the editor, the arrow icon opens the current file in Salesforce, and the Sales Grid icon opens the Sales Grid page. **Open Current File in Salesforce** is also on the right-click menu of the editor and the Explorer.

**Switching away.** When you move to something that is not a file, such as a chat panel, the details of the last component stay on screen.

**Activate or deactivate.** Click **Active** or **Inactive** on a trigger or flow, in any of the three places, to switch it. You are always asked to confirm first, and the new state is shown everywhere as soon as the org reports it. For a flow, activating makes the latest version active. For a trigger, Salesforce only allows the change through a deployment: Sales Grid redeploys the trigger with the code already in the org, so local edits are not sent, and then sets `<status>` in the local `.trigger-meta.xml` to match. In a production org that deployment runs the Apex tests first.

If the saved file is different from the org, you also get a warning with a **Compare** button, once per file for each version in the org.

Code is compared for Apex classes, Apex triggers, Visualforce pages and components, and each file of a Lightning web component. Aura components, Flows and `-meta.xml` files show who created and changed them but are not compared.

**Which org.** The project's default org is used (`sf config set target-org`). If there is none and you have several orgs, run **Sales Grid: Select Org for Current File** to choose one; the choice is remembered for the workspace.

**After a deploy.** The details update by themselves. Sales Grid asks the org when the open component was last modified every `salesgrid.autoRefreshSeconds` seconds while the window is in use, a few seconds after each save, and whenever you come back to the window. If that time has moved, the details, comparison and coverage are re-read. To force it, run **Sales Grid: Check Current File Against Org Again** from the Command Palette.

## Messages

Every action shows a notification saying whether it worked. On failure the notification gives the reason with **Retry** and **Show Log** buttons; the full history is in the **Sales Grid** output channel.

A copied open URL signs in to the org without a password and stays valid for a short time. Treat it like a credential.

## Debug logs

Click the Sales Grid icon in the Activity Bar to open the Sales Grid page, or press `Ctrl+Shift+P` and run **Sales Grid: Home**. Pick the org at the top right.

**Debug Logs tab**

The tab shows the everyday controls; everything else is one click away under **Options** or **More**. A spinner appears in the part of the page that is waiting for the org, and on the button you pressed.

- **Start logging** for yourself, 1 hour at the Standard level by default. **Options** next to it chooses the debug level by name: Sales Grid's own levels (**SalesGrid_Standard**, the default: Apex Code at FINER, the least that records every line that ran and all debug output, with queries and DML from Database at INFO; SalesGrid_ApexDetail, SalesGrid_Everything, SalesGrid_ErrorsOnly; each is created the first time it is used) or any other debug level in the org (for example SFDC_DevConsole), then 30 minutes to 24 hours, or another user, who gets the same debug level list. While it is on, the page shows the time left, with buttons to add 30 minutes or stop.
- **Log list**: every debug log in the org, newest first. Each row shows what ran, when and by whom, a green or red dot for success or failure, and the duration. **All / Mine / Errors** and the search box filter it. Typing filters by operation, user and status.
- **More** (next to refresh) adds a filter by user, **Requested by me**, **Live** and delete.
- **Requested by me**: shows only the logs you asked for: your own, plus those of users whose debug logging you turned on, recorded while it was on. Useful when other people's activity fills the list.
- **Deleting**: with no filter on, the trash icon deletes every log in the org. With any filter on (Requested by me, a user, Mine, Errors, or a search), it deletes only the logs shown. You always confirm first.
- **Search inside logs**: type words and press `Enter` to find the logs whose contents contain them, for example `attempt to dereference`. Spacing and punctuation are ignored, so that also finds "Attempt to de-reference". Each matching log shows how many times the words appear and the line they appear in, highlighted. **Live** checks for new logs every 10 seconds while the page is open. The trash icon deletes all logs after you confirm.
- **Log details**: click a log to see its duration, SOQL, DML and CPU time as meters, then errors and exceptions with line numbers, debug output, every SOQL query with its row count, every DML statement, and the other limits (query rows, heap, callouts). **Highlight in code** colours the lines this log ran in your classes and triggers (see below).
- **Timeline**: switch a log from **Summary** to **Timeline** to see every event in order, colour-coded by kind (errors red, debug green, SOQL blue, DML orange, methods purple, and so on). Click the kinds to show or hide them, or **Errors only**. Type a keyword to highlight it and jump between matches with `Enter` / `Shift+Enter` or the arrows. Click any event to read it in full. Clicking an error, debug line or query in the summary opens the timeline at that event. Logs found by a keyword open on the timeline with the keyword highlighted.
- **Open log** opens the full log in the editor. **More** copies every debug line at once, saves the log anywhere, copies its ID, deletes it, or opens it in the Apex Replay Debugger when the Salesforce Extension Pack is installed.

## See what a debug log ran, on your code

Open the Sales Grid page (the Sales Grid icon in the Activity Bar) and its **Debug Logs** tab. It works with the project's org.

**1. Turn debugging on.** Click **Start logging** on the Debug Logs tab, or run **Sales Grid: Enable Debugging** from the Command Palette. Choose yourself or another user, the detail (**FINER**, recommended, or **FINEST**, which adds variable values) and how long (30 minutes to 24 hours). Sales Grid uses a debug level named **Sales Grid** (API name `Sales_Grid`): Apex Code at FINER or FINEST, Apex Profiling, Callout, Database, Validation, Visualforce and Workflow at INFO, System at DEBUG, so logs stay small. It is created the first time; if it already exists with other settings you are asked before it is changed. Salesforce allows one trace flag per user and type, so a flag that is already running is reused (and you are told which level it had) rather than a clashing second one being made. The stop icon turns it off again; only Sales Grid's flags are removed.

**2. Pick a log.** Run your code, then pick a log in the Debug Logs tab (double-click opens it). After the duration of each log are two buttons: **Open log** and **Open log with class** (the log, with the class it ran beside it, highlighted). **Sales Grid: Open Debug Log File...** in the Command Palette takes any `.log` file, and opening any debug log in the editor picks it too.

**3. Highlight.** With a log in use, Apex classes and triggers get a Sales Grid button with a green play badge at the top right of the editor. Click it, or **Highlight in code** on the Sales Grid page. Every class and trigger the log touched is coloured as you open it:

| Colour | Means |
| --- | --- |
| Green | The log shows this line ran. A faint `×12` at the end says how often. |
| Red | An exception was thrown here. The end of the line names it. |
| Yellow | Ran unusually often (`Busy line` setting, 50 by default), or a query or DML ran more than once from this line. |
| No colour | The log does not say. A line without colour is "not recorded", never "did not run". |

The eye button turns highlighting off. `↩ resumed here` marks where execution carried on after an exception, usually a catch block.

**Hover** a coloured line for what the log recorded there: how many times it ran and in which method, the exception with its message, whether it was handled and where execution continued, the call stack, the methods it called, SOQL with rows, DML, debug output, and variable values when logged at FINEST. Nothing is shown that the log does not contain. **Inspect** lists every recorded execution of the line; pick one to replay from there. **Show in log** opens the raw log at that event.

**Replay** (Command Palette, or **Replay from here** in a hover) walks the recorded events in order, across classes and triggers: statements, method calls, queries, DML, debug lines, exceptions and the catch blocks that followed. Use the arrows at the top of the editor or `Alt+]` / `Alt+[`; the status bar step counter opens more controls (next exception, next method or file, next query). It replays the log; it is not a live debugger.

**Performance summary** (Command Palette) lists governor-limit use, methods by time, and findings marked **confirmed** (read from the log: repeated queries, recursion, a trigger firing again inside itself, limits above 80%) or **inferred** (likely causes to check, such as SOQL or DML inside a loop).

**Things the log cannot tell you**, and how Sales Grid handles them:

- Statements are only logged at Apex Code FINER or FINEST. Logs at lower levels still show lines with calls, queries, DML, debug output and exceptions, with a note saying statements were not recorded.
- Salesforce cuts logs at 20 MB. A cut log is flagged, and lines after the cut stay uncoloured.
- A catch block is inferred from where execution resumed after an exception, and is labelled as such.
- If the file changed since the log was recorded (a call the log saw is no longer on that line, or a line that ran is now blank or a comment), the status bar turns amber and hovers say the lines may not match.
- A log from another org than the project's asks before highlighting. Each downloaded log remembers its org.
- A debug log never proves full code coverage; use test coverage for that.

Logs are read on your computer only; nothing is sent to any other service.

**Open in new window**: the button at the top right of the Sales Grid page moves it to its own maximized window for more width. There the button hides; close the window with its own close button.

**Debug Mode tab**: Lightning debug mode, separate from debug logs. When it is on, Lightning components run unminified, so browser errors show readable code and real line numbers, and pages load more slowly. Search for a user (yourself included) to turn it on for them, and see everyone who has it on, with a **Turn off** button for each. Changing other users needs the Manage Users permission.

**Log Explorer**: a view of one debug log in a window of its own. Open it with the button on the title bar of any open `.log` file, or **Log Explorer** on a log in the Home page. It shows every trigger and class the log ran, in run order, each with its whole source: lines that ran in green, lines that ran often in yellow, exception lines in red, and under each line its debug output, queries (rows and time) and DML. Exceptions are listed at the top in red with the message, what happened next, the stack trace and the fatal error text, and all debug output is listed in order. Click any line to open it in the editor.

Below Apex Code FINER the log records only lines that wrote an event (a query, DML, debug output, an exception). Plain lines between two recorded lines of the same run, with no branch in between, and the line that calls a method the log shows running, are marked as **most likely ran** (dotted edge, faint background); hover says why. Each highlighted line shows its debug output at its end, and its hover lists only what happened on it, each with its exact time. Turn these off with `salesgrid.executionHighlight.showDebugOutput` and `salesgrid.executionHighlight.inferLines`.

**Opening logs**: in the Home page log list, each log has **Open log** and **Open log with class** buttons after its duration, and double-clicking a log opens it. Open log with class shows the log on the left and, on the right, one page with the code that ran: each trigger first with all its lines, then each class, the lines that ran highlighted. Open log, Open log with class and the Log Explorer open in a new maximized window (the taskbar stays visible); close it with the window's own close button, or turn this off with `salesgrid.debugLogs.openInNewWindow`.

When a log has no method entries (Apex Code below FINE), it does not say which class ran a query. Sales Grid then checks the workspace source and puts the query, DML or debug line on the class whose line actually holds it.

**Run Apex tab**: run anonymous Apex in the selected org, as in the Developer Console. Press the green play button to run it. Compile errors and exceptions are shown with their line, and the log of the run is summarised underneath. If logging is off, it is switched on for 15 minutes so the run produces a log. Your code is kept between sessions.

**Debug logging for another user**: click **For another user…** on the Debug Logs tab, or use the top of the Trace Flags & Levels tab. Search active users by name or username, pick one, choose the detail level and how long, and start. Their logs then appear in the log list (use **All**, not **Mine**). This needs the Manage Users permission.

**Trace Flags & Levels tab**: every trace flag in the org (who or what is traced, the debug level, time left), with buttons to extend or delete each one and **Delete expired** to clear out every expired flag at once, and every debug level with a drop-down per category to change and save it. The levels Sales Grid creates are named `SalesGrid_...`.

## Speed

Sales Grid talks to Salesforce directly instead of starting the Salesforce CLI for each question. The CLI is used once per org to sign in; after that a lookup takes well under a tenth of a second instead of about two seconds. The sign-in is kept in memory only, never written to disk, and if a direct request cannot reach the org, Sales Grid falls back to the CLI.

It also remembers what it already knows:

- The org list from last time appears at once when VS Code starts, and is replaced when the fresh list arrives.
- Created by, last modified, coverage and active status for files you have opened before appear at once and are then checked against the org.
- Downloaded logs are saved and never downloaded twice. Inside a Salesforce project they go to `.sfdx/tools/debug/logs`, where the Salesforce extensions also look.
- The status bar repaints once you pause typing, not on every keystroke.

No connected app is needed: Sales Grid uses the login you made with `sf org login web`. Your user needs the usual permissions: API Enabled, plus View Setup and Configuration for logs and trace flags, and Author Apex to run Apex.

## Configuration

Everything is set on one page. It is the **Configuration** tab of the Sales Grid page. Open it with the gear icon on either Sales Grid view, or press `Ctrl+Shift+P` and run **Sales Grid: Home**. The Command Palette also has the debug log commands (enable or disable debugging, open a log file, and, while a log is in use, highlight, replay and the performance summary); every other action is a button, a link or a right-click entry. Changes are saved and applied as you make them.

### Where details are shown

A grid of tick boxes: one row per detail, one column per place.

| Detail | Footer | Inside the file | Sales Grid panel |
| --- | --- | --- | --- |
| Open in Salesforce | on | on | on |
| Same as / Different from org | off | on | on |
| Active / Inactive | on | on | on |
| Test coverage | on | on | on |
| Created by | on | on | on |
| Last modified by | on | on | on |

The values above are the defaults. The first row of the page switches the whole footer, or everything inside the file, on or off.

### Features

- **Activate / deactivate**: switch a trigger or flow on or off by clicking its status. When off, the status is still shown but cannot be clicked.
- **Mismatch warning**: the warning shown when a file you open is different from the org.
- **Editor toolbar buttons**: the Open in Salesforce and Sales Grid buttons at the top right of the editor.
- **Right-click menu entries**: Open in Salesforce and Compare with Org on the editor and Explorer menus.
- **Run counts on highlighted lines**: the `×12` shown at the end of a line that a debug log ran more than once.

The highlight colours follow your theme and can be changed under `workbench.colorCustomizations` (`salesgrid.executedLineBackground`, `salesgrid.exceptionLineBackground`, `salesgrid.hotLineBackground` and their `...Marker` edges).

### General

- **Expiry warning (days)**: warn when a scratch or trial org expires within this many days. Defaults to 7.
- **Auto refresh (seconds)**: how often to ask the org whether the open component changed. Each check is one API call. Defaults to 30; 0 turns it off.
- **Busy line (runs)**: a highlighted line that ran this many times or more is yellow. Defaults to 50.
- **Salesforce CLI**: command or full path for the CLI. Defaults to `sf`.

The same options are also listed under **Sales Grid** in the VS Code Settings editor, with names starting `salesgrid.`.

## Running it from source

**Try it without installing:** open this folder in VS Code and press `F5`. A second VS Code window opens with the extension loaded.

**Build and install:**

```
npx @vscode/vsce package
code --install-extension sales-grid-0.1.4.vsix
```

## Files

- `package.json`: extension manifest (views, commands, menus, settings)
- `extension.js`: views, commands and notifications
- `sfCli.js`: wrapper around the Salesforce CLI
- `component.js`: maps a source file to its Salesforce component and Setup page
- `salesGridPage.js`: the Sales Grid page (debug logs, Run Apex, trace flags, configuration)
- `resources/page/`: the page's style sheet and script
- `configPage.js`: what the Configuration tab offers
- `sfApi.js`: direct connection to the Salesforce API
- `debug.js`: debug logs, trace flags, debug levels, debug mode and anonymous Apex
- `logParser.js`: turns a debug log into its summary
- `executionAnalyzer.js`: rebuilds the path a transaction took from its log (lines, methods, exceptions, order); no VS Code code, so it is tested on its own
- `executionView.js`: the debug log list behind the commands, source highlighting, hovers, replay and the debugging commands
- `test/`: `node --test test/` runs the tests (analyser, debug level handling, and the highlighter against a stand-in for VS Code)
- `resources/highlight.png`: editor toolbar icon for highlighting (logo mark with a play badge)
- `resources/icon.png`: extension icon (full colour)
- `resources/activitybar.png`: Activity Bar icon (single-colour version of the logo mark)
- `resources/toolbar.png`: editor toolbar icon (full-colour logo mark)
