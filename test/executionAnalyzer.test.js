// Run with: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { analyzeLog, findings, lineStates, verifySource, fileKey } = require('../executionAnalyzer');
const { parseLog } = require('../logParser');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const source = (relative) => fs.readFileSync(path.join(__dirname, 'fixtures', 'force-app', 'main', 'default', relative), 'utf8').split(/\r?\n/);
const executed = (analysis, key) => [...lineStates(analysis, key).keys()].sort((a, b) => a - b);

test('one class: call, exception in the callee, catch in the caller, execution continues', () => {
  const a = analyzeLog(fixture('same-class.log'));
  const key = fileKey('class', 'OrderService');
  // Lines 7 (after the throwing call) and 18 (after the throw) must stay unrecorded.
  assert.deepEqual(executed(a, key), [3, 4, 6, 9, 10, 12, 15, 16, 17, 21]);
  const states = lineStates(a, key);
  assert.equal(states.get(17).state, 'exception');
  assert.equal(states.get(6).state, 'executed');
  assert.ok(states.get(6).data.calls.has('OrderService.validate(Integer)'));
  assert.ok(states.get(10).data.calls.has('OrderService.logError(Exception)'));

  assert.equal(a.exceptions.length, 1);
  const ex = a.exceptions[0];
  assert.equal(ex.type, 'System.NullPointerException');
  assert.equal(ex.line, 17);
  assert.equal(ex.frame, 'OrderService.validate(Integer)');
  assert.equal(ex.status, 'continued');
  assert.equal(ex.resumedAt.line, 9, 'execution resumed in the catch block');
  assert.equal(ex.resumedAt.frame, 'OrderService.process()');
  assert.deepEqual(ex.stack.map((s) => s.line), [17, 6, 1]);
  assert.deepEqual(states.get(9).data.resumes, [0]);

  // The recorded order across the three methods of the same class.
  const order = a.steps.filter((s) => s.file === key && s.kind === 'statement').map((s) => s.line);
  assert.deepEqual(order, [3, 4, 6, 15, 16, 17, 9, 10, 21, 12]);
  assert.equal(a.truncated, false);
  assert.equal(a.incomplete, false);
  assert.equal(a.user.username, 'dev@example.com');
});

test('trigger, handler, service, validation: exception caught two levels up, recursion, SOQL in a loop', () => {
  const a = analyzeLog(fixture('trigger-chain.log'));
  const trigger = fileKey('trigger', 'AccountTrigger');
  const handler = fileKey('class', 'AccountTriggerHandler');
  const service = fileKey('class', 'AccountService');
  const validation = fileKey('class', 'AccountValidation');
  assert.deepEqual([...a.files.keys()].sort(), [handler, service, validation, trigger].sort());

  assert.deepEqual(executed(a, trigger), [2, 3]);
  assert.deepEqual(executed(a, handler), [2, 4, 6, 8, 9, 11, 12, 14, 17, 18]);
  assert.deepEqual(executed(a, service), [3, 4, 5]);
  assert.deepEqual(executed(a, validation), [4, 5]);

  const handlerLines = lineStates(a, handler);
  assert.equal(handlerLines.get(14).count, 2, 'handler done ran in both trigger runs');
  assert.equal(handlerLines.get(18).count, 2, 'loop body ran twice');
  assert.equal(lineStates(a, service).get(4).state, 'hot', 'query inside a loop is flagged');
  assert.equal(lineStates(a, validation).get(5).state, 'exception');

  const ex = a.exceptions[0];
  assert.equal(ex.type, 'AccountValidation.ValidationException');
  assert.equal(ex.fileName, 'AccountValidation', 'inner class exception belongs to the outer file');
  assert.equal(ex.status, 'continued');
  assert.equal(ex.resumedAt.fileName, 'AccountTriggerHandler');
  assert.equal(ex.resumedAt.line, 8);
  assert.deepEqual(ex.stack.map((s) => `${s.fileName}:${s.line}`), ['AccountValidation:5', 'AccountService:5', 'AccountTriggerHandler:6', 'AccountTrigger:3']);

  assert.equal(a.triggers.get(trigger).runs, 2);
  assert.equal(a.triggers.get(trigger).recursive, true);
  const found = findings(a, { limits: parseLog(fixture('trigger-chain.log')).limits });
  const kinds = found.map((f) => f.kind);
  assert.ok(kinds.includes('triggerRecursion'));
  assert.ok(kinds.includes('soqlLoop'));
  assert.ok(kinds.includes('repeatedQuery'));
  assert.ok(kinds.includes('limit'), 'CPU at 91% is reported');
  assert.equal(found.find((f) => f.kind === 'soqlLoop').confirmed, false, 'loop is an inference');
  assert.equal(found.find((f) => f.kind === 'triggerRecursion').confirmed, true);

  // FINEST: variable values are attached.
  assert.equal(handlerLines.get(4).data.vars[0].name, 'this.depth');
  // Replay crosses files in order: trigger -> handler static init -> trigger ->
  // handler -> service -> validation (twice, in the loop) -> handler catch.
  const files = [];
  for (const step of a.steps) {
    if (step.file && files[files.length - 1] !== step.file) files.push(step.file);
  }
  assert.deepEqual(files.slice(0, 9), [trigger, handler, trigger, handler, service, validation, service, validation, handler]);
});

