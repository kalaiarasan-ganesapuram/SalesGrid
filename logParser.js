// Turns a raw Apex debug log into a short summary: errors, debug output,
// queries, DML, slowest methods and governor-limit usage. Runs in the
// extension host so only the summary, not the whole log, reaches the page.

const LINE = /^(\d{2}:\d{2}:\d{2}\.\d+) \((\d+)\)\|([A-Z_]+)(?:\|(.*))?$/;
const MAX_ITEMS = 300;

function lineNumber(field) {
  const match = /^\[(\d+)\]$/.exec(field || '');
  return match ? Number(match[1]) : undefined;
}

function limitValue(text, label) {
  const match = new RegExp(`${label}: (\\d+) out of (\\d+)`).exec(text);
  return match ? { used: Number(match[1]), max: Number(match[2]) } : undefined;
}

function parseLog(text) {
  const lines = text.split(/\r?\n/);
  const summary = {
    lines: lines.length,
    bytes: Buffer.byteLength(text),
    durationMs: 0,
    errors: [],
    debug: [],
    queries: [],
    dml: [],
    slowest: [],
    limits: {},
    counts: { soql: 0, dml: 0, debug: 0, errors: 0, exceptions: 0 }
  };

  let first;
  let entry = -1; // position of the current event in the timeline
  let last;
  let current; // the event whose message continues on the next lines
  const openMethods = [];
  const methodTotals = new Map();
  const openQueries = [];
  let limitBlock;
  let lastLimitBlock;

  for (const raw of lines) {
    const match = LINE.exec(raw);
    if (!match) {
      // A message that spans several lines (debug output, stack traces, limits).
      if (limitBlock !== undefined) {
        limitBlock += `\n${raw}`;
      } else if (current && raw) {
        current.text += `\n${raw}`;
      }
      continue;
    }
    if (limitBlock !== undefined) {
      lastLimitBlock = limitBlock;
      limitBlock = undefined;
    }
    current = undefined;
    entry++;

    const [, time, nanosText, event, rest = ''] = match;
    const nanos = Number(nanosText);
    if (first === undefined) {
      first = nanos;
    }
    last = nanos;
    const fields = rest.split('|');
    const at = { time, ms: Math.round((nanos - first) / 1e6), ti: entry };

    switch (event) {
      case 'USER_DEBUG': {
        summary.counts.debug++;
        if (summary.debug.length < MAX_ITEMS) {
          current = { ...at, line: lineNumber(fields[0]), level: fields[1], text: fields.slice(2).join('|') };
          summary.debug.push(current);
        }
        break;
      }
      case 'EXCEPTION_THROWN':
      case 'FATAL_ERROR': {
        if (event === 'FATAL_ERROR') {
          summary.counts.errors++;
        } else {
          summary.counts.exceptions++;
        }
        if (summary.errors.length < MAX_ITEMS) {
          const hasLine = lineNumber(fields[0]) !== undefined;
          current = { ...at, kind: event === 'FATAL_ERROR' ? 'Fatal error' : 'Exception', line: lineNumber(fields[0]), text: fields.slice(hasLine ? 1 : 0).join('|') };
          summary.errors.push(current);
        }
        break;
      }
      case 'SOQL_EXECUTE_BEGIN': {
        summary.counts.soql++;
        const query = { ...at, line: lineNumber(fields[0]), text: fields.slice(2).join('|'), rows: undefined, durationMs: undefined, start: nanos };
        openQueries.push(query);
        if (summary.queries.length < MAX_ITEMS) {
          summary.queries.push(query);
        }
        break;
      }
      case 'SOQL_EXECUTE_END': {
        const query = openQueries.pop();
        if (query) {
          const rows = /Rows:(\d+)/.exec(rest);
          query.rows = rows ? Number(rows[1]) : undefined;
          query.durationMs = Math.round((nanos - query.start) / 1e6);
        }
        break;
      }
      case 'DML_BEGIN': {
        summary.counts.dml++;
        if (summary.dml.length < MAX_ITEMS) {
          const op = /Op:(\w+)/.exec(rest);
          const type = /Type:([\w.]+)/.exec(rest);
          const rows = /Rows:(\d+)/.exec(rest);
          summary.dml.push({ ...at, line: lineNumber(fields[0]), operation: op ? op[1] : '', object: type ? type[1] : '', rows: rows ? Number(rows[1]) : undefined });
        }
        break;
      }
      case 'METHOD_ENTRY':
      case 'CODE_UNIT_STARTED': {
        const name = fields[fields.length - 1] || fields[0];
        openMethods.push({ name, start: nanos, unit: event === 'CODE_UNIT_STARTED' });
        break;
      }
      case 'METHOD_EXIT':
      case 'CODE_UNIT_FINISHED': {
        // Match the most recent open entry of the same kind.
        const unit = event === 'CODE_UNIT_FINISHED';
        for (let i = openMethods.length - 1; i >= 0; i--) {
          if (openMethods[i].unit === unit) {
            const [entry] = openMethods.splice(i, 1);
            const total = methodTotals.get(entry.name) || { name: entry.name, ms: 0, calls: 0, unit };
            total.ms += (nanos - entry.start) / 1e6;
            total.calls++;
            methodTotals.set(entry.name, total);
            break;
          }
        }
        break;
      }
      case 'LIMIT_USAGE_FOR_NS': {
        // Only the org's own code: managed packages report their own blocks.
        limitBlock = /\(default\)/.test(rest) ? rest : undefined;
        break;
      }
      default:
        break;
    }
  }
  if (limitBlock !== undefined) {
    lastLimitBlock = limitBlock;
  }

  summary.durationMs = first === undefined ? 0 : Math.round((last - first) / 1e6);
  summary.slowest = [...methodTotals.values()]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 15)
    .map((item) => ({ ...item, ms: Math.round(item.ms * 10) / 10 }));
  for (const query of summary.queries) {
    delete query.start;
  }
  if (lastLimitBlock) {
    summary.limits = {
      soql: limitValue(lastLimitBlock, 'Number of SOQL queries'),
      queryRows: limitValue(lastLimitBlock, 'Number of query rows'),
      dml: limitValue(lastLimitBlock, 'Number of DML statements'),
      dmlRows: limitValue(lastLimitBlock, 'Number of DML rows'),
      cpu: limitValue(lastLimitBlock, 'Maximum CPU time'),
      heap: limitValue(lastLimitBlock, 'Maximum heap size'),
      callouts: limitValue(lastLimitBlock, 'Number of callouts')
    };
  }
  return summary;
}

