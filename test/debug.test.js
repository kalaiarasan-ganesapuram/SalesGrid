// The Sales Grid debug level and trace flag handling, against a fake API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Debugger, salesGridLevels } = require('../debug');

const ME = '005000000000001AAA';
const OTHER = '005000000000002AAA';

function fakeApi({ level, flags = [] }) {
  const calls = [];
  return {
    calls,
    async query(username, soql) {
      calls.push(['query', soql]);
      if (/FROM User WHERE Username/.test(soql)) return [{ Id: ME }];
      if (/FROM DebugLevel/.test(soql)) return level ? [level] : [];
      if (/FROM TraceFlag WHERE TracedEntityId = '(\w+)' AND DebugLevel/.test(soql)) {
        const id = /TracedEntityId = '(\w+)'/.exec(soql)[1];
        return flags.filter((f) => f.entity === id && f.DebugLevel.DeveloperName === 'Sales_Grid');
      }
      if (/FROM TraceFlag WHERE TracedEntityId/.test(soql)) {
        const id = /TracedEntityId = '(\w+)'/.exec(soql)[1];
        return flags.filter((f) => f.entity === id);
      }
      return [];
    },
    async request(username, method, path, body) {
      calls.push([method, path, body]);
      return method === 'POST' ? { id: path.includes('DebugLevel') ? '7dl000000000001AAA' : '7tf000000000009AAA' } : null;
    }
  };
}

const future = new Date(Date.now() + 3600e3).toISOString();

test('creates the Sales Grid level (FINER) and a trace flag when neither exists', async () => {
  const api = fakeApi({});
  const result = await new Debugger(api).enableSalesGridDebugging('me@x.com', { minutes: 60, detail: 'FINER' });
  const posts = api.calls.filter((c) => c[0] === 'POST');
  assert.equal(posts[0][1], 'sobjects/DebugLevel');
  assert.equal(posts[0][2].DeveloperName, 'Sales_Grid');
  assert.equal(posts[0][2].MasterLabel, 'Sales Grid');
  assert.equal(posts[0][2].ApexCode, 'FINER');
  assert.equal(posts[0][2].Database, 'INFO');
  assert.equal(posts[1][1], 'sobjects/TraceFlag');
  assert.equal(posts[1][2].LogType, 'DEVELOPER_LOG');
  assert.equal(posts[1][2].TracedEntityId, ME);
  assert.equal(result.level.created, true);
});

test('reuses an identical level without asking, and reuses a clashing flag instead of adding one', async () => {
  const level = { Id: '7dl000000000001AAA', DeveloperName: 'Sales_Grid', ...salesGridLevels('FINER') };
  const flags = [{ Id: '7tf000000000001AAA', entity: ME, LogType: 'DEVELOPER_LOG', ExpirationDate: future, DebugLevel: { DeveloperName: 'SFDC_DevConsole' } }];
  const api = fakeApi({ level, flags });
  let asked = false;
  const result = await new Debugger(api).enableSalesGridDebugging('me@x.com', { minutes: 30, detail: 'FINER', confirmChange: async () => ((asked = true), 'update') });
  assert.equal(asked, false);
  assert.equal(api.calls.filter((c) => c[0] === 'POST').length, 0, 'nothing new is created');
  const patch = api.calls.find((c) => c[0] === 'PATCH');
  assert.equal(patch[1], 'sobjects/TraceFlag/7tf000000000001AAA');
  assert.equal(patch[2].DebugLevelId, level.Id);
  assert.match(result.notes.join(' '), /SFDC_DevConsole now uses Sales Grid/);
});

