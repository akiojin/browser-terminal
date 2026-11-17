// Tests for the session features added after v0.2:
//   - cwd tracking (src/cwd.js + the UI's formatCwdLabel helper)
//   - idle timeout decisions (src/idle.js)
//   - OS service unit generation (src/service-helper.js)
//   - shell spawn arguments (src/shell.js): POSIX sessions are login +
//     interactive so login-shell startup files are honored
//   - an end-to-end pass against a real server: the session list reports
//     the shell's cwd after `cd`, and an idle session is closed when
//     idle_timeout_minutes is set.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const { parseOsc7Payload, createOsc7Tracker, readProcCwd, parseLsofCwd } = require("../src/cwd");
const { idleTimeoutMs, isIdle, sweepIntervalMs } = require("../src/idle");
const { launchAgentPlist, systemdUnit, servicePlan, LAUNCHD_LABEL } = require("../src/service-helper");
const { shellArgs } = require("../src/shell");

let failures = 0;
function eq(actual, expected, name) {
  if (actual === expected) console.log("PASS: " + name);
  else { failures++; console.log("FAIL: " + name + "\n  expected: " + JSON.stringify(expected) + "\n  actual:   " + JSON.stringify(actual)); }
}
function ok(cond, name) { eq(!!cond, true, name); }

// --- cwd: OSC 7 parsing ------------------------------------------------------
{
  eq(parseOsc7Payload("file:///home/user/proj"), "/home/user/proj", "osc7: plain path");
  eq(parseOsc7Payload("file://localhost/tmp"), "/tmp", "osc7: localhost host accepted");
  eq(parseOsc7Payload("file://otherhost/tmp"), null, "osc7: foreign host rejected");
  eq(parseOsc7Payload("file:///home/user/my%20dir"), "/home/user/my dir", "osc7: percent-decoded");
  eq(parseOsc7Payload("https:///tmp"), null, "osc7: non-file URL rejected");
  eq(parseOsc7Payload(""), null, "osc7: empty rejected");

  const t = createOsc7Tracker();
  eq(t.feed("prompt$ \x1b]7;file:///var/tmp\x07"), "/var/tmp", "osc7 tracker: BEL-terminated");
  eq(t.feed("no sequence here"), null, "osc7 tracker: no sequence -> null");
  const t2 = createOsc7Tracker();
  eq(t2.feed("abc\x1b]7;file:///spl"), null, "osc7 tracker: split sequence waits");
  eq(t2.feed("it/dir\x1b\\"), "/split/dir", "osc7 tracker: ST-terminated split completes");
}

// --- cwd: OS readers ---------------------------------------------------------
{
  if (process.platform === "linux") {
    eq(readProcCwd(process.pid), process.cwd(), "proc: own cwd via /proc");
  }
  eq(readProcCwd(999999, { readlinkSync() { throw new Error("ENOENT"); } }), null,
     "proc: failure -> null");
  eq(parseLsofCwd("p123\nfcwd\nn/Users/someone/proj\n"), "/Users/someone/proj", "lsof: n-line parsed");
  eq(parseLsofCwd("p123\nfcwd\n"), null, "lsof: no n-line -> null");
  eq(parseLsofCwd(""), null, "lsof: empty -> null");
}

// --- idle timeout -------------------------------------------------------------
{
  eq(idleTimeoutMs(undefined), 0, "idle: missing config disables");
  eq(idleTimeoutMs(0), 0, "idle: 0 disables");
  eq(idleTimeoutMs(-5), 0, "idle: negative disables");
  eq(idleTimeoutMs("abc"), 0, "idle: non-numeric disables");
  eq(idleTimeoutMs(30), 30 * 60 * 1000, "idle: 30 minutes in ms");
  eq(idleTimeoutMs(0.05), 3000, "idle: fractional minutes accepted");
  eq(isIdle(1000, 1000 + 2999, 3000), false, "idle: just before deadline stays");
  eq(isIdle(1000, 1000 + 3000, 3000), true, "idle: at deadline closes");
  eq(isIdle(1000, 99999999, 0), false, "idle: disabled never closes");
  eq(sweepIntervalMs(0), 30000, "sweep: disabled -> 30s");
  eq(sweepIntervalMs(3000), 1500, "sweep: half the timeout, clamped");
  eq(sweepIntervalMs(3600000), 30000, "sweep: long timeout -> 30s cap");
}

