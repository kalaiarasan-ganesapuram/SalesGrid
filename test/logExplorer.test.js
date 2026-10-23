// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

// logExplorer requires 'vscode'; only the pure HTML builder is tested here.
const original = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? {} : original.call(this, request, ...rest);
};
const { buildHtml, filesInRunOrder } = require('../logExplorer');
Module._load = original;
const { analyzeLog, fileKey } = require('../executionAnalyzer');
const { parseLog } = require('../logParser');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const source = (relative) => fs.readFileSync(path.join(__dirname, 'fixtures', 'force-app', 'main', 'default', relative), 'utf8').split(/\r?\n/);

test('explorer page: trigger and classes in run order, full source, exceptions in red with stack', () => {
  const text = fixture('trigger-chain.log');
  const a = analyzeLog(text);
  a.summary = parseLog(text);
  const files = filesInRunOrder(a);
  assert.equal(files[0].kind, 'trigger', 'the trigger ran first');
  const sources = new Map([[fileKey('trigger', 'AccountTrigger'), source('triggers/AccountTrigger.trigger')]]);
  const html = buildHtml(a, sources, { nonce: 'n1', title: 'Log Explorer: test', hotThreshold: 50 });
  assert.match(html, /script-src 'nonce-n1'/);
  assert.match(html, /<span class="badge trigger">Trigger<\/span> AccountTrigger/);
  for (const f of files) {
    assert.ok(html.includes(`id="${f.key}"`), `${f.name} has a section`);
  }
  assert.ok(a.exceptions.length > 0);
  assert.match(html, /class="exception"/);
  assert.match(html, /Stack trace/);
  assert.match(html, /class="row exception"/);
  assert.match(html, /is not in this workspace/, 'classes without source still list their recorded lines');
});

test('explorer page escapes log text', () => {
  const text = fixture('no-method-entries.log').replace('starting', '<img src=x onerror=alert(1)>');
  const a = analyzeLog(text, { knownClasses: ['TicketJob'] });
  a.summary = parseLog(text);
  const html = buildHtml(a, new Map(), { nonce: 'n', title: 't' });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x'));
});

test('Apex colouring: keywords, SOQL, strings, comments across lines, and code is still escaped', () => {
  const Module = require('module');
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? {} : load.call(this, request, ...rest);
  };
  const { highlightApex } = require('../logExplorer');
  Module._load = load;
  const one = highlightApex("if (x < 1) { List<Account> a = [SELECT Id FROM Account WHERE Name = '<b>']; } // done", false);
  assert.match(one.html, /<span class="t-control">if<\/span>/);
  assert.match(one.html, /<span class="t-soql">SELECT<\/span>/);
  assert.match(one.html, /<span class="t-type">Account<\/span>/);
  assert.match(one.html, /<span class="t-string">&#39;&lt;b&gt;&#39;<\/span>/, 'string text escaped');
  assert.match(one.html, /<span class="t-comment">\/\/ done<\/span>/);
  assert.ok(!/<b>/.test(one.html));
  const start = highlightApex('Integer n = 1; /* starts', false);
  assert.equal(start.inComment, true);
  const next = highlightApex('ends */ return n;', start.inComment);
  assert.match(next.html, /^<span class="t-comment">ends \*\/<\/span>/);
  assert.match(next.html, /<span class="t-control">return<\/span>/);
  assert.equal(next.inComment, false);
});

test('code that ran: one section per trigger run, only the branch each run took, and closing braces only when their block ran', () => {
  const trigger = [
    'trigger DemoTrigger on Account (before update, after update) {',
    '    for (Account acc : Trigger.new) {',
    '        if (acc.Name != null) {',
    '            acc.Name.trim();',
    '        }',
    '    }',
    '    if (Trigger.new.isEmpty()) {',
    '        return;',
    '    }',
    '    if (Trigger.isBefore) {',
    '        System.debug(1);',
    '    } else {',
    '        System.debug(2);',
    '    }',
    '}'
  ];
  const run = (event, lines, at) => [
    `10:00:00.0 (${at})|CODE_UNIT_STARTED|[EXTERNAL]|01q000000000001AAA|DemoTrigger on Account trigger event ${event}|__sfdc_trigger/DemoTrigger`,
    ...lines.map((n, i) => `10:00:00.0 (${at + i + 1})|STATEMENT_EXECUTE|[${n}]`),
    `10:00:00.0 (${at + 50})|CODE_UNIT_FINISHED|DemoTrigger on Account trigger event ${event}|__sfdc_trigger/DemoTrigger`
  ];
  const text = ['64.0 APEX_CODE,FINEST', ...run('BeforeUpdate', [1, 2, 3, 4, 7, 10, 11], 100).flatMap((l) => (l.endsWith('[11]') ? [l, '10:00:00.0 (140)|USER_DEBUG|[11]|DEBUG|value <1>'] : [l])), ...run('AfterUpdate', [1, 2, 3, 4, 7, 10, 12, 13], 1000)].join('\n');
  const a = analyzeLog(text);
  const html = buildHtml(a, new Map([[fileKey('trigger', 'DemoTrigger'), trigger]]), { nonce: 'n', title: 't', coverage: true });
  const sections = html.split('<h2 ').slice(1);
  assert.equal(sections.length, 2, 'one section per run');
  assert.match(sections[0], /before update/);
  assert.match(sections[1], /after update/);
  const green = (section) => [...section.matchAll(/class="row ran"[^>]*data-line="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(green(sections[0]), [1, 2, 3, 4, 5, 6, 7, 10, 11, 15], 'before: the if branch; braces of blocks that ran');
  assert.deepEqual(green(sections[1]), [1, 2, 3, 4, 5, 6, 7, 10, 12, 13, 14, 15], 'after: the else branch');
  // Hovering a debug line shows its output (escaped), only in the run that wrote it.
  assert.match(sections[0], /class="row ran" data-dbg="1-11"/);
  assert.match(sections[0], /<pre class="exsrc" id="dbg-1-11" hidden data-title="System\.debug · line 11">10:00:00\.000  DEBUG  value &lt;1&gt;<\/pre>/);
  assert.doesNotMatch(sections[1].split('</section>')[0], /data-dbg/);
});
