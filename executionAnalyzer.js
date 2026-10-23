// Rebuilds the path an Apex transaction took from its debug log: which lines
// of which classes and triggers ran, in what order, where exceptions were
// thrown and where execution carried on afterwards. Plain JavaScript with no
// VS Code dependency, so it can be tested on its own.
//
// What the log can and cannot prove:
// - STATEMENT_EXECUTE (Apex Code at FINER or FINEST) names every statement
//   that ran. Without it only lines that produced another event (a call, a
//   query, a debug line, an exception) are known to have run.
// - A line that is absent from the log is "not recorded", never "not run":
//   the log may be truncated, filtered by level, or the line may not be a
//   statement at all.
// - Where execution resumed after an exception is observed; that the resume
//   point is a catch block is an inference, and is labelled as one.

const LINE = /^(\d{2}:\d{2}:\d{2}\.\d+) \((\d+)\)\|([A-Z_]+)(?:\|(.*))?$/;
const RECORD_ID = /^[a-zA-Z0-9]{15,18}$/;
const LEVELS = ['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST'];

// Bounds that keep memory flat on 20 MB logs.
const MAX_STEPS = 400000;
const MAX_LINE_STEPS = 300;
const MAX_LINE_NOTES = 15;
const MAX_TEXT = 2000;

function fileKey(kind, name) {
  return `${kind}:${String(name).toLowerCase()}`;
}

function lineOf(field) {
  const match = /^\[(\d+)\]$/.exec(field || '');
  return match ? Number(match[1]) : undefined;
}

