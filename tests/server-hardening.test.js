// Tests for src/spawn-helper.js: the node-pty spawn-helper permission
// repair and the boot-time PTY spawn self-check. Uses a fake package
// tree in a temp dir; the real node-pty is only touched read-only
// (repairNodePtySpawnHelpers may chmod this repo's own prebuilds copy,
// which is the behavior under test — it never breaks the tree).
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  findSpawnHelpers,
  repairSpawnHelpers,
  repairNodePtySpawnHelpers,
  probePtySpawn,
} = require("../src/spawn-helper");

let failures = 0;
function eq(actual, expected, name) {
  if (actual === expected) console.log("PASS: " + name);
  else { failures++; console.log("FAIL: " + name + "\n  expected: " + JSON.stringify(expected) + "\n  actual:   " + JSON.stringify(actual)); }
}
function ok(cond, name) { eq(!!cond, true, name); }

// --- Fake node-pty tree -----------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bt-hardening-"));
function makeHelper(rel, mode) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "#!/bin/sh\n");
  fs.chmodSync(p, mode);
  return p;
}
const helperA = makeHelper(path.join("prebuilds", "darwin-arm64", "spawn-helper"), 0o644);
const helperB = makeHelper(path.join("prebuilds", "darwin-x64", "spawn-helper"), 0o755);
const helperC = makeHelper(path.join("prebuilds", "linux-x64", "spawn-helper"), 0o600);
fs.mkdirSync(path.join(tmp, "prebuilds", "win32-x64"), { recursive: true }); // no helper here
fs.writeFileSync(path.join(tmp, "prebuilds", "README.txt"), "not a platform dir");

// 1. findSpawnHelpers finds exactly the existing helper files.
{
  const found = findSpawnHelpers(tmp);
  eq(found.length, 3, "find: three helpers found (win32 dir and stray file ignored)");
  eq(found[0], helperA, "find: sorted, darwin-arm64 first");
  ok(found.includes(helperC), "find: linux-x64 helper found");
  eq(findSpawnHelpers(path.join(tmp, "does-not-exist")).length, 0, "find: missing package dir -> empty");
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "bt-hardening-bare-"));
  eq(findSpawnHelpers(bare).length, 0, "find: no prebuilds dir -> empty");
  fs.rmSync(bare, { recursive: true, force: true });
}

// 2. repairSpawnHelpers adds exec bits only where missing, and logs repairs.
{
  const logs = [];
  const res = repairSpawnHelpers(tmp, (m) => logs.push(m));
  eq(res.checked, 3, "repair: checked counts all helpers");
  eq(res.repaired.length, 2, "repair: two helpers repaired (0644 and 0600)");
  eq(fs.statSync(helperA).mode & 0o777, 0o755, "repair: 0644 -> 0755");
  eq(fs.statSync(helperC).mode & 0o777, 0o711, "repair: 0600 -> 0711 (only exec bits added)");
  eq(fs.statSync(helperB).mode & 0o777, 0o755, "repair: already-executable helper untouched");
  eq(logs.length, 2, "repair: one log line per repair");
  ok(logs[0].includes(helperA) && logs[0].includes("repaired"), "repair: log line names the repaired path");
  // Second run: everything is executable now, so nothing to do or log.
  const logs2 = [];
  const res2 = repairSpawnHelpers(tmp, (m) => logs2.push(m));
  eq(res2.repaired.length, 0, "repair: second run is a no-op");
  eq(logs2.length, 0, "repair: second run logs nothing");
}

// 3. A chmod failure is a logged warning, not a crash and not a repair.
{
  const brokenFs = Object.assign({}, fs, {
    chmodSync() { throw new Error("EPERM: operation not permitted"); },
  });
  fs.chmodSync(helperA, 0o644); // make it need repair again
  const logs = [];
  const res = repairSpawnHelpers(tmp, (m) => logs.push(m), brokenFs);
  eq(res.repaired.length, 0, "repair: failed chmod is not counted as repaired");
  ok(logs.some((m) => m.includes("warning") && m.includes(helperA)), "repair: failed chmod logs a warning");
  fs.chmodSync(helperA, 0o755); // restore
}

// 4. probePtySpawn with injected spawn/platform.
{
  const win = probePtySpawn({ platform: "win32" });
  eq(win.ok, true, "probe: win32 reports ok");
  eq(win.skipped, true, "probe: win32 is skipped (different spawn mechanism)");

  const boom = probePtySpawn({
    platform: "darwin",
    file: "/bin/true",
    spawn() { throw new Error("posix_spawnp failed."); },
  });
  eq(boom.ok, false, "probe: throwing spawn -> not ok");
  ok(boom.error.includes("posix_spawnp failed."), "probe: error message is carried through");

  let drained = 0;
  const good = probePtySpawn({
    platform: "linux",
    file: "/bin/true",
    spawn() { return { onData() { drained++; }, onExit() { drained++; } }; },
  });
  eq(good.ok, true, "probe: working spawn -> ok");
  eq(good.skipped, false, "probe: working spawn is not skipped");
  eq(drained, 2, "probe: output/exit handlers attached to drain the process");

  const noTrue = probePtySpawn({ platform: "linux", fs: { existsSync: () => false } });
  eq(noTrue.skipped, true, "probe: no true binary anywhere -> skipped");
}

// 5. Real environment: the installed node-pty resolves, the repair entry
// point never throws, and a real /bin/true spawn succeeds here.
{
  const res = repairNodePtySpawnHelpers(() => {});
  ok(typeof res.checked === "number" && Array.isArray(res.repaired),
     "real: repairNodePtySpawnHelpers returns a result without throwing");
  if (process.platform !== "win32" && fs.existsSync("/bin/true")) {
    const probe = probePtySpawn();
    eq(probe.ok, true, "real: /bin/true spawns through node-pty");
    eq(probe.skipped, false, "real: probe actually ran");
  }
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL SERVER-HARDENING TESTS PASSED" : "\n" + failures + " SERVER-HARDENING TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
