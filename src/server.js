// browser-terminal: a tiny local web terminal.
// A local HTTP/WebSocket server spawns real shells on PTYs and serves a
// single-page UI so the shell can be operated from a browser tab.
// Binds to 127.0.0.1 only; every endpoint requires a token.
//
// Node.js implementation (the Rust implementation is preserved on the
// `rust-impl` branch). Behavior mirrors the original server: same routes,
// same config format, same audit log format.

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const { parse: parseToml } = require('smol-toml');
const { repairNodePtySpawnHelpers, probePtySpawn } = require('./spawn-helper');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 17337;
const DEFAULT_BIND = '127.0.0.1';
const DEFAULT_SCROLLBACK = 256 * 1024;

function defaultConfigPath() {
  let base;
  if (process.platform === 'win32') {
    base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  }
  return path.join(base, 'browser-terminal', 'config.toml');
}

function configPathFromArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' && i + 1 < args.length) return args[i + 1];
  }
  return null;
}

function generateToken() {
  // Two UUIDs without dashes, as in the original implementation.
  return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
}

function loadOrCreateConfig(cfgPath) {
  if (fs.existsSync(cfgPath)) {
    const text = fs.readFileSync(cfgPath, 'utf8');
    let raw;
    try {
      raw = parseToml(text);
    } catch (e) {
      throw new Error(`invalid TOML: ${e.message}`);
    }
    const cfg = {
      port: raw.port !== undefined ? raw.port : DEFAULT_PORT,
      token: raw.token !== undefined ? String(raw.token) : '',
      bind: raw.bind !== undefined ? String(raw.bind) : DEFAULT_BIND,
      api_enabled: raw.api_enabled === true,
      shell: raw.shell !== undefined ? String(raw.shell) : undefined,
      scrollback_bytes:
        raw.scrollback_bytes !== undefined ? Number(raw.scrollback_bytes) : DEFAULT_SCROLLBACK,
      audit_log: raw.audit_log !== undefined ? String(raw.audit_log) : undefined,
    };
    if (!cfg.token) throw new Error('config has an empty token');
    return { cfg, dir: path.dirname(cfgPath) };
  }

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  const cfg = {
    port: DEFAULT_PORT,
    token: generateToken(),
    bind: DEFAULT_BIND,
    api_enabled: false,
    shell: undefined,
    scrollback_bytes: DEFAULT_SCROLLBACK,
    audit_log: undefined,
  };
  const lines = [
    `port = ${cfg.port}`,
    `token = "${cfg.token}"`,
    `bind = "${cfg.bind}"`,
    `api_enabled = ${cfg.api_enabled}`,
    `scrollback_bytes = ${cfg.scrollback_bytes}`,
    '',
  ];
  fs.writeFileSync(cfgPath, lines.join('\n'), { mode: 0o600 });
  try {
    fs.chmodSync(cfgPath, 0o600);
  } catch (_) {
    /* best effort on non-POSIX platforms */
  }
  console.error(`created config at ${cfgPath}`);
  return { cfg, dir: path.dirname(cfgPath) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Local-time RFC 3339 timestamp, like chrono's Local::now().to_rfc3339().
function nowRfc3339() {
  const d = new Date();
  const pad = (n, w) => String(n).padStart(w === undefined ? 2 : w, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// Strip ANSI escape sequences for the plain-text transcript.
function stripAnsi(input) {
  let out = '';
  const chars = Array.from(input);
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (c === '\x1b') {
      const next = chars[i + 1];
      if (next === '[') {
        // CSI: consume until a final byte in 0x40..=0x7e
        i += 2;
        while (i < chars.length) {
          const code = chars[i].codePointAt(0);
          i++;
          if (code >= 0x40 && code <= 0x7e) break;
        }
        continue;
      }
      if (next === ']') {
        // OSC: consume until BEL or ESC \
        i += 2;
        let prev = '\0';
        while (i < chars.length) {
          const c2 = chars[i];
          i++;
          if (c2 === '\x07' || (prev === '\x1b' && c2 === '\\')) break;
          prev = c2;
        }
        continue;
      }
      if (next === '(' || next === ')') {
        i += 3; // ESC, the paren, and the charset byte
        continue;
      }
      if (next !== undefined) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '\n' || c === '\r' || c === '\t' || !/\p{Cc}/u.test(c)) {
      out += c;
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let CONFIG;
let CONFIG_DIR;
const sessions = new Map();
let sessionCounter = 0;
let auditChain = Promise.resolve();

function audit(sessionName, via, line) {
  const clean = String(line).replace(/[\r\n]/g, ' ');
  const entry = `${nowRfc3339()}\tsession=${sessionName}\tvia=${via}\t${clean}\n`;
  let logPath;
  if (CONFIG.audit_log) {
    logPath = path.isAbsolute(CONFIG.audit_log)
      ? CONFIG.audit_log
      : path.join(CONFIG_DIR, CONFIG.audit_log);
  } else {
    logPath = path.join(CONFIG_DIR, 'audit.log');
  }
  // Serialize appends so concurrent writers cannot interleave lines.
  auditChain = auditChain.then(
    () =>
      new Promise((resolve) => {
        fs.appendFile(logPath, entry, () => resolve());
      })
  );
  return auditChain;
}

// ---------------------------------------------------------------------------
// Shell selection
// ---------------------------------------------------------------------------

function programExists(prog) {
  try {
    execFileSync('where', [prog], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

function shellCommand() {
  if (process.platform === 'win32') {
    const shell =
      CONFIG.shell || (programExists('pwsh') ? 'pwsh' : 'powershell');
    return { file: shell, args: ['-NoLogo'] };
  }
  const shell =
    CONFIG.shell ||
    (process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : null) ||
    (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
  return { file: shell, args: ['-i'] };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function createSession(name) {
  sessionCounter += 1;
  const sessionName = name || `shell-${sessionCounter}`;
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  const { file, args } = shellCommand();

  let proc;
  try {
    proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: Object.assign({}, process.env, { TERM: 'xterm-256color' }),
    });
  } catch (e) {
    throw new Error(`spawn shell failed: ${e.message}`);
  }

  const session = {
    id,
    name: sessionName,
    created_at: nowRfc3339(),
    alive: true,
    proc,
    scrollback: Buffer.alloc(0),
    transcript: [], // [{seq, text}]
    transcriptBytes: 0,
    seq: 0,
    clients: new Set(), // WebSocket senders attached to this session
  };

  const cap = CONFIG.scrollback_bytes;
  proc.onData((data) => {
    const chunk = Buffer.from(data, 'utf8');
    let sb = Buffer.concat([session.scrollback, chunk]);
    if (sb.length > cap) sb = sb.subarray(sb.length - cap);
    session.scrollback = sb;

    const plain = stripAnsi(data);
    if (plain.length > 0) {
      session.seq += 1;
      session.transcript.push({ seq: session.seq, text: plain });
      session.transcriptBytes += Buffer.byteLength(plain, 'utf8');
      // Keep at most ~4x scrollback of plain text.
      while (session.transcriptBytes > cap * 4 && session.transcript.length > 1) {
        const old = session.transcript.shift();
        session.transcriptBytes -= Buffer.byteLength(old.text, 'utf8');
      }
    }

    for (const send of Array.from(session.clients)) {
      try {
        send(chunk);
      } catch (_) {
        session.clients.delete(send);
      }
    }
  });

  proc.onExit(() => {
    session.alive = false;
    const note = Buffer.from('\r\n\x1b[33m[process exited]\x1b[0m\r\n', 'utf8');
    session.scrollback = Buffer.concat([session.scrollback, note]);
    for (const send of Array.from(session.clients)) {
      try {
        send(note);
      } catch (_) {
        /* ignore */
      }
    }
  });

  sessions.set(id, session);
  return session;
}

function sessionInfo(s) {
  return { id: s.id, name: s.name, created_at: s.created_at, alive: s.alive };
}

function listSessions() {
  return Array.from(sessions.values())
    .map(sessionInfo)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authorized(headers, queryToken) {
  const h = headers['authorization'];
  if (typeof h === 'string') {
    if (h === `Bearer ${CONFIG.token}` || h === CONFIG.token) return true;
  }
  if (queryToken !== undefined && queryToken !== null && queryToken === CONFIG.token) {
    return true;
  }
  return false;
}

const TOKEN_FORM = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>browser-terminal</title></head>
<body style="font-family:monospace;background:#111;color:#ddd;padding:2em">
<h1>browser-terminal</h1>
<p>Access token required.</p>
<form method="GET" action="/">
<label>Token: <input type="password" name="token" size="48"></label>
<button type="submit">Open terminal</button>
</form>
</body></html>`;

let UI_HTML = '';

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(body);
}

function sendEmpty(res, code) {
  res.writeHead(code);
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function apiGuard(req, queryToken, bodyToken) {
  if (!CONFIG.api_enabled) return 404;
  if (!authorized(req.headers, queryToken !== undefined ? queryToken : bodyToken)) return 401;
  return 0;
}

async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const queryToken = url.searchParams.has('token') ? url.searchParams.get('token') : undefined;

  // GET / — the UI page (or the token form, with 401, when unauthorized)
  if (req.method === 'GET' && pathname === '/') {
    if (!authorized(req.headers, queryToken)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(TOKEN_FORM);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(UI_HTML);
    return;
  }

  // GET /sessions — list sessions (UI-facing)
  if (req.method === 'GET' && pathname === '/sessions') {
    if (!authorized(req.headers, queryToken)) return sendEmpty(res, 401);
    return sendJson(res, 200, listSessions());
  }

  // DELETE /sessions/:id — kill a session (UI-facing)
  const killMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (req.method === 'DELETE' && killMatch) {
    if (!authorized(req.headers, queryToken)) return sendEmpty(res, 401);
    const id = decodeURIComponent(killMatch[1]);
    const session = sessions.get(id);
    if (!session) return sendEmpty(res, 404);
    sessions.delete(id);
    try {
      session.proc.kill();
    } catch (_) {
      /* already gone */
    }
    session.alive = false;
    return sendJson(res, 200, { ok: true });
  }

  // ---- Agent API (only when api_enabled = true) ----

  if (req.method === 'GET' && pathname === '/api/sessions') {
    const err = apiGuard(req, queryToken, undefined);
    if (err) return sendEmpty(res, err);
    return sendJson(res, 200, listSessions());
  }

  if (req.method === 'POST' && pathname === '/api/sessions') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      return sendEmpty(res, 400);
    }
    const err = apiGuard(req, undefined, body.token);
    if (err) return sendEmpty(res, err);
    try {
      const s = createSession(body.name || undefined);
      return sendJson(res, 200, {
        id: s.id,
        name: s.name,
        created_at: s.created_at,
        alive: true,
      });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (req.method === 'POST' && pathname === '/api/exec') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (_) {
      return sendEmpty(res, 400);
    }
    const err = apiGuard(req, undefined, body.token);
    if (err) return sendEmpty(res, err);
    const session = sessions.get(body.session);
    if (!session) return sendEmpty(res, 404);
    if (!session.alive) return sendJson(res, 410, { error: 'session has exited' });
    audit(session.name, 'api', body.command || '');
    try {
      session.proc.write(String(body.command || '') + '\r');
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
    return sendJson(res, 200, { ok: true, session: session.id, seq: session.seq });
  }

  if (req.method === 'GET' && pathname === '/api/transcript') {
    const err = apiGuard(req, queryToken, undefined);
    if (err) return sendEmpty(res, err);
    const sessionId = url.searchParams.get('session');
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) return sendEmpty(res, 404);
    const sinceRaw = url.searchParams.get('since');
    const since = sinceRaw !== null && sinceRaw !== '' ? Number(sinceRaw) || 0 : 0;
    const text = session.transcript
      .filter((entry) => entry.seq > since)
      .map((entry) => entry.text)
      .join('');
    return sendJson(res, 200, {
      session: session.id,
      name: session.name,
      seq: session.seq,
      alive: session.alive,
      text,
    });
  }

  return sendEmpty(res, 404);
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

// Write input to the PTY and audit-log completed lines.
function feedInput(session, lineState, data) {
  try {
    session.proc.write(data);
  } catch (_) {
    /* session may have exited */
  }
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      if (lineState.buf.length > 0) {
        audit(session.name, 'ws', lineState.buf);
        lineState.buf = '';
      }
    } else if (ch === '\x7f') {
      lineState.buf = Array.from(lineState.buf).slice(0, -1).join('');
    } else if (!/\p{Cc}/u.test(ch)) {
      lineState.buf += ch;
    }
  }
}

function handleWs(ws, req) {
  const url = new URL(req.url, 'http://localhost');
  const sessionParam = url.searchParams.get('session');
  const nameParam = url.searchParams.get('name');

  let session;
  if (sessionParam === null || sessionParam === '' || sessionParam === 'new') {
    try {
      session = createSession(nameParam || undefined);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: e.message }));
      ws.close();
      return;
    }
  } else {
    session = sessions.get(sessionParam);
    if (!session) {
      ws.send(JSON.stringify({ type: 'error', message: 'no such session' }));
      ws.close();
      return;
    }
  }

  ws.send(
    JSON.stringify({
      type: 'session',
      id: session.id,
      name: session.name,
      alive: session.alive,
    })
  );

  // Replay scrollback so a reattached tab restores its screen.
  if (session.scrollback.length > 0) {
    ws.send(session.scrollback, { binary: true });
  }

  const send = (chunk) => {
    if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
  };
  session.clients.add(send);

  const lineState = { buf: '' };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      try {
        session.proc.write(data.toString('utf8'));
      } catch (_) {
        /* ignore */
      }
      return;
    }
    const text = data.toString('utf8');
    if (text.startsWith('{')) {
      let ctrl = null;
      try {
        ctrl = JSON.parse(text);
      } catch (_) {
        ctrl = null;
      }
      if (ctrl && typeof ctrl === 'object' && typeof ctrl.type === 'string') {
        if (ctrl.type === 'input') {
          if (typeof ctrl.data === 'string') feedInput(session, lineState, ctrl.data);
        } else if (ctrl.type === 'resize') {
          const rows = Number(ctrl.rows);
          const cols = Number(ctrl.cols);
          if (Number.isFinite(rows) && Number.isFinite(cols) && rows > 0 && cols > 0) {
            try {
              session.proc.resize(cols, rows);
            } catch (_) {
              /* ignore */
            }
          }
        }
        return;
      }
    }
    // Plain text frame: treat as raw input.
    feedInput(session, lineState, text);
  });

  ws.on('close', () => {
    session.clients.delete(send);
  });
  ws.on('error', () => {
    session.clients.delete(send);
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const cfgPath = configPathFromArgs() || defaultConfigPath();
  let loaded;
  try {
    loaded = loadOrCreateConfig(cfgPath);
  } catch (e) {
    console.error(`failed to load config ${cfgPath}: ${e.message}`);
    process.exit(1);
  }
  CONFIG = loaded.cfg;
  CONFIG_DIR = loaded.dir;

  // node-pty's prebuilt spawn-helper can land without execute bits
  // (npm install artifact); every session spawn then fails with
  // "posix_spawnp failed.". Repair the bits before the first spawn and
  // run a one-shot spawn self-check so a broken install is loud in the
  // startup log instead of silent in the UI. See src/spawn-helper.js.
  repairNodePtySpawnHelpers((line) => console.log(line));
  const probe = probePtySpawn();
  if (!probe.skipped) {
    if (probe.ok) {
      console.log('pty spawn self-check: ok');
    } else {
      console.error(
        `pty spawn self-check FAILED: ${probe.error} — sessions will fail to start; ` +
          'check the spawn-helper permissions under node_modules/node-pty/prebuilds'
      );
    }
  }

  UI_HTML = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8');

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch(() => {
      try {
        sendEmpty(res, 500);
      } catch (_) {
        /* ignore */
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const queryToken = url.searchParams.has('token') ? url.searchParams.get('token') : undefined;
    if (!authorized(req.headers, queryToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleWs(ws, req);
    });
  });

  server.on('error', (e) => {
    console.error(`failed to bind ${CONFIG.bind}:${CONFIG.port}: ${e.message}`);
    process.exit(1);
  });
  server.listen(CONFIG.port, CONFIG.bind, () => {
    console.log(
      `browser-terminal listening on http://${CONFIG.bind}:${CONFIG.port}/?token=${CONFIG.token}`
    );
    console.log(`config: ${cfgPath}`);
    if (CONFIG.api_enabled) console.log('agent API: enabled');
  });
}

main();
