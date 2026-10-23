// Debug logs, trace flags, debug levels, Lightning debug mode and anonymous
// Apex, all through the direct API client.

const RECORD_ID = /^[a-zA-Z0-9]{15,18}$/;
const SAFE_USERNAME = /^[\w.@+-]+$/;
const LEVELS = ['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST'];
const CATEGORIES = ['ApexCode', 'ApexProfiling', 'Callout', 'Database', 'System', 'Validation', 'Visualforce', 'Workflow', 'Nba', 'Wave'];

// Ready-made debug levels. Each one is created in the org the first time it is
// used, under the name "SalesGrid_<key>".
const PRESETS = {
  // Apex Code at FINER is the least that records every statement and method
  // call, so debug output and every line that ran show up; queries and DML
  // come from Database at INFO. Everything else stays small.
  Standard: { label: 'Standard', about: 'Every line that ran, debug output, queries and DML (Apex Code FINER)', levels: { ApexCode: 'FINER', ApexProfiling: 'INFO', Callout: 'INFO', Database: 'INFO', System: 'DEBUG', Validation: 'INFO', Visualforce: 'INFO', Workflow: 'INFO', Nba: 'INFO', Wave: 'INFO' } },
  ApexDetail: { label: 'Apex detail', about: 'Every method call and query, for performance work', levels: { ApexCode: 'FINEST', ApexProfiling: 'FINE', Callout: 'INFO', Database: 'FINEST', System: 'DEBUG', Validation: 'INFO', Visualforce: 'INFO', Workflow: 'INFO', Nba: 'INFO', Wave: 'INFO' } },
  Everything: { label: 'Everything', about: 'Finest detail in every category; logs get large', levels: Object.fromEntries(CATEGORIES.map((c) => [c, 'FINEST'])) },
  ErrorsOnly: { label: 'Errors only', about: 'Smallest logs: only errors', levels: { ApexCode: 'ERROR', ApexProfiling: 'NONE', Callout: 'ERROR', Database: 'NONE', System: 'ERROR', Validation: 'ERROR', Visualforce: 'ERROR', Workflow: 'ERROR', Nba: 'NONE', Wave: 'NONE' } }
};

// The debug level behind source highlighting. A DeveloperName cannot hold a
// space, so it is "Sales_Grid" with the label "Sales Grid". Apex Code at FINER
// records every statement; FINEST adds variable values. The other categories
// stay at the lowest level that still gives queries, DML, limits and errors,
// which keeps logs small.
const SALES_GRID_LEVEL = { developerName: 'Sales_Grid', label: 'Sales Grid' };

function salesGridLevels(detail) {
  return {
    ApexCode: detail === 'FINEST' ? 'FINEST' : 'FINER',
    ApexProfiling: 'INFO',
    Callout: 'INFO',
    Database: 'INFO',
    System: 'DEBUG',
    Validation: 'INFO',
    Visualforce: 'INFO',
    Workflow: 'INFO',
    Nba: 'INFO',
    Wave: 'INFO'
  };
}

// Turns Salesforce's permission errors into something a developer can act on.
function explain(error, what) {
  const text = `${error.code || ''} ${error.message || ''}`;
  if (/INSUFFICIENT_ACCESS|insufficient access|not allowed|INVALID_TYPE|sObject type .* is not supported/i.test(text)) {
    const friendly = new Error(`Salesforce refused to ${what}. Your user needs the "View Setup and Configuration" and "Author Apex" permissions (and "Manage Users" to log someone else).`);
    friendly.cause = error;
    return friendly;
  }
  return error;
}

function assertId(id) {
  if (!RECORD_ID.test(id || '')) {
    throw new Error(`Unsupported record id: ${id}`);
  }
}

class Debugger {
  constructor(api) {
    this.api = api;
    this.userIds = new Map();
  }

