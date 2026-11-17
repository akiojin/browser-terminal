"use strict";
/* bt-xterm-spike: vanilla xterm.js 6.0.0 wired to bt's server protocol.
 * Mirrors src/ui.html's connection/recovery behaviour, minus TermCore:
 *   WS  ws://<host>/ws?token=<t>&session=new|<id>
 *   srv -> cli : JSON {type:'session'|'cwd'|'error', ...}, then the
 *                scrollback as one binary frame, then live PTY output
 *                as binary frames.
 *   cli -> srv : JSON {type:'input', data} / {type:'resize', rows, cols}
 * Two pieces of gwt's plumbing are reproduced here (see
 * bt-xterm-evaluation.md "gwt との差分"):
 *   - output batching: WS chunks are coalesced per animation frame
 *     (64K/write, catch-up drain over a 256K backlog) before term.write,
 *     so the app never paints a half-arrived repaint frame;
 *   - wheel pacing: while the app reports the mouse, wheel deltas are
 *     forwarded with xterm's own native semantics (fractional-line
 *     accumulation, at most one report per event, no backlog drain) —
 *     a wheel report makes the app repaint its whole viewport, so the
 *     forwarded count must not scale with flick distance. (bt's
 *     full-distance drain contract was tried first and froze the real
 *     machine; see bt-xterm-evaluation.md.)
 * Test hooks live on window.__spike. */
const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const btPort = params.get("btport") || "17399";
const btHost = params.get("bthost") || location.hostname || "127.0.0.1";
const btOrigin = "http://" + btHost + ":" + btPort;
const btWsBase = "ws://" + btHost + ":" + btPort;

const statusEl = document.getElementById("status");
const sessionLabel = document.getElementById("sessionlabel");
const flashEl = document.getElementById("flash");
function setStatus(t) { statusEl.textContent = t; if (window.__spike) window.__spike.state.status = t; }
function flash(t) { flashEl.textContent = t; setTimeout(() => { flashEl.textContent = ""; }, 1500); }

