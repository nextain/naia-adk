"use strict";
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "../../..");
// Instance policy is a fixed on-disk value. Environment variables never select it.
function lockFile() {
 const cfg = path.join(ROOT, "config/deploy-gate.json");
 try {
  const value = JSON.parse(fs.readFileSync(cfg, "utf8")).stopAllLockFile;
  if (value === undefined) return "/var/lib/ax-shared/stop-all.lock";
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) throw Error("invalid stop-all lock policy");
  return value;
 } catch (e) { if(e.code === "ENOENT") return "/var/lib/ax-shared/stop-all.lock"; throw e; }
}
function stopAllLocked() {
 try { fs.lstatSync(lockFile()); return true; }
 catch(e) { return e.code !== "ENOENT"; }
}
module.exports = { lockFile, stopAllLocked };
