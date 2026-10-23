const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Usernames and aliases are interpolated into a shell command, so anything
// outside this set is rejected rather than escaped.
const SAFE_TARGET = /^[\w.@+-]+$/;
const SAFE_NAME = /^\w+$/;
const RECORD_ID = /^[a-zA-Z0-9]{15,18}$/;
const LWC_FILE_PATH = /^lwc\/[\w./-]+$/;
const UNSAFE_PATH = /["`$%\r\n]/;

const DAY_MS = 24 * 60 * 60 * 1000;

const ORG_GROUPS = ['scratchOrgs', 'sandboxes', 'devHubs', 'nonScratchOrgs', 'other'];

function runSf(cliPath, args, options = {}) {
  const command = `"${cliPath}" ${args} --json`;
  const execOptions = {
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env
  };
  return new Promise((resolve, reject) => {
    exec(command, execOptions, (error, stdout, stderr) => {
      // The CLI still prints a JSON body on failure, so prefer its message.
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (e) {
        parsed = undefined;
      }

      if (parsed && parsed.status === 0) {
        resolve(parsed.result);
        return;
      }
      if (parsed && parsed.message) {
        const failure = new Error(cleanMessage(parsed.message));
        failure.result = parsed.result;
        reject(failure);
        return;
      }
      if (parsed && parsed.status) {
        const failure = new Error('The Salesforce CLI reported a failure.');
        failure.result = parsed.result;
        reject(failure);
        return;
      }
      if (error && /not recognized|not found|ENOENT/i.test(`${error.message} ${stderr}`)) {
        reject(new Error(`Salesforce CLI not found (tried "${cliPath}"). Install it or set salesgrid.cliPath.`));
        return;
      }
      reject(new Error((stderr || (error && error.message) || 'Salesforce CLI returned no output.').trim()));
    });
  });
}

// CLI errors arrive multi-line with a help footer; flatten them for a notification.
function cleanMessage(message) {
  return message
    .replace(/See more help with --help/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function assertSafeTarget(target) {
  if (!SAFE_TARGET.test(target || '')) {
    throw new Error(`Unsupported org username or alias: ${target}`);
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

// The CLI only reports sandbox/scratch flags and the edition, so "production"
// is inferred: a known, non-Developer edition with no expiry date.
function classify(org) {
  const host = hostOf(org.instanceUrl);
  const edition = org.orgEdition || '';
  if (org.isScratch || /\.scratch\./.test(host)) {
    return 'Scratch';
  }
  if (org.isSandbox || /\.sandbox\./.test(host)) {
    return 'Sandbox';
  }
  if (org.trailExpirationDate) {
    return 'Trial';
  }
  if (/developer/i.test(edition) || /\.develop\./.test(host)) {
    return 'Developer';
  }
  if (edition) {
    return 'Production';
  }
  return 'Org';
}

function daysUntil(dateText, now) {
  if (!dateText) {
    return undefined;
  }
  const time = new Date(dateText).getTime();
  if (Number.isNaN(time)) {
    return undefined;
  }
  return Math.ceil((time - now) / DAY_MS);
}

function toOrg(org, now) {
  const type = classify(org);
  // "trailExpirationDate" is the CLI's own spelling.
  const expirationDate = org.expirationDate || org.trailExpirationDate || '';
  const daysLeft = daysUntil(expirationDate, now);
  return {
    username: org.username,
    alias: org.alias || '',
    orgId: org.orgId || '',
    instanceUrl: org.instanceUrl || '',
    loginUrl: org.loginUrl || '',
    apiVersion: org.instanceApiVersion || '',
    edition: org.orgEdition || '',
    type,
    isProduction: type === 'Production',
    isDevHub: !!org.isDevHub,
    isDefault: !!org.isDefaultUsername,
    isDefaultDevHub: !!org.isDefaultDevHubUsername,
    status: org.connectedStatus || org.status || 'Unknown',
    expirationDate,
    daysLeft,
    isExpired: !!org.isExpired || (daysLeft !== undefined && daysLeft <= 0)
  };
}

async function listOrgs(cliPath, options = {}) {
  const result = await runSf(cliPath, 'org list', options);
  const now = options.now || Date.now();
  const byUsername = new Map();

  // A Dev Hub is also listed under nonScratchOrgs; keep the first copy.
  for (const group of ORG_GROUPS) {
    for (const org of result[group] || []) {
      if (org.username && !byUsername.has(org.username)) {
        byUsername.set(org.username, toOrg(org, now));
      }
    }
  }

  return [...byUsername.values()].sort((a, b) =>
    (a.alias || a.username).localeCompare(b.alias || b.username)
  );
}

// `target.path` opens a page inside the org; `target.sourceFile` lets the CLI
// pick the right builder for a local Flow or Lightning Page file.
async function getOpenUrl(cliPath, username, target = {}, options = {}) {
  assertSafeTarget(username);
  let args = `org open --url-only --target-org "${username}"`;
  const env = {};
  if (target.sourceFile) {
    if (UNSAFE_PATH.test(target.sourceFile)) {
      throw new Error(`Unsupported characters in file path: ${target.sourceFile}`);
    }
    args += ` --source-file "${target.sourceFile}"`;
  } else if (target.path) {
    // Passed through the environment so the URL never needs shell quoting.
    env.FORCE_OPEN_URL = target.path;
  }
  const result = await runSf(cliPath, args, { ...options, env });
  if (!result || !result.url) {
    throw new Error('Salesforce CLI did not return a URL.');
  }
  return result.url;
}

// Returns who created and last changed a component, or null when the org has
// no component with that name.
async function queryComponentInfo(cliPath, username, component, options = {}) {
  assertSafeTarget(username);
  if (!SAFE_NAME.test(component.name) || !SAFE_NAME.test(component.object) || !SAFE_NAME.test(component.nameField)) {
    throw new Error(`Unsupported component name: ${component.name}`);
  }
  if (component.bodyField && !SAFE_NAME.test(component.bodyField)) {
    throw new Error(`Unsupported component field: ${component.bodyField}`);
  }
  if (component.statusField && !SAFE_NAME.test(component.statusField)) {
    throw new Error(`Unsupported component field: ${component.statusField}`);
  }
  const extraFields = [component.bodyField, component.statusField].filter(Boolean).map((field) => `, ${field}`).join('');
  const soql =
    'SELECT Id, CreatedById, CreatedBy.Name, CreatedDate, LastModifiedById, LastModifiedBy.Name, LastModifiedDate' +
    `${extraFields} ` +
    `FROM ${component.object} WHERE ${component.nameField} = '${component.name}' ` +
    'ORDER BY LastModifiedDate DESC LIMIT 1';
  const [record] = await query(cliPath, username, soql, component.tooling, options);
  if (!record) {
    return null;
  }
  return {
    id: record.Id,
    createdById: record.CreatedById,
    // The name comes back null when the running user cannot see that user.
    createdByName: (record.CreatedBy && record.CreatedBy.Name) || 'Unknown user',
    createdDate: record.CreatedDate,
    lastModifiedById: record.LastModifiedById,
    lastModifiedByName: (record.LastModifiedBy && record.LastModifiedBy.Name) || 'Unknown user',
    lastModifiedDate: record.LastModifiedDate,
    body: component.bodyField ? record[component.bodyField] || '' : undefined,
    active: isActive(component, record)
  };
}

// A trigger carries a Status; a flow is active when it has an active version.
// Undefined for types that cannot be switched on and off.
function isActive(component, record) {
  if (!component.statusField) {
    return undefined;
  }
  const value = record[component.statusField];
  return component.statusField === 'Status' ? value === 'Active' : !!value;
}

// Lines covered by Apex tests in the org, from its last test runs, or null
// when the org has no coverage figures for this class or trigger.
async function queryCoverage(cliPath, username, id, options = {}) {
  assertSafeTarget(username);
  if (!RECORD_ID.test(id)) {
    throw new Error(`Unsupported record id: ${id}`);
  }
  const soql = `SELECT NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate WHERE ApexClassOrTriggerId = '${id}'`;
  const [record] = await query(cliPath, username, soql, true, options);
  if (!record) {
    return null;
  }
  return { covered: record.NumLinesCovered || 0, uncovered: record.NumLinesUncovered || 0 };
}

// A cheap "has it changed?" check: when the component was last modified in the
// org, or null when it is not there.
async function queryLastModified(cliPath, username, component, options = {}) {
  assertSafeTarget(username);
  if (!SAFE_NAME.test(component.name) || !SAFE_NAME.test(component.object) || !SAFE_NAME.test(component.nameField)) {
    throw new Error(`Unsupported component name: ${component.name}`);
  }
  const soql =
    `SELECT LastModifiedDate FROM ${component.object} WHERE ${component.nameField} = '${component.name}' ` +
    'ORDER BY LastModifiedDate DESC LIMIT 1';
  const [record] = await query(cliPath, username, soql, component.tooling, options);
  return record ? record.LastModifiedDate : null;
}

// Returns the org's copy of one file of a Lightning web component, or null
// when the bundle in the org has no such file.
async function queryLwcSource(cliPath, username, bundleId, filePath, options = {}) {
  assertSafeTarget(username);
  if (!RECORD_ID.test(bundleId) || !LWC_FILE_PATH.test(filePath)) {
    throw new Error(`Unsupported component file: ${filePath}`);
  }
  const soql =
    'SELECT Source FROM LightningComponentResource ' +
    `WHERE LightningComponentBundleId = '${bundleId}' AND FilePath = '${filePath}' LIMIT 1`;
  const [record] = await query(cliPath, username, soql, true, options);
  return record ? record.Source || '' : null;
}

let api;

// Hands queries to the direct API client, which is far faster than starting
// the CLI for each one.
function useApi(client) {
  api = client;
}

// Problems reaching the org through the API (as opposed to a bad query) fall
// back to the CLI, so a missing or broken token never stops the extension.
function isConnectionProblem(error) {
  return !error.status || error.status === 401 || error.status >= 500;
}

async function query(cliPath, username, soql, tooling, options = {}) {
  assertSafeTarget(username);
  if (api && !options.useCli) {
    try {
      return await api.query(username, soql, { tooling, cwd: options.cwd });
    } catch (error) {
      if (!isConnectionProblem(error)) {
        throw error;
      }
    }
  }
  const flag = tooling ? ' --use-tooling-api' : '';
  const result = await runSf(cliPath, `data query${flag} --target-org "${username}" --query "${soql}"`, options);
  return (result && result.records) || [];
}

function assertRecordId(id) {
  if (!RECORD_ID.test(id || '')) {
    throw new Error(`Unsupported record id: ${id}`);
  }
}

async function withTempDir(task) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'salesgrid-'));
  if (UNSAFE_PATH.test(dir)) {
    throw new Error(`Unsupported characters in temporary folder path: ${dir}`);
  }
  try {
    return await task(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

function deployFailure(error) {
  const details = error.result && error.result.details;
  const failures = details && details.componentFailures;
  const list = Array.isArray(failures) ? failures : failures ? [failures] : [];
  const problems = list.map((failure) => failure.problem).filter(Boolean);
  const tests = details && details.runTestResult && details.runTestResult.failures;
  const failedTests = (Array.isArray(tests) ? tests : tests ? [tests] : []).map(
    (test) => `${test.name}.${test.methodName}: ${test.message}`
  );
  const all = [...problems, ...failedTests];
  if (all.length) {
    return new Error(cleanMessage(all.join(' ')));
  }
  const reason = error.result && (error.result.errorMessage || error.result.status);
  return reason ? new Error(`The deployment did not succeed (${cleanMessage(String(reason))}).`) : error;
}

// Switches a trigger on or off. Salesforce only allows this through a
// deployment, so the trigger is redeployed with the org's own code and the new
// status; local edits are never sent. `dryRun` validates without saving.
async function setTriggerActive(cliPath, username, id, active, options = {}) {
  assertSafeTarget(username);
  assertRecordId(id);
  const [trigger] = await query(
    cliPath,
    username,
    `SELECT Id, Name, NamespacePrefix, Body, ApiVersion FROM ApexTrigger WHERE Id = '${id}'`,
    false,
    options
  );
  if (!trigger) {
    throw new Error('The trigger no longer exists in the org.');
  }
  if (trigger.NamespacePrefix) {
    throw new Error(`${trigger.Name} belongs to the managed package "${trigger.NamespacePrefix}" and cannot be changed.`);
  }
  if (!SAFE_NAME.test(trigger.Name)) {
    throw new Error(`Unsupported trigger name: ${trigger.Name}`);
  }
  const apiVersion = Number(trigger.ApiVersion).toFixed(1);
  const status = active ? 'Active' : 'Inactive';
  const metadata = 'http://soap.sforce.com/2006/04/metadata';

  await withTempDir(async (dir) => {
    const triggers = path.join(dir, 'triggers');
    await fs.promises.mkdir(triggers);
    await fs.promises.writeFile(
      path.join(dir, 'package.xml'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="${metadata}">\n  <types>\n    <members>${trigger.Name}</members>\n    <name>ApexTrigger</name>\n  </types>\n  <version>${apiVersion}</version>\n</Package>\n`
    );
    await fs.promises.writeFile(path.join(triggers, `${trigger.Name}.trigger`), trigger.Body || '');
    await fs.promises.writeFile(
      path.join(triggers, `${trigger.Name}.trigger-meta.xml`),
      `<?xml version="1.0" encoding="UTF-8"?>\n<ApexTrigger xmlns="${metadata}">\n  <apiVersion>${apiVersion}</apiVersion>\n  <status>${status}</status>\n</ApexTrigger>\n`
    );
    const dryRun = options.dryRun ? ' --dry-run' : '';
    try {
      await runSf(
        cliPath,
        `project deploy start --metadata-dir "${dir}" --target-org "${username}" --wait 30${dryRun}`,
        options
      );
    } catch (error) {
      throw deployFailure(error);
    }
  });

  if (!options.dryRun) {
    const [after] = await query(cliPath, username, `SELECT Status FROM ApexTrigger WHERE Id = '${id}'`, false, options);
    if (!after || (after.Status === 'Active') !== active) {
      throw new Error(`The org still reports ${trigger.Name} as ${after ? after.Status : 'missing'}.`);
    }
  }
  return { name: trigger.Name };
}

// The version that would become active, for the confirmation prompt.
async function getFlowVersions(cliPath, username, id, options = {}) {
  assertSafeTarget(username);
  assertRecordId(id);
  const [flow] = await query(
    cliPath,
    username,
    `SELECT Id, DeveloperName, ActiveVersionId, ActiveVersion.VersionNumber, LatestVersion.VersionNumber FROM FlowDefinition WHERE Id = '${id}'`,
    true,
    options
  );
  if (!flow) {
    throw new Error('The flow no longer exists in the org.');
  }
  return {
    name: flow.DeveloperName,
    activeVersion: flow.ActiveVersion ? flow.ActiveVersion.VersionNumber : undefined,
    latestVersion: flow.LatestVersion ? flow.LatestVersion.VersionNumber : undefined
  };
}

// Activates the given version of a flow, or deactivates the flow with version 0.
async function setFlowActiveVersion(cliPath, username, id, versionNumber, apiVersion, options = {}) {
  assertSafeTarget(username);
  assertRecordId(id);
  if (!Number.isInteger(versionNumber) || versionNumber < 0) {
    throw new Error(`Unsupported flow version: ${versionNumber}`);
  }
  if (!/^\d+\.\d+$/.test(apiVersion || '')) {
    throw new Error('The API version of the org is not known. Refresh the org list and try again.');
  }
  const update = { Metadata: { activeVersionNumber: versionNumber } };
  if (api) {
    await api.request(username, 'PATCH', `sobjects/FlowDefinition/${id}`, update, { tooling: true, cwd: options.cwd });
  } else await withTempDir(async (dir) => {
    const body = path.join(dir, 'body.json');
    await fs.promises.writeFile(body, JSON.stringify(update));
    await runSf(
      cliPath,
      `api request rest "/services/data/v${apiVersion}/tooling/sobjects/FlowDefinition/${id}" --method PATCH --body "@${body}" --target-org "${username}"`,
      options
    );
  });
  // The request reports little, so ask the org what is active now.
  const after = await getFlowVersions(cliPath, username, id, options);
  const expected = versionNumber || undefined;
  if (after.activeVersion !== expected) {
    throw new Error(
      `The org still reports ${after.name} as ${after.activeVersion ? `active on version ${after.activeVersion}` : 'inactive'}.`
    );
  }
  return after;
}

// Removes the org's saved login from this computer. The org itself is untouched.
async function logout(cliPath, username, options = {}) {
  assertSafeTarget(username);
  await runSf(cliPath, `org logout --target-org "${username}" --no-prompt`, options);
}

module.exports = {
  runSf,
  useApi,
  query,
  listOrgs,
  getOpenUrl,
  queryComponentInfo,
  queryLwcSource,
  queryCoverage,
  queryLastModified,
  setTriggerActive,
  getFlowVersions,
  setFlowActiveVersion,
  logout,
  classify
};
