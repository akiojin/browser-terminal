// Current-working-directory tracking for sessions.
//
// Three sources, in order of freshness:
//   1. OSC 7 sequences emitted by the shell (ESC ] 7 ; file://host/path).
//      Instant, works on every platform, but only shells/prompts with OSC 7
//      integration send it.
//   2. Linux: readlink /proc/<pid>/cwd — cheap and synchronous.
//   3. macOS: `lsof -a -p <pid> -d cwd -Fn` — accurate but slow, so the
//      server refreshes it at most every couple of seconds, off the
//      request path.
// Windows has no equivalent here; the cwd stays at the spawn directory
// unless the shell reports OSC 7.

'use strict';

const fs = require('fs');

// Parse one OSC 7 payload ("file://host/path", already stripped of the
// ESC ] 7 ; prefix and the BEL / ST terminator). Returns the decoded path,
// or null for anything that is not a local file URL.
function parseOsc7Payload(payload) {
  if (typeof payload !== 'string' || !payload.startsWith('file://')) return null;
  const rest = payload.slice('file://'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const host = rest.slice(0, slash);
  if (host !== '' && host !== 'localhost') return null;
  let p = rest.slice(slash);
  try {
    p = decodeURIComponent(p);
  } catch (_) {
    return null;
  }
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return p || null;
}

// Stateful OSC 7 tracker: feed it raw PTY output chunks (strings); it
// returns the new cwd whenever a complete OSC 7 sequence arrives, and
// buffers a sequence that is split across chunks.
function createOsc7Tracker() {
  let buf = '';
  return {
    feed(text) {
      buf += text;
      let found = null;
      for (;;) {
        const start = buf.indexOf('\x1b]7;');
        if (start < 0) {
          // Keep a tail that could be the start of a split escape.
          buf = buf.endsWith('\x1b]') ? '\x1b]' : buf.endsWith('\x1b') ? '\x1b' : '';
          break;
        }
        const rest = buf.slice(start + 4);
        const bel = rest.indexOf('\x07');
        const st = rest.indexOf('\x1b\\');
        let end = -1;
        let termLen = 0;
        if (bel >= 0 && (st < 0 || bel < st)) { end = bel; termLen = 1; }
        else if (st >= 0) { end = st; termLen = 2; }
        if (end < 0) {
          // Incomplete sequence: wait for more data, but do not let a
          // runaway buffer grow without bound.
          buf = buf.slice(start);
          if (buf.length > 8192) buf = '';
          break;
        }
        const cwd = parseOsc7Payload(rest.slice(0, end));
        if (cwd) found = cwd;
        buf = rest.slice(end + termLen);
      }
      return found;
    },
  };
}

// Linux: the shell process's cwd via /proc. Returns null when unavailable.
function readProcCwd(pid, fsImpl) {
  const f = fsImpl || fs;
  try {
    return f.readlinkSync(`/proc/${pid}/cwd`);
  } catch (_) {
    return null;
  }
}

// macOS: parse the cwd line out of `lsof -a -p <pid> -d cwd -Fn` output
// (the path is on the line starting with "n").
function parseLsofCwd(output) {
  if (typeof output !== 'string') return null;
  for (const line of output.split('\n')) {
    if (line.startsWith('n') && line.length > 1) return line.slice(1);
  }
  return null;
}

module.exports = { parseOsc7Payload, createOsc7Tracker, readProcCwd, parseLsofCwd };