const term = new Terminal({
  cols: 80, rows: 24,
  scrollback: Number(params.get("scrollback") || 10000),
  fontSize: 14, lineHeight: 1.25,
  fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  theme: { background: "#0c0f14", foreground: "#d8dee9", cursor: "#d8dee9" },
  allowProposedApi: true,
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
const serializeAddon = new SerializeAddon.SerializeAddon();
term.loadAddon(serializeAddon);
term.open(document.getElementById("term"));
// Renderer choice: xterm 6's built-in renderer is DOM-based; the WebGL
// addon is the standard high-throughput option. ?renderer=webgl selects it.
let webglAddon = null;
if (params.get("renderer") === "webgl" && window.WebglAddon) {
  try {
    webglAddon = new WebglAddon.WebglAddon();
    webglAddon.onContextLoss(() => { try { webglAddon.dispose(); } catch (e) {} webglAddon = null; });
    term.loadAddon(webglAddon);
  } catch (e) { webglAddon = null; }
}

// --- output batching (gwt-style coalescing) ---------------------------------
// The server sends PTY output as many small WS chunks. Writing each one
// straight to term.write lets xterm paint half-finished app frames —
// Codex repaints its whole viewport per wheel step (~5.5KB split across
// chunks), and the un-coalesced spike visibly smeared rows mid-scroll.
// gwt coalesces instead (terminal-output-buffer.js): queue the bytes,
// flush on rAF with a per-write cap, and when the backlog is large,
// repeat inside a time budget until caught up (catch-up drain, #7553).
// The connect-time scrollback replay takes the same path, so byte order
// is preserved end to end.
const OUT_WRITE_CAP = 64 * 1024;    // bytes per term.write (gwt: 64K chars)
const OUT_CATCHUP_MIN = 256 * 1024; // backlog that arms the catch-up drain
const OUT_BUDGET_MS = 8;            // time budget per flush tick
const utf8 = new TextEncoder();
let outQueue = [];                  // Uint8Array chunks, in receive order
let outQueuedBytes = 0;
let outFlushScheduled = false;
const outStats = { flushes: 0, writes: 0, bytes: 0, maxWrite: 0 };

function queueOutput(chunk) {
  const bytes = typeof chunk === "string" ? utf8.encode(chunk) : chunk;
  if (!bytes.length) return;
  scanForSgrMode(bytes);
  outQueue.push(bytes);
  outQueuedBytes += bytes.length;
  scheduleOutFlush();
}
function scheduleOutFlush() {
  if (outFlushScheduled) return;
  outFlushScheduled = true;
  requestAnimationFrame(flushOutput);
  // rAF never fires in a hidden document; gwt falls back to a 100ms
  // timer / MessageChannel there. A plain timer is enough for the spike.
  setTimeout(() => { if (outFlushScheduled) flushOutput(); }, 100);
}
function writeFromQueue(maxBytes) {
  let total = 0;
  const parts = [];
  while (outQueue.length && total < maxBytes) {
    const head = outQueue[0];
    if (total + head.length <= maxBytes) { parts.push(outQueue.shift()); total += head.length; }
    else {
      const take = maxBytes - total;
      parts.push(head.subarray(0, take));
      outQueue[0] = head.subarray(take);
      total += take;
    }
  }
  if (!parts.length) return 0;
  outQueuedBytes -= total;
  let merged = parts[0];
  if (parts.length > 1) {
    merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { merged.set(p, off); off += p.length; }
  }
  term.write(merged);
  outStats.writes++;
  outStats.bytes += total;
  if (total > outStats.maxWrite) outStats.maxWrite = total;
  return total;
}
let outFlushFailures = 0;
function flushOutput() {
  outFlushScheduled = false;
  if (!outQueue.length) return;
  outStats.flushes++;
  const start = performance.now();
  // Base case: one capped write per tick. Catch-up drain: while the
  // backlog stays at/above the threshold, keep writing inside the
  // budget so a big replay or burst catches up within a few frames.
  try {
    do {
      writeFromQueue(OUT_WRITE_CAP);
      if (outQueuedBytes < OUT_CATCHUP_MIN) break;
    } while (performance.now() - start < OUT_BUDGET_MS);
    outFlushFailures = 0;
  } catch (err) {
    // A throwing term.write must not strand the queue in silence:
    // retry on the next tick, but drop the backlog after repeated
    // failures rather than spin forever on a broken stream.
    outFlushFailures++;
    if (outFlushFailures >= 5) { resetOutputQueue(); outFlushFailures = 0; }
  }
  if (outQueuedBytes > 0) scheduleOutFlush();
}
function resetOutputQueue() {
  // A (re)attach replays the full scrollback after term.reset(); bytes
  // still queued belong to the previous screen and must not land after
  // the reset.
  outQueue = [];
  outQueuedBytes = 0;
}

// --- protocol ---------------------------------------------------------------
let ws = null;
let sessionId = params.get("session") || null;
let reconnectTimer = null;
let sameIdTried = false;
let deadSession = false;
let fallbackCount = 0;
const sentLog = []; // every payload term.onData produced (tests read this)
const wsLog = [];   // every payload actually sent over the WS (tests read this)

function sendInput(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsLog.push(data);
    ws.send(JSON.stringify({ type: "input", data }));
    return true;
  }
  return false;
}
function sendResize(cols, rows) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", rows, cols }));
  }
}
function doFit() {
  try {
    const dims = fitAddon.proposeDimensions();
    if (dims && (dims.cols !== term.cols || dims.rows !== term.rows)) {
      term.resize(dims.cols, dims.rows);
      sendResize(dims.cols, dims.rows);
    }
  } catch (e) { /* container not laid out yet */ }
}
function resetRecovery() { sameIdTried = false; deadSession = false; fallbackCount = 0; }
function planReconnect() {
  if (reconnectTimer) return;
  if (fallbackCount > 3) { setStatus("disconnected (recovery exhausted)"); return; }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (deadSession || sameIdTried) fallbackAttach();
    else { sameIdTried = true; connect(); }
  }, 600);
}
async function fallbackAttach() {
  fallbackCount++;
  let list = null;
  try {
    const res = await fetch(btOrigin + "/sessions?token=" + encodeURIComponent(token));
    if (res.ok) list = await res.json();
  } catch (e) { /* server unreachable */ }
  if (!list) { planReconnect(); return; }
  deadSession = false; sameIdTried = false;
  const mine = sessionId && list.find((s) => s && s.id === sessionId && s.alive);
  if (!mine) {
    const alive = list.filter((s) => s && s.alive);
    sessionId = alive.length ? alive[alive.length - 1].id : null; // null -> fresh
  }
  connect();
}
function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    const old = ws; ws = null;
    old.onopen = old.onclose = old.onerror = old.onmessage = null;
    try { old.close(); } catch (e) {}
  }
  const q = new URLSearchParams({ token });
  q.set("session", sessionId || "new");
  const sock = new WebSocket(btWsBase + "/ws?" + q);
  ws = sock;
  sock.binaryType = "arraybuffer";
  setStatus("connecting…");
  sock.onopen = () => { setStatus("connected"); doFit(); term.focus(); };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    resetOutputQueue(); // the reconnect replays scrollback from scratch
    setStatus("disconnected");
    planReconnect();
  };
  sock.onerror = () => { if (ws === sock) setStatus("error"); };
  sock.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { /* not JSON */ }
      if (msg && msg.type === "session") {
        resetRecovery();
        sessionId = msg.id;
        sessionLabel.textContent = msg.name + " (" + msg.id + ")" + (msg.alive ? "" : " exited");
        setStatus("connected — " + msg.name);
        // Fresh attach: the server replays scrollback right after this
        // message, so reset first to restore the screen exactly. Drop
        // any output still queued from the previous screen, and forget
        // terminal modes the old stream had set.
        resetOutputQueue();
        resetWheelState();
        term.reset();
        return;
      }
      if (msg && msg.type === "error") {
        if (msg.code === "no_such_session") deadSession = true;
        setStatus("error: " + msg.message);
        return;
      }
      if (msg) return; // cwd etc.: not needed for the spike
      queueOutput(ev.data);
    } else {
      queueOutput(new Uint8Array(ev.data));
    }
  };
}
term.onData((data) => { sentLog.push(data); sendInput(data); });
term.onResize(({ cols, rows }) => sendResize(cols, rows));