  async userId(username) {
    if (!SAFE_USERNAME.test(username || '')) {
      throw new Error(`Unsupported username: ${username}`);
    }
    if (!this.userIds.has(username)) {
      const [user] = await this.api.query(username, `SELECT Id FROM User WHERE Username = '${username.replace(/'/g, "\\'")}'`);
      if (!user) {
        throw new Error('Your user could not be found in the org.');
      }
      this.userIds.set(username, user.Id);
    }
    return this.userIds.get(username);
  }

  async listLogs(username, limit = 100) {
    const records = await this.api.query(
      username,
      'SELECT Id, LogUserId, LogUser.Name, Operation, Request, Status, LogLength, DurationMilliseconds, StartTime, Application, Location ' +
        `FROM ApexLog ORDER BY StartTime DESC LIMIT ${Math.min(Math.max(1, limit), 500)}`
    );
    return records.map((r) => ({
      id: r.Id,
      userId: r.LogUserId,
      user: (r.LogUser && r.LogUser.Name) || '',
      operation: r.Operation || '',
      request: r.Request || '',
      status: r.Status || '',
      bytes: r.LogLength || 0,
      durationMs: r.DurationMilliseconds || 0,
      start: r.StartTime,
      application: r.Application || '',
      location: r.Location || ''
    }));
  }

  async logBody(username, id) {
    assertId(id);
    return this.api.request(username, 'GET', `sobjects/ApexLog/${id}/Body`, undefined, { raw: true });
  }

