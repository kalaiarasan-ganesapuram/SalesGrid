// Talks to the Salesforce REST API directly. Starting the Salesforce CLI costs
// about two seconds per call; a direct request takes well under a tenth of
// that. The CLI is used once per org to get the instance address and an
// access token, which are then kept in memory (never written to disk).

const https = require('https');

const TOKEN_TTL_MS = 50 * 60 * 1000;
const SAFE_TARGET = /^[\w.@+-]+$/;

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class SfApi {
  // `runSf(args, options)` runs the CLI and resolves with its JSON result.
  constructor(runSf) {
    this.runSf = runSf;
    this.connections = new Map();
  }

  forget(username) {
    if (username) {
      this.connections.delete(username);
    } else {
      this.connections.clear();
    }
  }

  async connection(username, options = {}) {
    if (!SAFE_TARGET.test(username || '')) {
      throw new Error(`Unsupported org username or alias: ${username}`);
    }
    const cached = this.connections.get(username);
    if (cached && Date.now() - cached.at < TOKEN_TTL_MS) {
      return cached.promise;
    }
    // `org display` can hand back a stale token, so the fresh one comes from
    // show-access-token; both CLI starts run side by side.
    const promise = Promise.all([
      this.runSf(`org display --target-org "${username}"`, options),
      this.runSf(`org auth show-access-token --target-org "${username}"`, options)
    ]).then(([org, token]) => {
      if (!org || !org.instanceUrl || !token || !token.accessToken) {
        throw new Error('The Salesforce CLI did not return a connection for this org.');
      }
      return {
        instanceUrl: org.instanceUrl.replace(/\/$/, ''),
        apiVersion: org.apiVersion || '62.0',
        accessToken: token.accessToken
      };
    });
    const entry = { at: Date.now(), promise };
    this.connections.set(username, entry);
    promise.catch(() => {
      if (this.connections.get(username) === entry) {
        this.connections.delete(username);
      }
    });
    return promise;
  }

  // `path` may start with "/services/" or be relative to the versioned data
  // API, e.g. "query?q=...". `tooling` targets the Tooling API.
  async request(username, method, path, body, options = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const conn = await this.connection(username, options);
      const entry = this.connections.get(username);
      const fullPath = path.startsWith('/services/')
        ? path
        : `/services/data/v${conn.apiVersion}/${options.tooling ? 'tooling/' : ''}${path}`;
      try {
        return await send(conn, method, fullPath, body, options.raw);
      } catch (error) {
        // An expired session: get a fresh token once and try again. Requests
        // running side by side all see the same 401; only the first one
        // drops the cached connection, the others wait for its replacement.
        if (attempt === 0 && error.status === 401) {
          if (this.connections.get(username) === entry) {
            this.forget(username);
          }
          continue;
        }
        throw error;
      }
    }
    throw new Error('Unreachable');
  }

  async query(username, soql, options = {}) {
    let result = await this.request(username, 'GET', `query?q=${encodeURIComponent(soql)}`, undefined, options);
    const records = [...result.records];
    const maxRecords = options.maxRecords || 2000;
    while (!result.done && result.nextRecordsUrl && records.length < maxRecords) {
      result = await this.request(username, 'GET', result.nextRecordsUrl, undefined, options);
      records.push(...result.records);
    }
    return records;
  }

  async apiVersion(username, options = {}) {
    return (await this.connection(username, options)).apiVersion;
  }
}

function send(conn, method, path, body, raw) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const request = https.request(
      new URL(conn.instanceUrl + path),
      {
        method,
        headers: {
          Authorization: `Bearer ${conn.accessToken}`,
          Accept: raw ? '*/*' : 'application/json',
          'Accept-Encoding': 'identity',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
        },
        timeout: 120000
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode >= 200 && response.statusCode < 300) {
            if (raw) {
              resolve(text);
              return;
            }
            try {
              resolve(text ? JSON.parse(text) : null);
            } catch (error) {
              resolve(text);
            }
            return;
          }
          let message = text;
          let code;
          try {
            const parsed = JSON.parse(text);
            const first = Array.isArray(parsed) ? parsed[0] : parsed;
            message = (first && (first.message || first.error_description)) || text;
            code = first && (first.errorCode || first.error);
          } catch (error) {
            // Not JSON: keep the text.
          }
          reject(new ApiError(response.statusCode, String(message).replace(/\s+/g, ' ').trim() || `HTTP ${response.statusCode}`, code));
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error('The request to Salesforce timed out.')));
    request.on('error', reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

module.exports = { SfApi, ApiError };