// --- service helper -------------------------------------------------------------
{
  const plist = launchAgentPlist({
    nodePath: "/opt/homebrew/bin/node",
    serverPath: "/repo/src/server.js",
    workingDir: "/repo",
    logPath: "/home/u/Library/Logs/browser-terminal.log",
  });
  ok(plist.includes(`<string>${LAUNCHD_LABEL}</string>`), "plist: label present");
  ok(plist.includes("<string>/opt/homebrew/bin/node</string>"), "plist: node path present");
  ok(plist.includes("<string>/repo/src/server.js</string>"), "plist: server path present");
  ok(plist.includes("<key>RunAtLoad</key>"), "plist: RunAtLoad present");
  ok(!plist.includes("KeepAlive"), "plist: no KeepAlive (a deliberate stop stays stopped)");

  const unit = systemdUnit({ nodePath: "/usr/bin/node", serverPath: "/repo/src/server.js", workingDir: "/repo" });
  ok(unit.includes("ExecStart=/usr/bin/node /repo/src/server.js"), "unit: ExecStart present");
  ok(unit.includes("WorkingDirectory=/repo"), "unit: WorkingDirectory present");
  ok(unit.includes("WantedBy=default.target"), "unit: user target present");

  const mac = servicePlan("darwin", { homeDir: "/Users/u", nodePath: "/n", serverPath: "/s", workingDir: "/w" });
  eq(mac.supported, true, "plan: darwin supported");
  eq(mac.filePath, "/Users/u/Library/LaunchAgents/com.browser-terminal.plist", "plan: darwin plist path");
  ok(mac.loadCommands.some((c) => c[0] === "launchctl" && c[1] === "load"), "plan: darwin loads via launchctl");

  const lin = servicePlan("linux", { homeDir: "/home/u", nodePath: "/n", serverPath: "/s", workingDir: "/w" });
  eq(lin.filePath, "/home/u/.config/systemd/user/browser-terminal.service", "plan: linux unit path");
  ok(lin.loadCommands.some((c) => c[0] === "systemctl" && c.includes("enable")), "plan: linux enables via systemctl");

  const win = servicePlan("win32", { homeDir: "C:\\Users\\u", nodePath: "n", serverPath: "s", workingDir: "w" });
  eq(win.supported, false, "plan: win32 not automated");
  ok(win.guidance.includes("Task Scheduler"), "plan: win32 guidance mentions Task Scheduler");
}

// --- UI helper: formatCwdLabel --------------------------------------------------
{
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "ui.html"), "utf8");
  const b = html.indexOf("/* === UI-HELPERS-BEGIN === */");
  const e = html.indexOf("/* === UI-HELPERS-END === */");
  if (b < 0 || e < 0) { failures++; console.log("FAIL: UI-HELPERS markers not found"); }
  else {
    const helpers = new Function(html.slice(b, e) + "\nreturn { formatCwdLabel };")();
    eq(helpers.formatCwdLabel("/home/user"), "cwd: /home/user", "ui: cwd label formatted");
    eq(helpers.formatCwdLabel(""), "", "ui: empty cwd -> blank label");
    eq(helpers.formatCwdLabel(null), "", "ui: null cwd -> blank label");
    ok(html.includes('id="cwd"'), "ui: cwd element present in header");
  }
}