  // Deletes logs 200 at a time; returns how many went.
  async deleteLogs(username, ids) {
    let deleted = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      batch.forEach(assertId);
      const results = await this.api.request(username, 'DELETE', `composite/sobjects?ids=${batch.join(',')}&allOrNone=false`);
      deleted += (results || []).filter((r) => r.success).length;
    }
    return deleted;
  }

  async allLogIds(username) {
    const records = await this.api.query(username, 'SELECT Id FROM ApexLog ORDER BY StartTime DESC LIMIT 2000', { maxRecords: 2000 });
    return records.map((r) => r.Id);
  }

  async traceFlags(username) {
    const now = Date.now();
    const records = await this.api.query(
      username,
      'SELECT Id, TracedEntityId, TracedEntity.Name, LogType, StartDate, ExpirationDate, DebugLevelId, DebugLevel.DeveloperName, CreatedById, CreatedDate ' +
        'FROM TraceFlag ORDER BY ExpirationDate DESC LIMIT 200',
      { tooling: true }
    );
    return records.map((r) => ({
      id: r.Id,
      entityId: r.TracedEntityId,
      entity: (r.TracedEntity && r.TracedEntity.Name) || r.TracedEntityId,
      logType: r.LogType,
      start: r.StartDate,
      expires: r.ExpirationDate,
      level: (r.DebugLevel && r.DebugLevel.DeveloperName) || '',
      levelId: r.DebugLevelId,
      createdById: r.CreatedById,
      created: r.CreatedDate,
      active: new Date(r.ExpirationDate).getTime() > now && (!r.StartDate || new Date(r.StartDate).getTime() <= now)
    }));
  }

  async debugLevels(username) {
    const records = await this.api.query(username, `SELECT Id, DeveloperName, ${CATEGORIES.join(', ')} FROM DebugLevel ORDER BY DeveloperName`, { tooling: true });
    return records.map((r) => ({ id: r.Id, name: r.DeveloperName, levels: Object.fromEntries(CATEGORIES.map((c) => [c, r[c] || 'NONE'])) }));
  }

  async saveDebugLevel(username, id, levels) {
    assertId(id);
    const update = {};
    for (const category of CATEGORIES) {
      if (levels[category] !== undefined) {
        if (!LEVELS.includes(levels[category])) {
          throw new Error(`Unsupported log level: ${levels[category]}`);
        }
        update[category] = levels[category];
      }
    }
    await this.api.request(username, 'PATCH', `sobjects/DebugLevel/${id}`, update, { tooling: true });
  }

  async presetLevelId(username, presetKey) {
    const preset = PRESETS[presetKey];
    if (!preset) {
      throw new Error(`Unknown debug level preset: ${presetKey}`);
    }
    const name = `SalesGrid_${presetKey}`;
    const [existing] = await this.api.query(username, `SELECT Id FROM DebugLevel WHERE DeveloperName = '${name}'`, { tooling: true });
    if (existing) {
      await this.api.request(username, 'PATCH', `sobjects/DebugLevel/${existing.Id}`, preset.levels, { tooling: true });
      return existing.Id;
    }
    const created = await this.api.request(username, 'POST', 'sobjects/DebugLevel', { DeveloperName: name, MasterLabel: `Sales Grid ${preset.label}`, ...preset.levels }, { tooling: true });
    return created.id;
  }

  // Active users whose name or username contains `text`, for choosing whom to log.
  async searchUsers(username, text) {
    const term = String(text || '').trim().slice(0, 80);
    if (term.length < 2) {
      return [];
    }
    // Escaped for a SOQL string and for LIKE wildcards.
    const safe = term.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/%/g, '\\%').replace(/_/g, '\\_');
    const records = await this.api.query(
      username,
      'SELECT Id, Name, Username, Profile.Name, UserType FROM User ' +
        `WHERE IsActive = true AND (Name LIKE '%${safe}%' OR Username LIKE '%${safe}%') ORDER BY Name LIMIT 25`
    );
    return records.map((r) => ({ id: r.Id, name: r.Name, username: r.Username, profile: (r.Profile && r.Profile.Name) || r.UserType || '' }));
  }

  // Starts, or extends, debug logging for a user: the signed-in user when
  // `targetUserId` is not given. Your own logging uses the Developer Console's
  // type (DEVELOPER_LOG); anyone else's uses Setup's (USER_DEBUG). Salesforce
  // does not allow two overlapping flags of one type for one user, so an
  // existing flag is updated rather than a second one created.
  // `debugLevelId` picks an existing debug level by id; otherwise the preset's
  // SalesGrid_<key> level is used (and created or brought up to date).
  async startLogging(username, minutes, presetKey, targetUserId, debugLevelId) {
    const span = Math.min(Math.max(1, minutes), 24 * 60);
    if (debugLevelId) {
      assertId(debugLevelId);
    }
    const [me, levelId] = await Promise.all([this.userId(username), debugLevelId || this.presetLevelId(username, presetKey)]);
    const userId = targetUserId || me;
    assertId(userId);
    const logType = userId === me ? 'DEVELOPER_LOG' : 'USER_DEBUG';
    const now = new Date();
    const expires = new Date(now.getTime() + span * 60 * 1000).toISOString();
    const [existing] = await this.api.query(
      username,
      `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = '${logType}' ORDER BY ExpirationDate DESC LIMIT 1`,
      { tooling: true }
    );
    if (existing) {
      await this.api.request(username, 'PATCH', `sobjects/TraceFlag/${existing.Id}`, { StartDate: now.toISOString(), ExpirationDate: expires, DebugLevelId: levelId }, { tooling: true });
      return existing.Id;
    }
    const created = await this.api.request(
      username,
      'POST',
      'sobjects/TraceFlag',
      { TracedEntityId: userId, LogType: logType, DebugLevelId: levelId, StartDate: now.toISOString(), ExpirationDate: expires },
      { tooling: true }
    );
    return created.id;
  }

  // The org's "Sales Grid" debug level, or undefined when there is none yet.
  async salesGridLevel(username) {
    const records = await this.api.query(
      username,
      `SELECT Id, DeveloperName, MasterLabel, ${CATEGORIES.join(', ')} FROM DebugLevel ` +
        `WHERE DeveloperName = '${SALES_GRID_LEVEL.developerName}' OR MasterLabel = '${SALES_GRID_LEVEL.label}' ORDER BY CreatedDate LIMIT 5`,
      { tooling: true }
    );
    const record = records.find((r) => r.DeveloperName === SALES_GRID_LEVEL.developerName) || records[0];
    return record && { id: record.Id, name: record.DeveloperName, levels: Object.fromEntries(CATEGORIES.map((c) => [c, record[c] || 'NONE'])) };
  }

  // Finds or creates the "Sales Grid" debug level. When it exists with other
  // settings, `confirmChange({ existing, wanted, differences })` decides:
  // 'update' changes it, 'keep' uses it as it is, anything else cancels.
  async ensureSalesGridLevel(username, detail, confirmChange) {
    const wanted = salesGridLevels(detail);
    let existing;
    try {
      existing = await this.salesGridLevel(username);
    } catch (error) {
      throw explain(error, 'read debug levels');
    }
    if (!existing) {
      try {
        const created = await this.api.request(
          username,
          'POST',
          'sobjects/DebugLevel',
          { DeveloperName: SALES_GRID_LEVEL.developerName, MasterLabel: SALES_GRID_LEVEL.label, ...wanted },
          { tooling: true }
        );
        return { id: created.id, levels: wanted, created: true };
      } catch (error) {
        throw explain(error, 'create the Sales Grid debug level');
      }
    }
    const differences = CATEGORIES.filter((c) => (existing.levels[c] || 'NONE') !== wanted[c]);
    if (!differences.length) {
      return { id: existing.id, levels: existing.levels };
    }
    const answer = confirmChange ? await confirmChange({ existing: existing.levels, wanted, differences }) : 'keep';
    if (answer === 'update') {
      await this.api.request(username, 'PATCH', `sobjects/DebugLevel/${existing.id}`, wanted, { tooling: true });
      return { id: existing.id, levels: wanted, updated: true };
    }
    if (answer === 'keep') {
      return { id: existing.id, levels: existing.levels };
    }
    const cancelled = new Error('Cancelled.');
    cancelled.cancelled = true;
    throw cancelled;
  }

  // Starts debugging with the Sales Grid level for a user (the signed-in user
  // when `targetUserId` is not given). Salesforce allows one trace flag per
  // user and log type at a time, so an existing flag is reused and pointed at
  // the Sales Grid level instead of a clashing second one being created. The
  // result says which level the reused flag used before.
  async enableSalesGridDebugging(username, { targetUserId, minutes, detail, confirmChange }) {
    const span = Math.min(Math.max(5, minutes || 60), 24 * 60);
    const level = await this.ensureSalesGridLevel(username, detail, confirmChange);
    const me = await this.userId(username);
    const userId = targetUserId || me;
    assertId(userId);
    const logType = userId === me ? 'DEVELOPER_LOG' : 'USER_DEBUG';
    const now = new Date();
    const expires = new Date(now.getTime() + span * 60 * 1000).toISOString();
    try {
      const flags = await this.api.query(
        username,
        `SELECT Id, LogType, ExpirationDate, DebugLevel.DeveloperName FROM TraceFlag WHERE TracedEntityId = '${userId}' ORDER BY ExpirationDate DESC LIMIT 20`,
        { tooling: true }
      );
      const sameType = flags.find((flag) => flag.LogType === logType);
      // A flag of the other type on the same user is left alone, but reported.
      const other = flags.find((flag) => flag.LogType !== logType && new Date(flag.ExpirationDate).getTime() > now.getTime());
      const notes = [];
      if (other) {
        notes.push(`${other.LogType.replace('_', ' ').toLowerCase()} trace flag with level ${(other.DebugLevel && other.DebugLevel.DeveloperName) || 'unknown'} is also active for this user.`);
      }
      let id;
      if (sameType) {
        const previous = sameType.DebugLevel && sameType.DebugLevel.DeveloperName;
        await this.api.request(username, 'PATCH', `sobjects/TraceFlag/${sameType.Id}`, { StartDate: now.toISOString(), ExpirationDate: expires, DebugLevelId: level.id }, { tooling: true });
        if (previous && previous !== SALES_GRID_LEVEL.developerName && new Date(sameType.ExpirationDate).getTime() > now.getTime()) {
          notes.push(`The trace flag already running with level ${previous} now uses Sales Grid.`);
        }
        id = sameType.Id;
      } else {
        const created = await this.api.request(
          username,
          'POST',
          'sobjects/TraceFlag',
          { TracedEntityId: userId, LogType: logType, DebugLevelId: level.id, StartDate: now.toISOString(), ExpirationDate: expires },
          { tooling: true }
        );
        id = created.id;
      }
      return { id, expires, level, notes };
    } catch (error) {
      throw explain(error, 'start debug logging');
    }
  }

  // Stops every active trace flag that uses the Sales Grid level for a user
  // (the signed-in user when `targetUserId` is not given). Flags with other
  // levels are not touched. Returns how many were stopped.
  async disableSalesGridDebugging(username, targetUserId) {
    const userId = targetUserId || (await this.userId(username));
    assertId(userId);
    const flags = await this.api.query(
      username,
      `SELECT Id, ExpirationDate FROM TraceFlag WHERE TracedEntityId = '${userId}' AND DebugLevel.DeveloperName = '${SALES_GRID_LEVEL.developerName}'`,
      { tooling: true }
    );
    const active = flags.filter((flag) => new Date(flag.ExpirationDate).getTime() > Date.now());
    for (const flag of active) {
      await this.deleteFlag(username, flag.Id);
    }
    return active.length;
  }

  // Every trace flag that is recording right now, whoever started it and with
  // whatever level, for the sidebar. `salesGrid` marks those on our level.
  async activeDebugging(username) {
    const [me, flags] = await Promise.all([this.userId(username), this.traceFlags(username)]);
    return {
      me,
      flags: flags
        .filter((flag) => flag.active)
        .map((flag) => ({ ...flag, mine: flag.entityId === me, salesGrid: flag.level === SALES_GRID_LEVEL.developerName }))
    };
  }

  async extendFlag(username, id, minutes) {
    assertId(id);
    const [flag] = await this.api.query(username, `SELECT ExpirationDate FROM TraceFlag WHERE Id = '${id}'`, { tooling: true });
    if (!flag) {
      throw new Error('That trace flag no longer exists.');
    }
    const base = Math.max(Date.now(), new Date(flag.ExpirationDate).getTime());
    const limit = Date.now() + 24 * 60 * 60 * 1000;
    const expires = new Date(Math.min(base + minutes * 60 * 1000, limit)).toISOString();
    await this.api.request(username, 'PATCH', `sobjects/TraceFlag/${id}`, { ExpirationDate: expires }, { tooling: true });
  }

  async deleteFlag(username, id) {
    assertId(id);
    await this.api.request(username, 'DELETE', `sobjects/TraceFlag/${id}`, undefined, { tooling: true });
  }

  async debugMode(username) {
    const id = await this.userId(username);
    const [user] = await this.api.query(username, `SELECT UserPreferencesUserDebugModePref FROM User WHERE Id = '${id}'`);
    return !!(user && user.UserPreferencesUserDebugModePref);
  }

  // Sets Lightning debug mode for a user: the signed-in user when `userId` is
  // not given. Changing someone else's needs the Manage Users permission.
  async setDebugMode(username, on, userId) {
    const id = userId || (await this.userId(username));
    assertId(id);
    await this.api.request(username, 'PATCH', `sobjects/User/${id}`, { UserPreferencesUserDebugModePref: !!on });
  }

  // Active users who currently have Lightning debug mode on.
  async debugModeUsers(username) {
    const records = await this.api.query(
      username,
      'SELECT Id, Name, Username, Profile.Name FROM User WHERE IsActive = true AND UserPreferencesUserDebugModePref = true ORDER BY Name LIMIT 200'
    );
    return records.map((r) => ({ id: r.Id, name: r.Name, username: r.Username, profile: (r.Profile && r.Profile.Name) || '' }));
  }

  async executeAnonymous(username, code) {
    return this.api.request(username, 'GET', `executeAnonymous/?anonymousBody=${encodeURIComponent(code)}`, undefined, { tooling: true });
  }
}

module.exports = { Debugger, PRESETS, LEVELS, CATEGORIES, SALES_GRID_LEVEL, salesGridLevels };