test('the open file is checked against the log', () => {
  const a = analyzeLog(fixture('trigger-chain.log'));
  const lines = source('classes/AccountTriggerHandler.cls');
  const ok = verifySource(a, fileKey('class', 'AccountTriggerHandler'), (n) => lines[n - 1] || '', lines.length);
  assert.ok(ok.checked >= 2);
  assert.equal(ok.mismatched, 0);
  // Two blank lines added at the top shift every line: the calls no longer line up.
  const shifted = ['', '', ...lines];
  const bad = verifySource(a, fileKey('class', 'AccountTriggerHandler'), (n) => shifted[n - 1] || '', shifted.length);
  assert.ok(bad.mismatched > 0);
});

test('unhandled exception and a truncated log', () => {
  const a = analyzeLog(fixture('unhandled-truncated.log'));
  assert.equal(a.truncated, true);
  assert.equal(a.exceptions.length, 1);
  assert.equal(a.exceptions[0].status, 'unhandled');
  assert.equal(a.exceptions[0].line, 17);
  assert.ok(a.notes.some((n) => /cut short/.test(n)));
});

test('only a fatal error logged (Apex Code at ERROR) still finds its place, and nothing else is claimed', () => {
  const log = [
    '62.0 APEX_CODE,ERROR;DB,INFO',
    '10:00:00.0 (100)|EXECUTION_STARTED',
    '10:00:00.0 (200)|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex',
    '10:00:00.0 (300)|FATAL_ERROR|System.NullPointerException: Attempt to de-reference a null object',
    '',
    'Class.OrderService.validate: line 17, column 1',
    'Class.OrderService.process: line 6, column 1',
    'AnonymousBlock: line 1, column 1',
    '10:00:00.0 (400)|CODE_UNIT_FINISHED|execute_anonymous_apex',
    '10:00:00.0 (500)|EXECUTION_FINISHED'
  ].join('\n');
  const a = analyzeLog(log);
  assert.equal(a.statementLevel, false);
  const states = lineStates(a, fileKey('class', 'OrderService'));
  assert.deepEqual([...states.keys()].sort((x, y) => x - y), [6, 17]);
  assert.equal(states.get(17).state, 'exception');
  assert.ok(a.notes.some((n) => /below FINER/.test(n)));
});