// --- shell spawn arguments -----------------------------------------------------
{
  eq(JSON.stringify(shellArgs("darwin")), JSON.stringify(["-l", "-i"]),
     "shellArgs: macOS is login + interactive");
  eq(JSON.stringify(shellArgs("linux")), JSON.stringify(["-l", "-i"]),
     "shellArgs: linux is login + interactive");
  eq(JSON.stringify(shellArgs("win32")), JSON.stringify(["-NoLogo"]),
     "shellArgs: windows keeps -NoLogo only");

  // End-to-end: with the POSIX args, a real bash must read ~/.bash_profile
  // (a login-only startup file). The marker is set nowhere else, so seeing
  // it proves the login startup path ran.
  if (process.platform !== "win32" && fs.existsSync("/bin/bash")) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bt-shell-test-"));
    try {
      fs.writeFileSync(path.join(home, ".bash_profile"),
        "export BT_LOGIN_MARKER=login-file-read\n");
      const res = spawnSync("/bin/bash",
        [...shellArgs(process.platform), "-c", "printf %s \"$BT_LOGIN_MARKER\""],
        { env: Object.assign({}, process.env, { HOME: home }), encoding: "utf8", timeout: 15000 });
      eq(res.stdout, "login-file-read", "shellArgs: login startup file is read by the spawned shell");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
}

// --- Integration: real server ---------------------------------------------------
async function integration() {
  if (process.platform === "win32") { console.log("SKIP: integration (posix only)"); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bt-features-"));
  const port = 17400 + Math.floor(Math.random() * 400);
  const token = "feature-test-token";
  const cfgPath = path.join(tmp, "config.toml");
  fs.writeFileSync(cfgPath, [
    `port = ${port}`,
    `token = "${token}"`,
    `bind = "127.0.0.1"`,
    `api_enabled = true`,
    `idle_timeout_minutes = 0.05`,
    "",
  ].join("\n"));

  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "server.js"), "--config", cfgPath],
    { stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  child.stdout.on("data", (d) => { serverLog += d; });
  child.stderr.on("data", (d) => { serverLog += d; });

  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function listSessions() {
    const res = await fetch(`${base}/api/sessions`, { headers });
    if (!res.ok) throw new Error(`list -> ${res.status}`);
    return res.json();
  }
  try {
    // Wait for the server to accept requests.
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { await listSessions(); up = true; } catch (_) { await sleep(200); }
    }
    ok(up, "integration: server started");
    if (!up) { console.log(serverLog); return; }
    ok(serverLog.includes("session idle timeout"), "integration: idle timeout announced in log");

    const createRes = await fetch(`${base}/api/sessions`, {
      method: "POST", headers, body: JSON.stringify({ name: "integ" }),
    });
    const created = await createRes.json();
    ok(!!created.id, "integration: session created");
    eq(created.cwd, os.homedir(), "integration: session starts in home dir");

    await fetch(`${base}/api/exec`, {
      method: "POST", headers,
      body: JSON.stringify({ session: created.id, command: "cd /" }),
    });
    let cwd = null;
    for (let i = 0; i < 40; i++) {
      const list = await listSessions();
      const entry = list.find((s) => s.id === created.id);
      if (entry) cwd = entry.cwd;
      if (cwd === "/") break;
      await sleep(200);
    }
    eq(cwd, "/", "integration: cwd follows `cd /` in the session list");

    // No further input: the idle timeout (3s) must close the session.
    let gone = false;
    for (let i = 0; i < 100; i++) {
      const list = await listSessions();
      if (!list.find((s) => s.id === created.id)) { gone = true; break; }
      await sleep(200);
    }
    ok(gone, "integration: idle session is closed by the timeout");
    ok(serverLog.includes("closing idle session"), "integration: idle close is logged");
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

integration()
  .catch((e) => { failures++; console.log("FAIL: integration threw: " + e.message); })
  .then(() => {
    console.log(failures === 0 ? "\nALL SESSION-FEATURE TESTS PASSED" : "\n" + failures + " SESSION-FEATURE TEST(S) FAILED");
    process.exit(failures === 0 ? 0 : 1);
  });