// Colour groups for the timeline view.
const CATEGORIES = [
  ['error', /^(EXCEPTION_THROWN|FATAL_ERROR)$/],
  ['debug', /^USER_DEBUG$/],
  ['soql', /^(SOQL|SOSL)_/],
  ['dml', /^DML_/],
  ['callout', /^(CALLOUT|NAMED_CREDENTIAL)_/],
  ['limits', /^(LIMIT_USAGE|CUMULATIVE_LIMIT|CUMULATIVE_PROFILING|TESTING_LIMITS)/],
  ['flow', /^(FLOW_|WF_)/],
  ['validation', /^(VALIDATION_|DUPLICATE_)/],
  ['unit', /^CODE_UNIT_/],
  ['method', /^(METHOD_|CONSTRUCTOR_|SYSTEM_METHOD_|SYSTEM_CONSTRUCTOR_)/],
  ['variable', /^(VARIABLE_|STATEMENT_EXECUTE|HEAP_ALLOCATE)/]
];

function categoryOf(event) {
  for (const [name, pattern] of CATEGORIES) {
    if (pattern.test(event)) {
      return name;
    }
  }
  return 'system';
}

// Every event in the log, one entry each, with lines that continue a message
// folded into it. Positions match the `ti` values in parseLog's summary.
function buildTimeline(text) {
  const entries = [];
  let first;
  for (const raw of text.split(/\r?\n/)) {
    const match = LINE.exec(raw);
    if (!match) {
      const last = entries[entries.length - 1];
      if (last && raw) {
        last.text += `\n${raw}`;
      }
      continue;
    }
    const [, , nanosText, event, rest = ''] = match;
    const nanos = Number(nanosText);
    if (first === undefined) {
      first = nanos;
    }
    const fields = rest.split('|');
    const line = lineNumber(fields[0]);
    entries.push({
      ms: Math.round((nanos - first) / 1e5) / 10,
      event,
      cat: categoryOf(event),
      line,
      text: (line === undefined ? fields : fields.slice(1)).join(' | ')
    });
  }
  return entries;
}

module.exports = { parseLog, buildTimeline, categoryOf };
