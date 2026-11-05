"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_STATE_BYTES = 65536;
function regularRead(file, maxBytes, { tail = false } = {}) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile()) return { status: "unknown", reason: "not_regular" };
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) return { status: "unknown", reason: "identity_changed" };
    if (!tail && stat.size > maxBytes) return { status: "unknown", reason: "file_too_large" };
    const length = Math.min(stat.size, maxBytes);
    const offset = tail ? stat.size - length : 0;
    const bytes = Buffer.alloc(length);
    let count = 0;
    while (count < length) {
      const read = fs.readSync(fd, bytes, count, length - count, offset + count);
      if (!read) break;
      count += read;
    }
    let text = bytes.toString("utf8", 0, count);
    let startOffset = offset;
    if (offset > 0) {
      const newline = bytes.indexOf(10);
      if (newline < 0) { text = ""; startOffset = offset + count; }
      else { text = bytes.toString("utf8", newline + 1, count); startOffset += newline + 1; }
    }
    return { status: "known", text, startOffset, endOffset: offset + count, truncated: offset > 0, identity: `${stat.dev}:${stat.ino}`, mtime: stat.mtimeMs / 1000 };
  } catch (error) {
    return { status: error.code === "ENOENT" ? "missing" : "unknown", reason: error.code || "read_failed" };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readJson(file, maxBytes = MAX_STATE_BYTES) {
  const read = regularRead(file, maxBytes);
  if (read.status !== "known") return read;
  try {
    const data = JSON.parse(read.text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { status: "unknown", reason: "invalid_object" };
    return { status: "known", data };
  } catch { return { status: "unknown", reason: "malformed_json" }; }
}
function sessionPath(directory, sessionId) {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256) return null;
  return path.join(directory, crypto.createHash("sha256").update(sessionId).digest("hex") + ".json");
}
function atomicJson(file, data, maxBytes = MAX_STATE_BYTES) {
  let temporary;
  try {
    const directory = path.dirname(file);
    if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== path.resolve(directory)) return false;
    const payload = JSON.stringify(data);
    if (Buffer.byteLength(payload) > maxBytes) return false;
    temporary = file + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
    fs.writeFileSync(temporary, payload, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file); temporary = undefined;
    return true;
  } catch { return false; }
  finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
}
function withSession(directory, sessionId, update) {
  const file = sessionPath(directory, sessionId);
  if (!file) return { status: "unknown", reason: "invalid_session_id" };
  const lock = file + ".lock";
  let locked = false;
  let temporary;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== path.resolve(directory)) return { status: "unknown", reason: "unsafe_state_directory" };
    fs.mkdirSync(lock, { mode: 0o700 }); locked = true;
    const previous = readJson(file);
    if (previous.status !== "known" && previous.status !== "missing") return { status: "unknown", reason: "state_" + previous.reason };
    const state = previous.status === "missing" ? { schema_version: 1, turn: null, held: null } : previous.data;
    if (state.schema_version !== 1 || !Object.hasOwn(state, "turn") || !Object.hasOwn(state, "held")) return { status: "unknown", reason: "invalid_state_schema" };
    const value = update(state);
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) return { status: "unknown", reason: "state_limit" };
    temporary = file + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
    fs.writeFileSync(temporary, serialized, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file); temporary = undefined;
    return { status: "known", value, state };
  } catch (error) { return { status: "unknown", reason: error.code === "EEXIST" ? "state_busy" : "state_write_failed" }; }
  finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
    if (locked) { try { fs.rmdirSync(lock); } catch {} }
  }
}
module.exports = { regularRead, readJson, sessionPath, withSession, atomicJson, MAX_STATE_BYTES };