// --- wheel pacing (xterm-native semantics) ----------------------------------
// A mouse-reporting app repaints its whole viewport per wheel report
// (Codex at 235x60: up to ~27KB), so the forwarded count must NOT scale
// with the pixel distance of a flick. xterm's own conversion
// (CoreMouseService.consumeWheelEvent + a single triggerMouseEvent per
// DOM event) is the model, and it is also what gwt gets for free on the
// Codex path: deltas accumulate as fractional lines, an event emits at
// most ONE report, whole-line excess is dropped, and only the sub-line
// fraction carries over — no backlog can ever form.
//
// The first version of this spike instead imported bt's planWheelSend
// contract (borrow + a 10ms drain until the FULL pixel distance has
// been delivered). That contract is right for bt, whose wheel forwards
// to a local renderer, and wrong here: in the VM live-loop reproduction
// a 540px flick became ~17 reports/event (401 sent + ~464 still queued
// after 51 events, vs exactly 1/event native), the repaint flood
// saturated the main thread, the drain timer slipped from 10ms to
// ~500ms, and the flood sustained itself long after the flick ended —
// the 7th machine's "固まる". There is deliberately no drain timer.
const WHEEL_GESTURE_IDLE_MS = 120; // gap that marks the start of a gesture
let wheelPartial = 0;              // sub-line carry, in line units (signed)
let lastWheelAt = -Infinity;
let lastLineH = 0;                 // last cell height (wheelState hook)
let wheelCol = 1, wheelRow = 1;    // pointer cell of the last wheel event
let sgrMouse = false;              // DECSET 1006, tracked by scanning output
function cellDims() {
  // Cell metrics from xterm's render service (same source the buffer
  // screenshot code below uses); fall back to element size / grid.
  const dims = term._core && term._core._renderService && term._core._renderService.dimensions;
  if (dims && dims.css && dims.css.cell && dims.css.cell.width > 0)
    return { w: dims.css.cell.width, h: dims.css.cell.height };
  const el = term.element;
  if (el && term.cols > 0 && term.rows > 0) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { w: r.width / term.cols, h: r.height / term.rows };
  }
  return null;
}
function sendWheelSteps(steps) {
  const btn = steps > 0 ? 65 : 64; // 64 = wheel up, 65 = wheel down
  let seq = "";
  for (let i = 0, n = Math.abs(steps); i < n; i++) {
    seq += sgrMouse
      ? "\x1b[<" + btn + ";" + wheelCol + ";" + wheelRow + "M"
      // X10 encoding packs coords in single bytes (max 223); clamp,
      // unlike bt, whose fromCharCode wraps past 255.
      : "\x1b[M" + String.fromCharCode(btn + 32, Math.min(wheelCol, 223) + 32, Math.min(wheelRow, 223) + 32);
  }
  if (seq) sendInput(seq);
}

