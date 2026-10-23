// Maps a local source file to the Salesforce component it belongs to, and
// builds the Setup paths used to open that component or a user in the org.

const path = require('path');

// `object`/`nameField` say where the component's audit fields live. Types
// without them (FlexiPage) can be opened in the org but have no info to show.
// `bodyField` holds the component's source, used to compare org and local code.
// `statusField` tells whether a trigger or flow is active; `coverage` marks
// types that have Apex test coverage.
// `viaCli` types are opened by `sf org open --source-file`, which knows their builders.
const TYPES = {
  ApexClass: { label: 'Apex Class', object: 'ApexClass', nameField: 'Name', bodyField: 'Body', coverage: true, setup: 'ApexClasses' },
  ApexTrigger: { label: 'Apex Trigger', object: 'ApexTrigger', nameField: 'Name', bodyField: 'Body', statusField: 'Status', coverage: true, setup: 'ApexTriggers' },
  ApexPage: { label: 'Visualforce Page', object: 'ApexPage', nameField: 'Name', bodyField: 'Markup', setup: 'ApexPages' },
  ApexComponent: { label: 'Visualforce Component', object: 'ApexComponent', nameField: 'Name', bodyField: 'Markup', setup: 'ApexComponents' },
  LightningComponentBundle: {
    label: 'Lightning Web Component',
    object: 'LightningComponentBundle',
    nameField: 'DeveloperName',
    tooling: true,
    setup: 'LightningComponentBundles'
  },
  AuraDefinitionBundle: {
    label: 'Aura Component',
    object: 'AuraDefinitionBundle',
    nameField: 'DeveloperName',
    tooling: true,
    setup: 'LightningComponentBundles'
  },
  Flow: { label: 'Flow', object: 'FlowDefinition', nameField: 'DeveloperName', statusField: 'ActiveVersionId', tooling: true, viaCli: true },
  FlexiPage: { label: 'Lightning Page', viaCli: true }
};

const FILE_SUFFIXES = [
  [/\.cls(-meta\.xml)?$/i, 'ApexClass'],
  [/\.trigger(-meta\.xml)?$/i, 'ApexTrigger'],
  [/\.page(-meta\.xml)?$/i, 'ApexPage'],
  [/\.component(-meta\.xml)?$/i, 'ApexComponent'],
  [/\.flow-meta\.xml$/i, 'Flow'],
  [/\.flexipage-meta\.xml$/i, 'FlexiPage']
];

const SAFE_NAME = /^\w+$/;

function make(type, name) {
  if (!SAFE_NAME.test(name)) {
    return undefined;
  }
  return { type, name, ...TYPES[type] };
}

function resolveComponent(filePath) {
  if (!filePath) {
    return undefined;
  }
  const parts = filePath.split(/[\\/]/);

  // Any file inside lwc/<name>/ or aura/<name>/ belongs to that bundle.
  for (let i = parts.length - 3; i >= 0; i--) {
    if (parts[i] === 'lwc') {
      return make('LightningComponentBundle', parts[i + 1]);
    }
    if (parts[i] === 'aura') {
      return make('AuraDefinitionBundle', parts[i + 1]);
    }
  }

  const fileName = path.basename(filePath);
  for (const [suffix, type] of FILE_SUFFIXES) {
    if (suffix.test(fileName)) {
      return make(type, fileName.replace(suffix, ''));
    }
  }
  return undefined;
}

// Says how to fetch the org's copy of this exact file, or undefined when the
// file cannot be compared (metadata XML, Aura, Flows, Jest tests).
function comparableSource(filePath, component) {
  if (!component || /-meta\.xml$/i.test(filePath)) {
    return undefined;
  }
  if (component.bodyField) {
    return { kind: 'body' };
  }
  if (component.type === 'LightningComponentBundle') {
    const parts = filePath.split(/[\\/]/);
    const start = parts.lastIndexOf('lwc');
    const relative = parts.slice(start).join('/');
    if (start < 0 || parts.includes('__tests__') || !/^lwc\/[\w./-]+$/.test(relative)) {
      return undefined;
    }
    return { kind: 'lwc', filePath: relative };
  }
  return undefined;
}

function setupPath(component, id) {
  return `/lightning/setup/${component.setup}/page?address=${encodeURIComponent(`/${id}`)}`;
}

function userSetupPath(userId) {
  return `/lightning/setup/ManageUsers/page?address=${encodeURIComponent(`/${userId}?noredirect=1`)}`;
}

module.exports = { TYPES, resolveComponent, comparableSource, setupPath, userSetupPath };
