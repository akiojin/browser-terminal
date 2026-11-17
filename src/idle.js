// Idle-timeout decision logic for sessions.
//
// A session is idle when it has seen no activity for the configured
// timeout. "Activity" is user input (WebSocket keystrokes, agent-API
// exec) and PTY output: a session running a long build is not idle, a
// session sitting forgotten at a prompt is.
//
// Config: `idle_timeout_minutes` in config.toml. 0 (the default) or a
// missing/invalid value disables the timeout. Fractional values are
// accepted (useful for tests and short-lived setups).

'use strict';

function idleTimeoutMs(raw) {
  if (raw === undefined || raw === null) return 0;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.round(minutes * 60 * 1000);
}

function isIdle(lastActivityAt, now, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return false;
  if (!Number.isFinite(lastActivityAt)) return false;
  return now - lastActivityAt >= timeoutMs;
}

// How often the sweeper should run for a given timeout: often enough to
// close sessions close to the deadline, never busy-looping.
function sweepIntervalMs(timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return 30000;
  return Math.min(30000, Math.max(1000, Math.floor(timeoutMs / 2)));
}

module.exports = { idleTimeoutMs, isIdle, sweepIntervalMs };