// Track DECSET/DECRST 1006 (SGR mouse encoding) by scanning the output
// stream itself. A parser.registerCsiHandler hook cannot do this: the
// built-in DECSET handler is registered first and consumes the sequence
// before later handlers run (verified empirically — the hook never
// fired). The scanner is a tiny state machine over CSI bytes only; it
// carries its state across chunks, so split sequences are fine.
let csiScan = null; // { priv: bool, params: string } while inside a CSI
function scanForSgrMode(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (!csiScan) {
      if (b === 0x1b) csiScan = { esc: true };
      continue;
    }
    if (csiScan.esc) {
      if (b === 0x5b) { csiScan = { priv: false, params: "" }; } // '['
      else csiScan = null;
      continue;
    }
    if (b >= 0x40 && b <= 0x7e) { // CSI final byte
      if ((b === 0x68 || b === 0x6c) && csiScan.priv) { // 'h' / 'l'
        for (const p of csiScan.params.split(";")) {
          if (p === "1006") sgrMouse = b === 0x68;
        }
      }
      csiScan = null;
    } else if (b === 0x3f && csiScan.params === "") { // '?' prefix
      csiScan.priv = true;
    } else if ((b >= 0x30 && b <= 0x39) || b === 0x3b) { // digits / ';'
      csiScan.params += String.fromCharCode(b);
      if (csiScan.params.length > 32) csiScan = null; // not a mode set
    } else {
      csiScan = null; // intermediates etc.: not a plain DECSET
    }
  }
}
function resetWheelState() {
  wheelPartial = 0;
  lastWheelAt = -Infinity;
  sgrMouse = false;
  csiScan = null;
}
term.attachCustomWheelEventHandler((e) => {
  if (e.shiftKey) return true; // keep xterm's shift+wheel behaviour
  if (term.modes.mouseTrackingMode === "none") return true; // local scroll
  const dims = cellDims();
  if (!dims || !term.element) return true;
  const lineH = dims.h;
  lastLineH = lineH;
  const now = performance.now();
  const gestureStart = now - lastWheelAt > WHEEL_GESTURE_IDLE_MS;
  lastWheelAt = now;
  const rect = term.element.getBoundingClientRect();
  wheelCol = Math.max(1, Math.min(term.cols, Math.floor((e.clientX - rect.left) / dims.w) + 1));
  wheelRow = Math.max(1, Math.min(term.rows, Math.floor((e.clientY - rect.top) / dims.h) + 1));
  const deltaPx = e.deltaMode === 1 ? e.deltaY * lineH
                : e.deltaMode === 2 ? e.deltaY * lineH * term.rows
                : e.deltaY;
  // Native conversion (consumeWheelEvent): pixels -> fractional lines,
  // small pixel deltas damped, fractions accumulate across events.
  let lines = deltaPx / lineH;
  if (e.deltaMode === 0 && Math.abs(e.deltaY) < 50) lines *= 0.3;
  wheelPartial += lines;
  let steps = Math.trunc(wheelPartial);
  if (steps === 0 && gestureStart && Math.abs(deltaPx) >= 2) {
    // Borrow (kept from bt): a fresh gesture's first step goes out at
    // once instead of waiting for a full line to accumulate; the carry
    // goes negative, so the gesture's total stays honest.
    steps = deltaPx > 0 ? 1 : -1;
  }
  if (steps !== 0) {
    const dir = steps > 0 ? 1 : -1;
    sendWheelSteps(dir); // exactly one report per event, like xterm
    wheelPartial -= dir;
  }
  // Drop whole-line excess: only the sub-line fraction carries over.
  wheelPartial %= 1;
  return false; // handled here; xterm must not forward or scroll itself
});
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(doFit, 150);
});
document.getElementById("reconnect").onclick = () => {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  fallbackCount = 0;
  if (deadSession) fallbackAttach();
  else { sameIdTried = false; connect(); }
};