test('a large log is analysed quickly', () => {
  const lines = ['62.0 APEX_CODE,FINER', '10:00:00.0 (1)|EXECUTION_STARTED', '10:00:00.0 (2)|CODE_UNIT_STARTED|[EXTERNAL]|01p000000000001AAA|BigLoop.run()'];
  for (let i = 0; i < 200000; i++) {
    lines.push(`10:00:00.0 (${i + 3})|STATEMENT_EXECUTE|[${(i % 40) + 2}]`);
  }
  lines.push('10:00:00.0 (999999)|CODE_UNIT_FINISHED|BigLoop.run()', '10:00:00.0 (1000000)|EXECUTION_FINISHED');
  const started = Date.now();
  const a = analyzeLog(lines.join('\n'));
  const took = Date.now() - started;
  assert.equal(lineStates(a, fileKey('class', 'BigLoop')).get(2).count, 5000);
  assert.ok(took < 3000, `took ${took} ms`);
});

test('a scheduled job named after its class is matched to that class', () => {
  const a = analyzeLog(fixture('scheduled-job.log'), { knownClasses: ['OrderService', 'Order'] });
  assert.deepEqual(executed(a, fileKey('class', 'OrderService')), [3, 4]);
  assert.ok(!a.files.has(fileKey('class', 'OrderService_00')));
  assert.ok(a.notes.some((n) => /OrderService_00.*OrderService/.test(n)));
});

test('no METHOD_ENTRY (Apex Code below FINE): queries and DML are placed on the class whose source line matches', () => {
  const lines = (text) => text.split('\n');
  const src = new Map([
    ['class:ticketjob', { name: 'TicketJob', lines: lines('public class TicketJob implements Schedulable {\n  public void execute(SchedulableContext sc) {\n    InvoiceService.run();\n    System.debug(\'starting\');\n    if (Test.isRunningTest()) {\n    }\n    Integer x = 1;\n  }\n  void noop() {}\n}') }],
    ['class:invoiceservice', { name: 'InvoiceService', lines: lines('public class InvoiceService {\n  public static void run() {\n    // Accepted members\n    Integer n = 0;\n    List<TripMember__c> members = [\n        SELECT Id, Name, (SELECT Id FROM Invoices__r WHERE Status__c != :X)\n        FROM TripMember__c WHERE Status__c = :Y];\n    for (TripMember__c m : members) { m.Name = \'x\'; }\n    update members;\n  }\n}') }],
    ['class:other', { name: 'Other', lines: lines('public class Other {\n\n\n\n  List<Contact> c = [SELECT Id FROM Contact];\n}') }]
  ]);
  const a = analyzeLog(fixture('no-method-entries.log'), { knownClasses: ['TicketJob', 'InvoiceService', 'Other'], source: src });
  const job = lineStates(a, fileKey('class', 'TicketJob'));
  const service = lineStates(a, fileKey('class', 'InvoiceService'));
  assert.equal(service.get(5).data.soql[0].rows, 2, 'query sits on InvoiceService line 5');
  assert.ok(!job.has(5), 'not on TicketJob line 5 (an if statement)');
  assert.equal(job.get(4).data.debug[0].text, 'starting', 'debug line that fits stays put');
  assert.equal(service.get(9).data.dml[0].op, 'Update');
  assert.ok(!job.has(7), 'no class has a query on line 7, so it is not pinned anywhere');
  assert.equal(a.queries.get('SELECT Id FROM Account').count, 1, 'still counted');
  assert.ok(a.notes.some((n) => /placed by matching the source/.test(n)));
  assert.ok(a.notes.some((n) => /could not be tied/.test(n)));
});

test('without source, the old placement is kept', () => {
  const a = analyzeLog(fixture('no-method-entries.log'), { knownClasses: ['TicketJob'] });
  assert.ok(lineStates(a, fileKey('class', 'TicketJob')).has(5));
});