test('asks before changing a Sales Grid level with other settings; "keep" leaves it alone, cancel stops', async () => {
  const level = { Id: '7dl000000000001AAA', DeveloperName: 'Sales_Grid', ...salesGridLevels('FINER'), ApexCode: 'DEBUG' };
  let seen;
  const keepApi = fakeApi({ level });
  await new Debugger(keepApi).enableSalesGridDebugging('me@x.com', { detail: 'FINEST', confirmChange: async (d) => ((seen = d), 'keep') });
  assert.deepEqual(seen.differences, ['ApexCode']);
  assert.equal(seen.wanted.ApexCode, 'FINEST');
  assert.ok(!keepApi.calls.some((c) => c[0] === 'PATCH' && c[1].includes('DebugLevel')), 'level not modified');

  const updateApi = fakeApi({ level });
  await new Debugger(updateApi).enableSalesGridDebugging('me@x.com', { detail: 'FINEST', confirmChange: async () => 'update' });
  assert.equal(updateApi.calls.find((c) => c[0] === 'PATCH' && c[1].includes('DebugLevel'))[2].ApexCode, 'FINEST');

  const cancelApi = fakeApi({ level });
  await assert.rejects(new Debugger(cancelApi).enableSalesGridDebugging('me@x.com', { detail: 'FINEST', confirmChange: async () => 'cancel' }), (e) => e.cancelled === true);
  assert.ok(!cancelApi.calls.some((c) => c[1] && String(c[1]).includes('TraceFlag') && c[0] !== 'query'));
});

test('another user gets a USER_DEBUG flag, capped at 24 hours', async () => {
  const api = fakeApi({});
  const before = Date.now();
  await new Debugger(api).enableSalesGridDebugging('me@x.com', { targetUserId: OTHER, minutes: 99999, detail: 'FINER' });
  const flag = api.calls.find((c) => c[0] === 'POST' && c[1] === 'sobjects/TraceFlag')[2];
  assert.equal(flag.LogType, 'USER_DEBUG');
  assert.equal(flag.TracedEntityId, OTHER);
  assert.ok(new Date(flag.ExpirationDate).getTime() - before <= 24 * 3600e3 + 5000);
});

test('disable removes only active Sales Grid flags', async () => {
  const flags = [
    { Id: '7tf000000000001AAA', entity: ME, ExpirationDate: future, DebugLevel: { DeveloperName: 'Sales_Grid' } },
    { Id: '7tf000000000002AAA', entity: ME, ExpirationDate: new Date(Date.now() - 1000).toISOString(), DebugLevel: { DeveloperName: 'Sales_Grid' } },
    { Id: '7tf000000000003AAA', entity: ME, ExpirationDate: future, DebugLevel: { DeveloperName: 'SFDC_DevConsole' } }
  ];
  const api = fakeApi({ flags });
  const stopped = await new Debugger(api).disableSalesGridDebugging('me@x.com');
  assert.equal(stopped, 1);
  assert.deepEqual(api.calls.filter((c) => c[0] === 'DELETE').map((c) => c[1]), ['sobjects/TraceFlag/7tf000000000001AAA']);
});

test('start logging with a chosen debug level uses it as it is; without one, SalesGrid_Standard', async () => {
  const api = fakeApi({});
  await new Debugger(api).startLogging('me@x.com', 60, 'Standard', undefined, '7dl2w000000lDtkAAE');
  const flag = api.calls.find((c) => c[0] === 'POST' && c[1] === 'sobjects/TraceFlag')[2];
  assert.equal(flag.DebugLevelId, '7dl2w000000lDtkAAE');
  assert.equal(flag.LogType, 'DEVELOPER_LOG');
  assert.ok(!api.calls.some((c) => c[1] && String(c[1]).includes('DebugLevel')), 'the chosen level is not created or changed');

  const api2 = fakeApi({});
  await new Debugger(api2).startLogging('me@x.com', 60, 'Standard');
  assert.ok(api2.calls.some((c) => c[0] === 'POST' && c[1] === 'sobjects/DebugLevel' && c[2].DeveloperName === 'SalesGrid_Standard'));

  await assert.rejects(new Debugger(fakeApi({})).startLogging('me@x.com', 60, 'Standard', undefined, "x' OR Id != '"), /Unsupported record id/);
});