// --- screen text / PNG from the xterm buffer (screenshot alternatives) ------
const PALETTE256 = (() => {
  const p = ["#0c0c0c","#c50f1f","#13a10e","#c19c00","#0037da","#881798","#3a96dd","#cccccc",
             "#767676","#e74856","#16c60c","#f9f1a5","#3b78ff","#b4009e","#61d6d6","#f2f2f2"];
  const levels = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++)
    p.push("rgb(" + levels[r] + "," + levels[g] + "," + levels[b] + ")");
  for (let i = 0; i < 24; i++) { const v = 8 + 10 * i; p.push("rgb(" + v + "," + v + "," + v + ")"); }
  return p;
})();
// xterm color modes: get*ColorMode() returns the raw attribute bitfield,
// not a small enum (src/common/buffer/Constants.ts): mask with 0x3000000 —
// 0x2000000 = palette index, 0x3000000 = RGB (value packed 0xRRGGBB),
// 0 = default. Verified empirically against known cells.
function cellColor(cell, isBg) {
  const mode = (isBg ? cell.getBgColorMode() : cell.getFgColorMode()) & 0x3000000;
  const val = isBg ? cell.getBgColor() : cell.getFgColor();
  if (mode === 0x2000000) return PALETTE256[val] || (isBg ? "#0c0f14" : "#d8dee9");
  if (mode === 0x3000000)
    return "rgb(" + ((val >> 16) & 255) + "," + ((val >> 8) & 255) + "," + (val & 255) + ")";
  return isBg ? "#0c0f14" : "#d8dee9";
}
function visibleTextViaBuffer() {
  const buf = term.buffer.active;
  const lines = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    lines.push(line ? line.translateToString(true).replace(/\s+$/, "") : "");
  }
  return lines.join("\n");
}
function screenToCanvasViaBuffer() {
  const buf = term.buffer.active;
  // Cell metrics from xterm's own render service dimensions.
  const dims = term._core && term._core._renderService && term._core._renderService.dimensions;
  const cellW = dims ? dims.css.cell.width : 8.4;
  const cellH = dims ? dims.css.cell.height : 17.5;
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const wCss = term.cols * cellW, hCss = term.rows * cellH;
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(wCss * scale); cv.height = Math.ceil(hCss * scale);
  const ctx = cv.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = "#0c0f14";
  ctx.fillRect(0, 0, wCss, hCss);
  ctx.textBaseline = "middle";
  const cell = buf.getNullCell();
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    if (!line) continue;
    for (let x = 0; x < term.cols; x++) {
      line.getCell(x, cell);
      const w = cell.getWidth();
      if (w === 0) continue;
      let fg = cellColor(cell, false), bg = cellColor(cell, true);
      if (cell.isInverse()) { const t = fg; fg = bg; bg = t; }
      const x0 = x * cellW, y0 = y * cellH;
      if (bg !== "#0c0f14") { ctx.fillStyle = bg; ctx.fillRect(x0, y0, w * cellW, cellH); }
      const chars = cell.getChars();
      if (chars && chars !== " ") {
        ctx.font = (cell.isItalic() ? "italic " : "") + (cell.isBold() ? "bold " : "") +
          "14px " + term.options.fontFamily;
        ctx.globalAlpha = cell.isDim() ? 0.6 : 1;
        ctx.fillStyle = fg;
        ctx.fillText(chars, x0, y0 + cellH / 2);
        ctx.globalAlpha = 1;
      }
    }
  }
  return cv;
}
document.getElementById("copyscreen").onclick = async () => {
  const text = visibleTextViaBuffer();
  try { await navigator.clipboard.writeText(text); flash("Copied"); }
  catch (e) { flash("Copy failed"); }
  term.focus();
};
document.getElementById("shot").onclick = () => {
  screenToCanvasViaBuffer().toBlob((blob) => {
    if (!blob) { flash("Failed"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "spike-screen.png";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    flash("Saved");
  }, "image/png");
  term.focus();
};

window.__spike = {
  term, fitAddon, serializeAddon,
  get rendererActive() { return webglAddon ? "webgl" : "dom"; },
  state: { status: "init" },
  sentLog,
  wsLog,
  sendInput,
  queueOutput,
  flushOutput,
  outState() {
    return { queuedBytes: outQueuedBytes, chunks: outQueue.length,
             flushes: outStats.flushes, writes: outStats.writes,
             bytes: outStats.bytes, maxWrite: outStats.maxWrite };
  },
  wheelState() {
    return { acc: Math.round(wheelPartial * lastLineH), partial: wheelPartial,
             sgrMouse, col: wheelCol, row: wheelRow,
             drainPending: false, // native pacing has no drain by design
             mouseTrackingMode: term.modes.mouseTrackingMode };
  },
  connect,
  disconnect() { if (ws) { const s = ws; ws = null; s.onclose = null; try { s.close(); } catch (e) {} } },
  get sessionId() { return sessionId; },
  setSession(id) { sessionId = id; },
  visibleTextViaBuffer,
  screenToCanvasViaBuffer,
};
connect();