test('Apex Code at DEBUG: plain lines between recorded ones and the call into another method are inferred', () => {
  const { inferredLines } = require('../executionAnalyzer');
  const lines = source('classes/SalesGridDemo.cls');
  const key = fileKey('class', 'SalesGridDemo');
  const a = analyzeLog(fixture('demo-debug-level.log'), { knownClasses: ['SalesGridDemo'], source: new Map([[key, { name: 'SalesGridDemo', lines }]]) });
  assert.deepEqual(executed(a, key), [12, 13, 14, 20, 24, 26, 28, 33, 35, 39, 40]);
  const inferred = inferredLines(a, key, (n) => lines[n - 1] || '', lines.length);
  assert.deepEqual([...inferred.keys()].sort((x, y) => x - y), [16, 17, 18, 22, 23, 25, 27, 31]);
  assert.equal(inferred.get(31).calls, 'validate', 'validate(null) is the call site of the method that threw');
  // Salesforce logs the exception at 40 (the throw) and again at 39 (the if it leaves).
  const states = lineStates(a, key);
  assert.equal(states.get(40).state, 'exception');
  assert.equal(states.get(39).state, 'executed', 'the enclosing if ran; it did not throw');
  assert.equal(a.exceptions.length, 1, 'one exception, not two');
  assert.equal(a.exceptions[0].line, 40);
  assert.equal(a.exceptions[0].status, 'continued');
  assert.equal(a.exceptions[0].resumedAt.line, 33, 'resumed in the catch block');
  assert.ok(!inferred.has(30) && !inferred.has(32), 'try and catch lines are not claimed');
  // Salesforce's own queries during the insert are not pinned on this class.
  assert.ok(!executed(a, key).some((n) => n > lines.length));
  assert.ok(lineStates(a, key).get(24).data.dml[0].time, 'DML keeps its log timestamp');
  assert.ok(lineStates(a, key).get(20).data.debug[0].time, 'debug output keeps its log timestamp');
});

test('a log at FINER infers nothing: every statement is already recorded', () => {
  const { inferredLines } = require('../executionAnalyzer');
  const a = analyzeLog(fixture('same-class.log'));
  const lines = source('classes/OrderService.cls');
  assert.equal(inferredLines(a, fileKey('class', 'OrderService'), (n) => lines[n - 1] || '', lines.length).size, 0);
});

test('Apex Code at DEBUG, trigger and handler: handler lines leave the trigger, the calls between them are inferred', () => {
  const { inferredLines } = require('../executionAnalyzer');
  const trigger = source('triggers/SalesGridDemoTrigger.trigger');
  const handler = source('classes/SalesGridDemoTriggerHandler.cls');
  const tKey = fileKey('trigger', 'SalesGridDemoTrigger');
  const hKey = fileKey('class', 'SalesGridDemoTriggerHandler');
  // Another class with a debug line on line 20 must not steal the handler's.
  const decoy = Array.from({ length: 30 }, (_, i) => (i === 19 ? "        System.debug('decoy');" : '    Integer x = 1;'));
  const src = new Map([
    [tKey, { name: 'SalesGridDemoTrigger', lines: trigger }],
    [hKey, { name: 'SalesGridDemoTriggerHandler', lines: handler }],
    [fileKey('class', 'Decoy'), { name: 'Decoy', lines: decoy }]
  ]);
  const a = analyzeLog(fixture('trigger-handler-debug-level.log'), { knownClasses: ['SalesGridDemoTriggerHandler', 'Decoy'], source: src });
  assert.deepEqual(executed(a, tKey), [15], 'only the trigger\'s own debug line');
  assert.deepEqual(executed(a, hKey), [13, 19, 20, 27, 33, 34]);
  assert.equal(lineStates(a, hKey).get(34).state, 'exception');
  assert.equal(lineStates(a, hKey).get(33).state, 'executed');
  assert.equal(a.exceptions.length, 1);
  assert.equal(a.exceptions[0].fileName, 'SalesGridDemoTriggerHandler');
  assert.equal(a.exceptions[0].resumedAt.line, 27);
  const tInferred = inferredLines(a, tKey, (n) => trigger[n - 1] || '', trigger.length);
  assert.equal(tInferred.get(17).calls, 'beforeSave');
  assert.equal(tInferred.get(19).calls, 'afterSave');
  const hInferred = inferredLines(a, hKey, (n) => handler[n - 1] || '', handler.length);
  assert.equal(hInferred.get(24).calls, 'checkName');
});