function clip(text, max = MAX_TEXT) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)} …` : value;
}

// "ns.Outer.Inner.method(Integer, List<Id>)" -> class path and method name.
function splitSignature(signature) {
  const bare = String(signature || '').split('(')[0].trim();
  const parts = bare.split('.').filter(Boolean);
  return { path: parts.slice(0, -1), method: parts[parts.length - 1] || bare };
}

// Picks the top-level class that owns a class path. Inner classes live in
// their outer class's file; a managed-package namespace comes first. When the
// workspace's class names are known they settle which segment is the class.
function ownerClass(path, known) {
  if (!path.length) {
    return undefined;
  }
  if (known) {
    for (const segment of path.slice(0, 2)) {
      if (known.has(segment.toLowerCase())) {
        return segment;
      }
    }
  }
  return path[0];
}

function parseHeader(first) {
  const header = { apiVersion: undefined, levels: {} };
  const match = /^(\d+\.\d+)\s+(.*)$/.exec(first || '');
  if (match) {
    header.apiVersion = match[1];
    for (const pair of match[2].split(';')) {
      const [category, level] = pair.split(',');
      if (category && level) {
        header.levels[category.trim()] = level.trim();
      }
    }
  }
  return header;
}

// Milliseconds since midnight -> "HH:MM:SS.mmm".
function clockTime(ms) {
  const day = 24 * 3600 * 1000;
  const t = ((Math.round(ms) % day) + day) % day;
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  return `${pad(Math.floor(t / 3600000))}:${pad(Math.floor(t / 60000) % 60)}:${pad(Math.floor(t / 1000) % 60)}.${pad(t % 1000, 3)}`;
}

function levelAtLeast(level, wanted) {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(wanted);
}

// "SELECT a, b, (SELECT c FROM d) FROM Obj WHERE ..." -> { object: 'obj', fields: ['a', 'b'] }.
// Sub-queries are dropped first so their FROM is not taken for the main one.
function soqlShape(query) {
  let flat = String(query || '').toLowerCase();
  for (let i = 0; i < 5 && /\([^()]*\)/.test(flat); i++) {
    flat = flat.replace(/\([^()]*\)/g, ' ');
  }
  const match = /^\s*(?:select|find)\s+([\s\S]*?)\s+from\s+(\w+)/.exec(flat) || /\bfrom\s+(\w+)/.exec(flat);
  if (!match) {
    return undefined;
  }
  const object = match[2] || match[1];
  const fields = match[2] ? match[1].split(',').map((f) => f.trim()).filter((f) => /^[\w.]+$/.test(f)) : [];
  return { object, fields };
}

// How well source line `line` (1-based) fits an event the log tied to it:
// 0 = does not fit, higher = better. Returns 1 when the event cannot be
// checked (dynamic SOQL, for example) so the log's own place is kept.
function sourceFit(lines, line, kind, info) {
  if (!lines || !line || line > lines.length) {
    return 0;
  }
  const here = lines[line - 1].toLowerCase();
  if (kind === 'debug') {
    return /\bdebug\s*\(/.test(here) ? 1 : 0;
  }
  if (kind === 'exception') {
    // A custom exception comes from a throw; a System one can come from any code line.
    const code = here.replace(/\/\/.*$/, '').trim();
    if (!code || /^(\/?\*|[{}]+$)/.test(code)) {
      return 0;
    }
    return /^system\./i.test(info.type || '') || /\bthrow\b/.test(code) ? 1 : 0;
  }
  if (kind === 'dml') {
    const op = String(info.op || '').toLowerCase();
    return op && new RegExp(`\\b${op}\\b`).test(here) ? 1 : 0;
  }
  // SOQL / SOSL: the inline query starts on this line or the next one.
  const window = lines.slice(line - 1, line + 24).join(' ').toLowerCase().replace(/\s+/g, ' ');
  if (/\b(?:database|search)\s*\.\s*(?:query|countquery|querywithbinds|getquerylocator)\s*\(\s*[^[\s]/.test(here)) {
    return 1;
  }
  const start = `${here} ${line < lines.length ? lines[line].toLowerCase() : ''}`;
  if (!/\[/.test(start) || !info.shape) {
    return 0;
  }
  const open = window.indexOf('[');
  const close = window.indexOf(']', open);
  const shape = soqlShape(window.slice(open + 1, close < 0 ? undefined : close));
  if (!shape || shape.object !== info.shape.object) {
    return 0;
  }
  return 2 + info.shape.fields.filter((f) => shape.fields.includes(f)).length;
}

function analyzeLog(text, options = {}) {
  const known = options.knownClasses ? new Set([...options.knownClasses].map((name) => String(name).toLowerCase())) : undefined;
  const lines = String(text || '').split(/\r?\n/);
  const header = parseHeader(lines[0]);
  const apexLevel = header.levels.APEX_CODE;
  // Prefer what the log actually contains over what its header promises.
  const statementLevel = text.includes('|STATEMENT_EXECUTE|') || (!!apexLevel && levelAtLeast(apexLevel, 'FINER'));

  const result = {
    header,
    apexLevel,
    statementLevel,
    variableLevel: text.includes('|VARIABLE_ASSIGNMENT|'),
    user: undefined,
    files: new Map(),
    steps: [],
    stepsCapped: false,
    exceptions: [],
    units: [],
    methods: new Map(),
    queries: new Map(),
    triggers: new Map(),
    truncated: false,
    incomplete: false,
    notes: [],
    firstNanos: undefined,
    lastNanos: undefined,
    logLines: lines.length,
    // Workspace source the analysis matched against (logs below FINE only).
    source: options.source
  };

  const stack = [];
  let openException = -1; // exception still waiting to see where execution resumes
  let openQueries = [];
  let finished = false;

  const top = () => stack[stack.length - 1];

  function fileData(key, kind, name) {
    let data = result.files.get(key);
    if (!data) {
      data = { key, kind, name, lines: new Map(), methods: new Set(), callSites: [], exceptions: 0, firstStep: -1 };
      result.files.set(key, data);
    }
    return data;
  }

  function lineData(frame, line) {
    if (!frame || !frame.file || !line) {
      return undefined;
    }
    const file = fileData(frame.file, frame.fileKind, frame.fileName);
    let data = file.lines.get(line);
    if (!data) {
      data = { line, stmt: 0, other: 0, steps: [], stepTotal: 0, methods: new Set(), calls: new Map(), debug: [], soql: [], dml: [], vars: [], exceptions: [], resumes: [], callouts: 0 };
      file.lines.set(line, data);
    }
    data.methods.add(frame.label);
    file.methods.add(frame.label);
    return data;
  }

  function addStep(kind, frame, line, textValue, at, nanos) {
    if (result.steps.length >= MAX_STEPS) {
      result.stepsCapped = true;
      return -1;
    }
    const index = result.steps.length;
    result.steps.push({
      kind,
      file: frame ? frame.file : undefined,
      line,
      depth: stack.length,
      frame: frame ? frame.label : '',
      fid: frame ? frame.id : undefined,
      time: now,
      text: textValue,
      at,
      ms: result.firstNanos === undefined ? 0 : Math.round((nanos - result.firstNanos) / 1e5) / 10
    });
    if (frame && frame.file) {
      const file = result.files.get(frame.file);
      if (file && file.firstStep < 0) {
        file.firstStep = index;
      }
    }
    return index;
  }

  function link(data, step) {
    if (!data || step < 0) {
      return;
    }
    data.stepTotal++;
    if (data.steps.length < MAX_LINE_STEPS) {
      data.steps.push(step);
    }
  }

  function note(list, value) {
    if (list.length < MAX_LINE_NOTES) {
      list.push(value);
    }
  }

  // The first Apex activity after an exception shows where execution resumed.
  function resume(frame, line, step) {
    if (openException < 0 || !frame || !frame.file || !line) {
      return;
    }
    const exception = result.exceptions[openException];
    openException = -1;
    if (exception.status !== 'thrown') {
      return;
    }
    exception.status = 'continued';
    exception.resumedAt = { file: frame.file, fileName: frame.fileName, line, frame: frame.label, step, sameFrame: frame.id === exception.frameId };
    const data = lineData(frame, line);
    if (data) {
      data.resumes.push(exception.index);
    }
    if (step >= 0) {
      result.steps[step].resumeOf = exception.index;
    }
  }

  // Marks a line as having run because of an event other than STATEMENT_EXECUTE.
  function touchOther(frame, line) {
    const data = lineData(frame, line);
    if (data) {
      data.other++;
    }
    return data;
  }

  // Below Apex Code FINE the log has no METHOD_ENTRY, so a query or DML run by
  // another class is logged with that class's line number but no class name.
  // With the workspace source we check the line really holds the event and, if
  // not, move it to the one class whose same line does.
  const source = options.source;
  let moved = 0;
  let unplaced = 0;
  const lastPlaced = new Map(); // frame id -> file the last moved event went to
  const unitTexts = new Map();
  function placeAt(frame, line, kind, info) {
    if (!source || !frame || frame.kind !== 'unit' || !line || !frame.file || !source.has(frame.file)) {
      return frame;
    }
    if (sourceFit(source.get(frame.file).lines, line, kind, info)) {
      return frame;
    }
    // Many classes may fit the same line (a debug call on line 20, say). Prefer
    // the class this run was already placed in, then classes the unit's own
    // source names (a trigger calling its handler).
    if (!unitTexts.has(frame.file)) {
      unitTexts.set(frame.file, source.get(frame.file).lines.join('\n').toLowerCase());
    }
    const unitText = unitTexts.get(frame.file);
    let best;
    let bestScore = 0;
    let tie = false;
    for (const [key, entry] of source) {
      let score = key === frame.file ? 0 : sourceFit(entry.lines, line, kind, info);
      if (score) {
        score += (lastPlaced.get(frame.id) === key ? 0.5 : 0) + (new RegExp(`\\b${entry.name.toLowerCase()}\\b`).test(unitText) ? 0.25 : 0);
      }
      if (score > bestScore) {
        best = key;
        bestScore = score;
        tie = false;
      } else if (score && score === bestScore) {
        tie = true;
      }
    }
    if (!best || tie) {
      unplaced++;
      return { ...frame, file: undefined, fileName: undefined };
    }
    moved++;
    lastPlaced.set(frame.id, best);
    const fileKind = best.split(':')[0];
    const name = source.get(best).name;
    fileData(best, fileKind, name);
    return { kind: 'unit', label: `${name} (matched by source)`, name, file: best, fileKind, fileName: name, id: frame.id };
  }

  let now; // clock time of the event being handled, as the log prints it
  let frameIds = 0;
  function pushFrame(frame) {
    frame.id = ++frameIds;
    stack.push(frame);
    return frame;
  }

  function popFrame(nanos) {
    const frame = stack.pop();
    if (frame && frame.kind !== 'unit') {
      const stats = result.methods.get(frame.label);
      if (stats && frame.start !== undefined) {
        stats.ns += nanos - frame.start;
      }
    }
    return frame;
  }

  function classFrame(kind, signature, nanos, call) {
    const { path, method } = splitSignature(signature);
    const owner = ownerClass(path, known);
    const frame = {
      kind,
      label: signature,
      name: signature.replace(/\s+/g, ''),
      method,
      classPath: path.join('.'),
      file: owner ? fileKey('class', owner) : undefined,
      fileKind: 'class',
      fileName: owner,
      start: nanos,
      callFile: call && call.file,
      callLine: call && call.line
    };
    if (frame.file) {
      fileData(frame.file, 'class', owner);
    }
    return frame;
  }

  function unitFrame(fields, nanos) {
    // Trigger: "...|AccountTrigger on Account trigger event BeforeInsert|__sfdc_trigger/AccountTrigger"
    for (const field of fields) {
      const match = /__sfdc_trigger\/(?:\w+\/)?(\w+)/.exec(field);
      if (match) {
        const label = fields.find((f) => / trigger event /.test(f)) || `${match[1]} trigger`;
        return triggerFrame(match[1], label, nanos);
      }
    }
    const idIndex = fields.findIndex((field) => RECORD_ID.test(field));
    const id = idIndex >= 0 ? fields[idIndex] : '';
    const after = idIndex >= 0 ? fields.slice(idIndex + 1).join('|') : fields[fields.length - 1] || '';
    if (/^01q/.test(id)) {
      const match = /^(\w+) on /.exec(after);
      if (match) {
        return triggerFrame(match[1], after, nanos);
      }
    }
    if (/^01p/.test(id)) {
      // "MyClass.myMethod()" names a method; "MyController invoke(save)" or "MyBatch" a class.
      const text = after.split('|')[0];
      const match = /^([\w.]+)(\(|\s|$)/.exec(text);
      if (match) {
        if (match[2] === '(') {
          return classFrame('unit', text, nanos);
        }
        let owner = ownerClass(match[1].split('.'), known);
        // A scheduled job logs the job's own name ("MyBatch_00", "MyBatch Nightly"),
        // which is usually the class name plus a suffix. Take the longest workspace
        // class it starts with.
        if (owner && known && !known.has(owner.toLowerCase())) {
          const lower = text.toLowerCase();
          const guess = [...known].filter((name) => lower.startsWith(name) && /^[\W_\d]/.test(lower.slice(name.length))).sort((a, b) => b.length - a.length)[0];
          if (guess) {
            owner = text.slice(0, guess.length);
            if (!result.notes.some((n) => n.startsWith('Scheduled job'))) {
              result.notes.push(`Scheduled job "${text}" is matched to class ${owner} by name.`);
            }
          }
        }
        if (owner) {
          fileData(fileKey('class', owner), 'class', owner);
        }
        return { kind: 'unit', label: text, name: text, classPath: match[1], file: owner ? fileKey('class', owner) : undefined, fileKind: 'class', fileName: owner, start: nanos };
      }
    }
    return { kind: 'unit', label: after || 'Code unit', name: after, file: undefined, start: nanos };
  }

  function triggerFrame(name, label, nanos) {
    const key = fileKey('trigger', name);
    fileData(key, 'trigger', name);
    const event = /trigger event (\w+)/.exec(label);
    const stats = result.triggers.get(key) || { name, runs: 0, events: {}, recursive: false, maxNesting: 0 };
    const nested = stack.filter((frame) => frame.kind === 'unit' && frame.file === key).length;
    if (nested) {
      stats.recursive = true;
    }
    stats.maxNesting = Math.max(stats.maxNesting, nested + 1);
    stats.runs++;
    if (event) {
      stats.events[event[1]] = (stats.events[event[1]] || 0) + 1;
    }
    result.triggers.set(key, stats);
    return { kind: 'unit', label, name: label, method: name, file: key, fileKind: 'trigger', fileName: name, start: nanos, trigger: true };
  }

  function methodStats(frame) {
    let stats = result.methods.get(frame.label);
    if (!stats) {
      stats = { label: frame.label, file: frame.file, fileName: frame.fileName, calls: 0, ns: 0, recursive: false, maxDepth: 0 };
      result.methods.set(frame.label, stats);
    }
    stats.calls++;
    const depth = stack.filter((other) => other.kind !== 'unit' && other.name === frame.name).length;
    if (depth) {
      stats.recursive = true;
    }
    stats.maxDepth = Math.max(stats.maxDepth, depth + 1);
    return stats;
  }

  // The call stack at this moment, innermost first, with the line in each frame.
  function stackTrace(line) {
    const trace = [];
    let currentLine = line;
    for (let i = stack.length - 1; i >= 0; i--) {
      const frame = stack[i];
      trace.push({ frame: frame.label, file: frame.file, fileName: frame.fileName, line: currentLine });
      currentLine = frame.callLine;
    }
    return trace;
  }

  function handle(ev) {
    const { event, fields, nanos, at, time } = ev;
    now = time;
    const frame = top();
    switch (event) {
      case 'USER_INFO': {
        const id = fields.find((field) => /^005/.test(field) && RECORD_ID.test(field));
        const username = fields.find((field) => /@/.test(field));
        result.user = { id, username };
        break;
      }
      case 'EXECUTION_FINISHED':
        finished = true;
        break;
      case 'CODE_UNIT_STARTED': {
        const unit = pushFrame(unitFrame(fields, nanos));
        result.units.push({ label: unit.label, file: unit.file, fileName: unit.fileName, trigger: !!unit.trigger, depth: stack.length });
        addStep('unit', unit, undefined, `Start ${unit.label}`, at, nanos);
        break;
      }
      case 'CODE_UNIT_FINISHED': {
        while (stack.length) {
          const popped = popFrame(nanos);
          if (popped.kind === 'unit') {
            break;
          }
        }
        // An exception that leaves a code unit (a trigger, say) is reported to
        // the caller in some other form, typically a DmlException.
        if (openException >= 0 && result.exceptions[openException].depth > stack.length) {
          const exception = result.exceptions[openException];
          if (exception.status === 'thrown') {
            exception.status = 'leftUnit';
          }
          openException = -1;
        }
        break;
      }
      case 'METHOD_ENTRY':
      case 'CONSTRUCTOR_ENTRY': {
        const line = lineOf(fields[0]);
        const isConstructor = event === 'CONSTRUCTOR_ENTRY';
        // METHOD_ENTRY|[51]|01p..|Cls.method(args)   CONSTRUCTOR_ENTRY|[5]|01p..|<init>(args)|Cls
        const className = fields[fields.length - 1];
        const signature = isConstructor
          ? `${className}.${(fields[fields.length - 2] || '<init>()').replace('<init>', className.split('.').pop())}`
          : className;
        const callee = classFrame(isConstructor ? 'constructor' : 'method', signature, nanos, frame ? { file: frame.file, line } : undefined);
        // A static initialiser ("Cls.Cls()" or "<clinit>") has no real call site.
        const lastPath = callee.classPath.split('.').pop();
        const initialiser = !isConstructor && (callee.method === lastPath || callee.method === '<clinit>');
        let step = -1;
        if (frame && line && !initialiser) {
          const data = touchOther(frame, line);
          step = addStep('call', frame, line, `${isConstructor ? 'new ' : 'Calls '}${callee.label}`, at, nanos);
          link(data, step);
          if (data) {
            data.calls.set(callee.label, (data.calls.get(callee.label) || 0) + 1);
          }
          resume(frame, line, step);
          if (frame.file) {
            const file = result.files.get(frame.file);
            if (file.callSites.length < 400) {
              file.callSites.push({ line, expect: isConstructor ? lastPath : callee.method });
            }
          }
        }
        methodStats(callee);
        pushFrame(callee);
        if (step >= 0) {
          result.steps[step].enters = callee.file;
        }
        break;
      }
      case 'METHOD_EXIT':
      case 'CONSTRUCTOR_EXIT': {
        const signature = fields[fields.length - 1] || '';
        const wanted = event === 'CONSTRUCTOR_EXIT' ? undefined : signature.replace(/\s+/g, '');
        for (let i = stack.length - 1; i >= 0; i--) {
          const candidate = stack[i];
          if (candidate.kind === 'unit') {
            break;
          }
          const matches =
            event === 'CONSTRUCTOR_EXIT'
              ? candidate.kind === 'constructor' && candidate.classPath.toLowerCase() === String(signature).toLowerCase()
              : candidate.name === wanted || candidate.classPath === signature;
          if (matches) {
            while (stack.length > i) {
              popFrame(nanos);
            }
            break;
          }
        }
        break;
      }
      case 'STATEMENT_EXECUTE': {
        const line = lineOf(fields[0]);
        const data = lineData(frame, line);
        if (!data) {
          break;
        }
        data.stmt++;
        const step = addStep('statement', frame, line, undefined, at, nanos);
        link(data, step);
        resume(frame, line, step);
        break;
      }
      case 'SYSTEM_METHOD_ENTRY':
      case 'SYSTEM_CONSTRUCTOR_ENTRY': {
        const line = lineOf(fields[0]);
        if (!result.statementLevel && frame && line) {
          touchOther(frame, line);
        }
        resume(frame, line, -1);
        break;
      }
      case 'VARIABLE_ASSIGNMENT': {
        const line = lineOf(fields[0]);
        const data = lineData(frame, line);
        if (data) {
          note(data.vars, { name: fields[1], value: clip(fields.slice(2).join('|').replace(/\|0x[0-9a-f]+$/i, ''), 300) });
          const last = result.steps[result.steps.length - 1];
          if (last && last.line === line && last.file === frame.file) {
            (last.vars || (last.vars = [])).length < 10 && last.vars.push(`${fields[1]} = ${clip(fields[2], 120)}`);
          }
        }
        break;
      }
      case 'USER_DEBUG': {
        const line = lineOf(fields[0]);
        const message = clip([fields.slice(2).join('|'), ...ev.extra].join('\n'));
        const where = placeAt(frame, line, 'debug', {});
        const data = touchOther(where, line);
        if (data) {
          note(data.debug, { level: fields[1], text: message, time });
        }
        const step = addStep('debug', where, line, `System.debug: ${message}`, at, nanos);
        if (step >= 0) {
          result.steps[step].level = fields[1];
        }
        link(data, step);
        resume(where, line, step);
        break;
      }
      case 'SOQL_EXECUTE_BEGIN':
      case 'SOSL_EXECUTE_BEGIN': {
        const line = lineOf(fields[0]);
        const query = clip(fields.slice(2).join('|'), 1000);
        const where = placeAt(frame, line, 'soql', { shape: soqlShape(query) });
        const record = { text: query, rows: undefined, start: nanos, time, file: where && where.file, fileName: where && where.fileName, line };
        openQueries.push(record);
        const data = touchOther(where, line);
        if (data) {
          note(data.soql, record);
          data.soqlCount = (data.soqlCount || 0) + 1;
        }
        const normalised = query.replace(/\s+/g, ' ').trim();
        const total = result.queries.get(normalised) || { text: normalised, count: 0, places: new Set() };
        total.count++;
        if (where && where.fileName && line) {
          total.places.add(`${where.fileName}:${line}`);
        }
        result.queries.set(normalised, total);
        const step = addStep('soql', where, line, `${event.startsWith('SOSL') ? 'SOSL' : 'SOQL'}: ${clip(query, 300)}`, at, nanos);
        link(data, step);
        resume(where, line, step);
        break;
      }
      case 'SOQL_EXECUTE_END':
      case 'SOSL_EXECUTE_END': {
        const record = openQueries.pop();
        if (record) {
          const rows = /Rows:(\d+)/.exec(ev.rest);
          record.rows = rows ? Number(rows[1]) : undefined;
          record.ms = Math.round((nanos - record.start) / 1e5) / 10;
        }
        break;
      }
      case 'DML_BEGIN': {
        const line = lineOf(fields[0]);
        const op = /Op:(\w+)/.exec(ev.rest);
        const type = /Type:([\w.]+)/.exec(ev.rest);
        const rows = /Rows:(\d+)/.exec(ev.rest);
        const record = { op: op ? op[1] : '', object: type ? type[1] : '', rows: rows ? Number(rows[1]) : undefined, time };
        const where = placeAt(frame, line, 'dml', record);
        const data = touchOther(where, line);
        if (data) {
          note(data.dml, record);
          data.dmlCount = (data.dmlCount || 0) + 1;
        }
        const step = addStep('dml', where, line, `DML ${record.op} ${record.object}${record.rows !== undefined ? ` (${record.rows} row${record.rows === 1 ? '' : 's'})` : ''}`, at, nanos);
        link(data, step);
        resume(where, line, step);
        break;
      }
      case 'CALLOUT_REQUEST': {
        const line = lineOf(fields[0]);
        const data = touchOther(frame, line);
        if (data) {
          data.callouts++;
        }
        const step = addStep('callout', frame, line, `Callout: ${clip(fields.slice(1).join('|'), 300)}`, at, nanos);
        link(data, step);
        break;
      }
      case 'EXCEPTION_THROWN': {
        const line = lineOf(fields[0]);
        const message = clip([fields.slice(line === undefined ? 0 : 1).join('|'), ...ev.extra].join('\n'));
        const type = (/^([\w.]+)(?::|$)/.exec(message) || [])[1] || 'Exception';
        // Salesforce logs the same exception again at each enclosing statement
        // (an if, a loop, the call line) as it unwinds. That is not a new throw:
        // the line ran, and the exception is still the one thrown before.
        const open = openException >= 0 && result.exceptions[openException];
        if (open && open.status === 'thrown' && open.message === message && open.frameId === (frame && frame.id) && result.steps.length - 1 === open.lastStep) {
          touchOther(open.where || frame, line);
          (open.passedThrough || (open.passedThrough = [])).push(line);
          break;
        }
        if (openException >= 0 && result.exceptions[openException].status === 'thrown') {
          // Thrown again, wrapped or re-raised before any other code ran.
          result.exceptions[openException].status = 'followed';
          result.exceptions[openException].next = result.exceptions.length;
        }
        const where = placeAt(frame, line, 'exception', { type });
        const exception = {
          index: result.exceptions.length,
          type,
          message,
          file: where && where.file,
          fileName: where && where.fileName,
          line,
          frame: frame ? frame.label : '',
          frameId: frame && frame.id,
          depth: stack.length,
          status: 'thrown',
          at,
          time,
          stack: stackTrace(line),
          where
        };
        if (where !== frame && exception.stack[0]) {
          Object.assign(exception.stack[0], { file: where.file, fileName: where.fileName, frame: where.label });
        }
        result.exceptions.push(exception);
        const data = lineData(where, line);
        if (data) {
          data.exceptions.push(exception.index);
          if (!data.stmt) {
            data.other++;
          }
          result.files.get(where.file).exceptions++;
        }
        exception.step = addStep('exception', where, line, `${type} thrown: ${clip(message, 300)}`, at, nanos);
        link(data, exception.step);
        exception.lastStep = exception.step;
        openException = exception.index;
        break;
      }
      case 'FATAL_ERROR': {
        const body = [ev.rest, ...ev.extra].join('\n');
        const firstLine = body.split('\n')[0];
        const type = (/^([\w.]+)(?::|$)/.exec(firstLine) || [])[1] || 'Exception';
        // Salesforce's own stack: "Class.Ns.Cls.method: line 25, column 1" / "Trigger.Name: line 3, column 1".
        const trace = [];
        for (const match of body.matchAll(/^(Class|Trigger)\.([\w.]+): line (\d+), column \d+/gm)) {
          const isTrigger = match[1] === 'Trigger';
          const path = match[2].split('.');
          const owner = isTrigger ? path[path.length - 1] : ownerClass(path.slice(0, -1).length ? path.slice(0, -1) : path, known);
          trace.push({ frame: match[2], file: fileKey(isTrigger ? 'trigger' : 'class', owner), fileName: owner, kind: isTrigger ? 'trigger' : 'class', line: Number(match[3]) });
        }
        // The matching exception, if one was logged, is the one that went unhandled.
        let exception;
        for (let i = result.exceptions.length - 1; i >= 0; i--) {
          if (result.exceptions[i].type === type) {
            exception = result.exceptions[i];
            break;
          }
        }
        if (!exception && trace.length) {
          // Only the fatal error was logged (Apex Code below FINE): take its location from the stack.
          const where = trace[0];
          exception = { index: result.exceptions.length, type, message: clip(body), file: where.file, fileName: where.fileName, line: where.line, frame: where.frame, depth: 0, status: 'thrown', at, stack: trace };
          result.exceptions.push(exception);
          fileData(where.file, where.kind, where.fileName);
          const data = lineData({ file: where.file, fileKind: where.kind, fileName: where.fileName, label: where.frame }, where.line);
          data.exceptions.push(exception.index);
          data.other++;
          result.files.get(where.file).exceptions++;
          exception.step = addStep('exception', { file: where.file, label: where.frame }, where.line, `${type} thrown`, at, nanos);
          link(data, exception.step);
        }
        if (exception) {
          exception.status = 'unhandled';
          exception.fatalText = clip(body);
          if (trace.length) {
            exception.stack = trace;
          }
        }
        // The stack lines are call sites Salesforce confirms ran.
        for (const where of trace) {
          const file = result.files.get(where.file);
          if (file && !file.lines.has(where.line)) {
            lineData({ file: where.file, fileKind: where.kind, fileName: where.fileName, label: where.frame }, where.line).other++;
          }
        }
        addStep('fatal', frame, undefined, `Unhandled ${type}: ${clip(firstLine, 300)}`, at, nanos);
        openException = -1;
        break;
      }
      default:
        break;
    }
  }

  let pending;
  let startMs;
  for (let n = 0; n < lines.length; n++) {
    const raw = lines[n];
    const match = LINE.exec(raw);
    if (!match) {
      if (/^\*\*\* Skipped \d+ bytes of detailed log/.test(raw) || /MAXIMUM DEBUG LOG SIZE REACHED/.test(raw)) {
        result.truncated = true;
      }
      if (pending && raw) {
        pending.extra.push(raw);
      }
      continue;
    }
    if (pending) {
      handle(pending);
    }
    const nanos = Number(match[2]);
    if (result.firstNanos === undefined) {
      result.firstNanos = nanos;
    }
    result.lastNanos = nanos;
    const rest = match[4] || '';
    // The printed time is the transaction's start; the bracketed nanoseconds
    // are elapsed since then. Together they give the event's exact clock time.
    if (startMs === undefined) {
      const [h, m, sec] = match[1].split(':');
      startMs = ((Number(h) * 60 + Number(m)) * 60 + Number(sec)) * 1000;
    }
    pending = { event: match[3], rest, fields: rest.split('|'), nanos, at: n + 1, time: clockTime(startMs + nanos / 1e6), extra: [] };
  }
  if (pending) {
    handle(pending);
  }

  if (stack.length || !finished) {
    result.incomplete = true;
  }
  if (result.truncated) {
    result.notes.push('The log was cut short by Salesforce (it reached the maximum log size). Lines after the cut are not recorded.');
  } else if (result.incomplete) {
    result.notes.push('The log ends before the transaction finished. It may be incomplete.');
  }
  if (!result.statementLevel) {
    result.notes.push(`Apex Code was logged at ${apexLevel || 'an unknown level'}, below FINER, so individual statements were not recorded. Only lines with calls, queries, DML, debug output or exceptions are shown.`);
  }
  if (result.stepsCapped) {
    result.notes.push(`Replay holds the first ${MAX_STEPS.toLocaleString()} steps; line highlighting covers the whole log.`);
  }
  result.durationMs = result.firstNanos === undefined ? 0 : Math.round((result.lastNanos - result.firstNanos) / 1e6);
  if (moved) {
    result.notes.push(`${moved} quer${moved === 1 ? 'y, DML or debug line was' : 'ies, DML or debug lines were'} placed by matching the source: the log has no method entries (Apex Code below FINE), so it does not say which class ran them.`);
  }
  if (unplaced) {
    result.notes.push(`${unplaced} quer${unplaced === 1 ? 'y, DML or debug line' : 'ies, DML or debug lines'} could not be tied to a source line: the log has no method entries and no single class matches.`);
  }
  return result;
}

// How many times a line ran: its statements when those were logged, else the
// events that prove it ran.
function lineCount(data) {
  return data.stmt || data.other;
}

// Performance and correctness findings, each marked as confirmed (read
// straight from the log) or inferred (a likely cause, worth checking).
function findings(analysis, options = {}) {
  const hot = options.hotThreshold || 50;
  const list = [];
  for (const file of analysis.files.values()) {
    for (const data of file.lines.values()) {
      const where = { file: file.key, fileName: file.name, line: data.line };
      if ((data.soqlCount || 0) > 1) {
        list.push({ ...where, kind: 'soqlLoop', severity: 'warning', confirmed: false, text: `Query ran ${data.soqlCount} times from ${file.name} line ${data.line}: likely SOQL inside a loop` });
      }
      if ((data.dmlCount || 0) > 1) {
        list.push({ ...where, kind: 'dmlLoop', severity: 'warning', confirmed: false, text: `DML ran ${data.dmlCount} times from ${file.name} line ${data.line}: likely DML inside a loop` });
      }
      if (lineCount(data) >= hot) {
        list.push({ ...where, kind: 'hotLine', severity: 'info', confirmed: false, text: `${file.name} line ${data.line} ran ${lineCount(data).toLocaleString()} times` });
      }
    }
  }
  for (const query of analysis.queries.values()) {
    if (query.count > 1) {
      list.push({ kind: 'repeatedQuery', severity: 'warning', confirmed: true, text: `Same query ran ${query.count} times (${[...query.places].slice(0, 3).join(', ') || 'unknown place'}): ${query.text.slice(0, 140)}` });
    }
  }
  for (const method of analysis.methods.values()) {
    if (method.recursive) {
      list.push({ file: method.file, fileName: method.fileName, kind: 'recursion', severity: 'warning', confirmed: true, text: `${method.label} called itself (recursion ${method.maxDepth} deep)` });
    } else if (method.calls >= hot) {
      list.push({ file: method.file, fileName: method.fileName, kind: 'hotMethod', severity: 'info', confirmed: true, text: `${method.label} was called ${method.calls.toLocaleString()} times` });
    }
  }
  for (const [key, trigger] of analysis.triggers) {
    if (trigger.recursive) {
      list.push({ file: key, fileName: trigger.name, kind: 'triggerRecursion', severity: 'warning', confirmed: true, text: `${trigger.name} fired again while it was still running (${trigger.maxNesting} levels deep)` });
    } else if (trigger.runs > 1) {
      const events = Object.entries(trigger.events).map(([event, n]) => `${event} ×${n}`).join(', ');
      list.push({ file: key, fileName: trigger.name, kind: 'triggerRepeat', severity: 'info', confirmed: true, text: `${trigger.name} ran ${trigger.runs} times${events ? ` (${events})` : ''}` });
    }
  }
  const limits = options.limits || {};
  const names = { soql: 'SOQL queries', queryRows: 'Query rows', dml: 'DML statements', dmlRows: 'DML rows', cpu: 'CPU time', heap: 'Heap', callouts: 'Callouts' };
  for (const [key, label] of Object.entries(names)) {
    const limit = limits[key];
    if (limit && limit.max && limit.used / limit.max >= 0.8) {
      list.push({ kind: 'limit', severity: 'error', confirmed: true, text: `${label}: ${limit.used.toLocaleString()} of ${limit.max.toLocaleString()} (${Math.round((limit.used / limit.max) * 100)}% of the limit)` });
    }
  }
  const order = { error: 0, warning: 1, info: 2 };
  return list.sort((a, b) => order[a.severity] - order[b.severity]);
}

// What each recorded line of one file should look like:
// 'exception' (red), 'hot' (yellow) or 'executed' (green). Lines that are not
// in the map were not recorded and stay plain.
function lineStates(analysis, key, options = {}) {
  const hot = options.hotThreshold || 50;
  const states = new Map();
  const file = analysis.files.get(key);
  if (!file) {
    return states;
  }
  for (const data of file.lines.values()) {
    let state = 'executed';
    if (data.exceptions.length) {
      state = 'exception';
    } else if (lineCount(data) >= hot || (data.soqlCount || 0) > 1 || (data.dmlCount || 0) > 1) {
      state = 'hot';
    }
    states.set(data.line, { state, count: lineCount(data), data });
  }
  return states;
}

// Below FINER the log names only lines that wrote an event (a query, DML,
// debug output...), so plain statements between them look as if they never
// ran. When two recorded lines of the same run follow each other forwards and
// nothing between them can branch, the code lines in between almost certainly
// ran. These are inferred, never recorded, and are shown as such.
const BRANCH = /\b(if|else|switch|when|catch|finally|return|throw|break|continue)\b/;
function inferredLines(analysis, key, lineText, lineCountInDoc, maxGap = 40) {
  const inferred = new Map();
  const file = analysis.files.get(key);
  if (!file || analysis.statementLevel) {
    return inferred;
  }
  const last = new Map();
  for (const step of analysis.steps) {
    if (step.file !== key || !step.line || step.fid === undefined) {
      continue;
    }
    const from = last.get(step.fid);
    last.set(step.fid, step.line);
    if (from === undefined || step.line <= from + 1 || step.line - from > maxGap || step.line > lineCountInDoc) {
      continue;
    }
    const gap = [];
    let branches = false;
    for (let line = from + 1; line < step.line; line++) {
      const text = lineText(line).replace(/\/\/.*$/, '').replace(/'(?:\\.|[^'\\])*'/g, "''").trim();
      if (BRANCH.test(text) || /^\/?\*/.test(text)) {
        branches = true;
        break;
      }
      if (text && !/^[{}()\];,\s]*$/.test(text) && !file.lines.has(line)) {
        gap.push(line);
      }
    }
    if (!branches) {
      for (const line of gap) {
        if (!inferred.has(line)) {
          inferred.set(line, { from, to: step.line });
        }
      }
    }
  }

  // A jump from this file into another method (here or in another file the
  // analysis has source for) means the call line ran, even though the log
  // (without METHOD_ENTRY) does not name it: a trigger calling its handler, a
  // method calling a helper.
  const spans = methodSpans(lineText, lineCountInDoc);
  const methodOf = (list, line) => list.filter((s) => line >= s.start && line <= s.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  const otherSpans = new Map();
  const spansOf = (otherKey) => {
    if (!otherSpans.has(otherKey)) {
      const entry = analysis.source && analysis.source.get(otherKey);
      otherSpans.set(otherKey, entry ? methodSpans((n) => entry.lines[n - 1] || '', entry.lines.length) : []);
    }
    return otherSpans.get(otherKey);
  };
  const previous = new Map();
  for (const step of analysis.steps) {
    if (!step.file || !step.line || step.fid === undefined) {
      continue;
    }
    const prev = previous.get(step.fid);
    previous.set(step.fid, { file: step.file, line: step.line });
    if (!prev || prev.file !== key) {
      continue;
    }
    const callee = step.file === key ? methodOf(spans, step.line) : methodOf(spansOf(step.file), step.line);
    const caller = methodOf(spans, prev.line);
    if (!callee || (step.file === key && callee === caller)) {
      continue;
    }
    const call = new RegExp(`(^|[^\\w])${callee.name}\\s*\\(`, 'i');
    const last = caller ? caller.end : lineCountInDoc;
    for (let line = prev.line + 1; line <= last; line++) {
      if (call.test(lineText(line).replace(/\/\/.*$/, ''))) {
        if (!file.lines.has(line) && !inferred.has(line)) {
          inferred.set(line, { from: prev.line, to: step.line, calls: callee.name });
        }
        break;
      }
    }
  }
  return inferred;
}

// Lines of `key` that an exception thrown further down left early: the call
// lines in its stack trace up to and including the frame that caught it
// (that call jumped to its catch), or every one when nothing caught it. `inScope(stepIndex)` limits it to one trigger run.
function abortedLines(analysis, key, inScope) {
  const out = new Set();
  for (const ex of analysis.exceptions) {
    if (inScope && !inScope(ex.step)) {
      continue;
    }
    for (const s of ex.stack || []) {
      if (s.file === key && s.line) {
        out.add(s.line);
      }
      if (ex.status === 'continued' && ex.resumedAt && s.frame === ex.resumedAt.frame) {
        break;
      }
    }
  }
  return out;
}

// The log never names a line holding only `}`. Such a line ran when control
// reached the end of its block: the last statement before it ran, did not
// throw (`failed`) and was not a return, throw, break or continue. After a
// nested `}` it depends on that block's statement: an if/else or try/catch
// chain is done when one of its blocks reached its end, and an if without
// else or a loop is also done when its condition line ran. A class's own
// closing brace counts only when its declaration line ran.
const BLOCK_HEAD = /^\s*(?:}\s*)?(else\s+if|else|if|for|while|do|try|catch|finally|when|switch)\b/;
function closingBraceLines(lines, ran, failed) {
  const code = [];
  let inComment = false;
  for (const raw of lines) {
    let text = '';
    for (let c = 0; c < raw.length; c++) {
      if (inComment) {
        if (raw.startsWith('*/', c)) {
          inComment = false;
          c++;
        }
      } else if (raw.startsWith('/*', c)) {
        inComment = true;
        c++;
      } else if (raw.startsWith('//', c)) {
        break;
      } else if (raw[c] === "'") {
        for (c++; c < raw.length && raw[c] !== "'"; c++) {
          if (raw[c] === '\\') c++;
        }
        text += "''";
      } else {
        text += raw[c];
      }
    }
    code.push(text.trim());
  }
  const at = (n) => code[n - 1] || '';
  const pureClose = (n) => at(n).includes('}') && /^[\s});,\]]*$/.test(at(n));
  const out = new Set();
  const doneAfter = new Map(); // pure `}` line -> control went on past its statement
  // Did control reach the point just before the `}` on line n?
  const reachedBefore = (n) => {
    let k = n - 1;
    while (k >= 1 && !at(k)) k--;
    if (k < 1) return false;
    if (pureClose(k)) return !!doneAfter.get(k);
    if (/^}/.test(at(k)) || /\{$/.test(at(k))) return false; // an empty block
    // Back to the first line of a statement split over several lines.
    while (k > 1 && !ran.has(k) && at(k - 1) && !/[;{}]$/.test(at(k - 1))) k--;
    return ran.has(k) && !failed.has(k) && !/^(return|throw|break|continue)\b/.test(at(k));
  };
  const open = [];
  for (let n = 1; n <= code.length; n++) {
    const text = at(n);
    let pending; // the chain a `} else {` / `} catch (...) {` continues
    for (const ch of text) {
      if (ch === '{') {
        const head = BLOCK_HEAD.exec(text);
        const kind = head ? head[1].replace(/\s+/g, ' ') : '';
        let chain = pending;
        if (!chain || !kind || /^(if|for|while|do|try|switch)$/.test(kind)) {
          chain = { kind, headLine: n, hasElse: false, reached: false };
        }
        if (kind === 'else') chain.hasElse = true;
        pending = undefined;
        open.push({ line: n, chain, decl: !head && /\b(class|interface|enum)\s+\w+/i.test(text) });
      } else if (ch === '}') {
        const block = open.pop();
        if (!block) continue;
        const reached = (block.decl ? ran.has(block.line) : true) && reachedBefore(n);
        const chain = block.chain;
        chain.reached = chain.reached || reached;
        pending = chain;
        if (pureClose(n)) {
          if (reached) out.add(n);
          // An if whose condition was false (or a loop that never looped)
          // still finishes; once a body was entered it must reach its end.
          const headRan = ran.has(chain.headLine) && !failed.has(chain.headLine);
          const skippable = (chain.kind === 'if' && !chain.hasElse) || /^(for|while)$/.test(chain.kind);
          let entered = false;
          for (let k = chain.headLine + 1; k < n && !entered; k++) {
            entered = ran.has(k);
          }
          doneAfter.set(n, chain.reached || (skippable && headRan && !entered));
        }
      }
    }
  }
  return out;
}

// Rough method boundaries from Apex source: the declaration line to its
// closing brace. Good enough to tell which method a line belongs to.
const DECLARATION = /^\s*(?:(?:public|private|protected|global|static|override|virtual|abstract|final|testmethod|webservice)\s+)*[\w.<>,[\]\s]*?[\w>\]]\s+(\w+)\s*\([^;=]*$/i;
const NOT_METHOD = /^(if|for|while|switch|catch|return|new|else|throw|when|do|try)$/i;
function methodSpans(lineText, count) {
  const spans = [];
  const open = [];
  let depth = 0;
  for (let line = 1; line <= count; line++) {
    const text = lineText(line).replace(/\/\/.*$/, '').replace(/'(?:\\.|[^'\\])*'/g, "''");
    const match = DECLARATION.exec(text);
    if (match && !NOT_METHOD.test(match[1]) && !/^\s*(return|new|throw|else)\b/.test(text)) {
      open.push({ name: match[1], start: line, depth });
    }
    for (const ch of text) {
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        const last = open[open.length - 1];
        if (last && depth === last.depth) {
          open.pop();
          spans.push({ name: last.name, start: last.start, end: line });
        }
      }
    }
  }
  return spans;
}

// Checks the open file against the log: every call the log recorded from a
// line should be visible on (or just below) that line. Misses mean the file
// has changed since the log was written, or it is a different file of the
// same name.
function verifySource(analysis, key, lineText, lineCountInDoc) {
  const file = analysis.files.get(key);
  const outcome = { checked: 0, mismatched: 0, beyondEnd: 0, samples: [] };
  if (!file) {
    return outcome;
  }
  let looked = 0;
  for (const [line, data] of file.lines) {
    if (line > lineCountInDoc) {
      outcome.beyondEnd++;
      continue;
    }
    // A statement the log saw run cannot sit on a blank or comment-only line.
    if (data.stmt && looked++ < 2000) {
      outcome.checked++;
      const text = lineText(line).trim();
      if (!text || /^(\/\/|\/\*|\*)/.test(text)) {
        outcome.mismatched++;
        if (outcome.samples.length < 3) {
          outcome.samples.push(`line ${line} ran, but it is now ${text ? 'a comment' : 'blank'}`);
        }
      }
    }
  }
  const seen = new Set();
  for (const site of file.callSites) {
    const id = `${site.line}|${site.expect}`;
    if (seen.has(id) || !site.expect || site.line > lineCountInDoc) {
      continue;
    }
    seen.add(id);
    outcome.checked++;
    const wanted = site.expect.toLowerCase();
    let found = false;
    for (let line = site.line; line <= Math.min(site.line + 1, lineCountInDoc); line++) {
      if (lineText(line).toLowerCase().includes(wanted)) {
        found = true;
        break;
      }
    }
    if (!found) {
      outcome.mismatched++;
      if (outcome.samples.length < 3) {
        outcome.samples.push(`line ${site.line} should call ${site.expect}`);
      }
    }
  }
  return outcome;
}

const STATUS_TEXT = {
  thrown: 'thrown; the log does not show where it went',
  continued: 'execution continued afterwards',
  unhandled: 'not handled: the transaction failed',
  followed: 'followed straight away by another exception (rethrown or wrapped)',
  leftUnit: 'left the code unit; Salesforce passes it to the caller (for example as a DmlException)'
};

function exceptionStatus(exception) {
  return STATUS_TEXT[exception.status] || exception.status;
}

module.exports = { analyzeLog, soqlShape, sourceFit, inferredLines, closingBraceLines, abortedLines, findings, lineStates, lineCount, verifySource, exceptionStatus, fileKey, splitSignature, ownerClass };
