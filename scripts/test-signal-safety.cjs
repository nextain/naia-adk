"use strict";
// Preload before every test entrypoint and propagate to Node descendants.
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const preload = `--require=${__filename}`;
const ownFile = value => {
 try { return path.resolve(value) === __filename; } catch { return false; }
};
// Node's internal workers bypass public spawn; tests must share this process.
if (process.execArgv?.includes("--test") && !process.execArgv.includes("--experimental-test-isolation=none")) {
 throw Error("TEST_SAFETY: node --test requires --experimental-test-isolation=none");
}
// Remove only this exact trusted preload after loading. Production CLIs still
// reject arbitrary --require/--import/loader injection.
if (process.execArgv) process.execArgv = process.execArgv.filter((arg, i, all) =>
 !(arg.startsWith("--require=") && ownFile(arg.slice(10))) &&
 !(arg === "--require" && ownFile(all[i + 1])) &&
 !(ownFile(arg) && all[i - 1] === "--require"));
process.env.NODE_OPTIONS = String(process.env.NODE_OPTIONS || "").split(/\s+/).filter(arg => arg !== preload).join(" ");
const normalizeCapture = options => {
 const { timeout, killSignal, ...rest } = options;
 // Native synchronous timeouts and output overflow can send OS signals.
 return { ...rest, maxBuffer: Infinity };
};
const denied = () => { throw Error("TEST_SAFETY: real process signal forbidden"); };
process.kill = denied;
process._kill = denied;
cp.ChildProcess.prototype.kill = denied;
const banned = "run-beh-supervise-wrapper-test.js";
function forbiddenSource(filename) {
 if (ownFile(filename)) return false;
 try {
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 1024 * 1024) return false;
  const text = fs.readFileSync(filename, "utf8");
  return /^ \* BEH supervise WRAPPER — hermetic real-process test/m.test(text) ||
   (/^\s*const WRAPPER\s*=\s*path\.join\(__dirname,/m.test(text) &&
    text.includes('"beh-supervise.js"') && text.includes('"--force-degraded"'));
 } catch { return false; }
}
function validate(command, args = [], options = {}) {
 const words = [String(command), ...args.map(String)];
 if (words.some(word => word.includes(banned) || forbiddenSource(word))) throw Error("TEST_SAFETY: forbidden test");
 if (words.some(word => /(?:^|[\s/;!`|&()])(?:timeout|kill|pkill|killall)(?=[\s;|&()]|$)/.test(word) || /\bos\s*\.\s*kill\s*\(/.test(word))) {
  throw Error("TEST_SAFETY: signal or timeout command forbidden");
 }
 if (words.some(word => /\btimeout\s*=/.test(word))) throw Error("TEST_SAFETY: subprocess timeout forbidden");
 if (options.signal) throw Error("TEST_SAFETY: AbortSignal forbidden");
}
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
 const original = cp[name];
 cp[name] = function (command, ...rest) {
  let args = Array.isArray(rest[0]) ? rest[0] : [];
  const node = command === process.execPath || /^(?:node|node\.exe)$/.test(path.basename(String(command)));
  if (name !== "fork" && node && args.includes("--test") && !args.includes("--experimental-test-isolation=none")) {
   args = ["--experimental-test-isolation=none", ...args];
   rest[0] = args;
  }
  const options = rest.find(value => value && typeof value === "object" && !Array.isArray(value)) || {};
  validate(command, args, options);
  const inherited = String((options.env || process.env).NODE_OPTIONS || "");
  const secured = { ...normalizeCapture(options), env: {
   ...(options.env || process.env),
   NODE_OPTIONS: inherited.split(/\s+/).includes(preload) ? inherited : `${inherited} ${preload}`,
  } };
  const index = rest.indexOf(options);
  if (index >= 0) rest[index] = secured;
  else rest.splice(Array.isArray(rest[0]) ? 1 : 0, 0, secured);
  return original.call(this, command, ...rest);
 };
}
if (process.argv.some(arg => arg.endsWith(banned) || forbiddenSource(arg))) throw Error("TEST_SAFETY: forbidden test");
require("node:module").syncBuiltinESMExports();
module.exports = { validate, normalizeCapture };