test('closing braces: green only when control reached the end of their block', () => {
  const { closingBraceLines } = require('../executionAnalyzer');
  const src = [
    'public class Demo {', //               1
    '    public static void run(Integer x) {', // 2
    '        if (x > 1) {', //               3
    '            go();', //                  4
    '        }', //                          5  if body skipped: plain
    '        for (Integer i = 0; i < x; i++) {', // 6
    '            go();', //                  7
    '        }', //                          8  loop body ran
    '        if (x == 0) {', //              9
    '            return;', //                10
    '        }', //                          11 return: never falls through
    '        try {', //                      12
    '            risky();', //               13 threw
    '        } catch (Exception e) {', //    14
    '            log(e);', //                15
    '        }', //                          16
    '        done(', //                      17 one statement on two lines
    "            'x');", //                   18
    '    }', //                              19 method end reached
    '    public static void other() {', //  20
    '        fail();', //                    21 left by an uncaught exception
    '    }', //                              22
    '}' //                                   23 the class's own brace
  ];
  const ran = new Set([3, 6, 7, 9, 10, 13, 15, 17, 21]);
  const failed = new Set([13, 21]);
  assert.deepEqual([...closingBraceLines(src, ran, failed)].sort((a, b) => a - b), [8, 16, 19]);
});

test('closing braces: an if/else chain is done when either branch finished', () => {
  const { closingBraceLines } = require('../executionAnalyzer');
  const src = ['trigger T on Account (before update) {', '    if (Trigger.isBefore) {', '        a();', '    } else {', '        b();', '    }', '}'];
  // The if branch ran: its block ends at line 4, the else block (6) did not run, the trigger end (7) was reached.
  assert.deepEqual([...closingBraceLines(src, new Set([1, 2, 3]), new Set())], [7]);
  assert.deepEqual([...closingBraceLines(src, new Set([1, 2, 5]), new Set())].sort(), [6, 7]);
});

test('aborted lines: call lines up to the frame that caught an exception', () => {
  const { abortedLines } = require('../executionAnalyzer');
  const analysis = {
    exceptions: [
      { status: 'continued', resumedAt: { frame: 'A.run()' }, stack: [{ frame: 'B.check()', file: 'class:b', line: 5 }, { frame: 'B.enrich()', file: 'class:b', line: 9 }, { frame: 'A.run()', file: 'class:a', line: 3 }, { frame: 'T trigger', file: 'trigger:t', line: 2 }] },
      { status: 'unhandled', stack: [{ frame: 'C.go()', file: 'class:c', line: 7 }, { frame: 'A.run()', file: 'class:a', line: 12 }] }
    ]
  };
  assert.deepEqual([...abortedLines(analysis, 'class:b')].sort(), [5, 9]);
  assert.deepEqual([...abortedLines(analysis, 'class:a')].sort((x, y) => x - y), [3, 12], 'the call on line 3 jumped to its catch; line 12 never finished');
  assert.deepEqual([...abortedLines(analysis, 'trigger:t')], [], 'the trigger above the catch carried on');
});

test('closing braces: a method whose if body threw never reaches its end', () => {
  const { closingBraceLines } = require('../executionAnalyzer');
  const src = ['    private static void checkName(Account acc) {', "        if (acc.Name.containsIgnoreCase('error')) {", '            throw new DemoValidationException(acc.Name);', '        }', '    }'];
  assert.deepEqual([...closingBraceLines(src, new Set([2, 3]), new Set([3]))], []);
  // The condition was false: the if is skipped and the method ends.
  assert.deepEqual([...closingBraceLines(src, new Set([2]), new Set())], [5]);
});
