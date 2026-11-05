#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { regularRead } = require("./cost-guard-state.cjs");
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const MAX_RECENT_FILES = 128;
const MAX_SCAN_ENTRIES = 8192;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const hashPrompt = prompt => crypto.createHash("sha256").update(String(prompt).trim()).digest("hex");
const timestamp = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms / 1000 : null; };
const autonomousText = value => /^\s*<(?:task-notification|agent-notification|teammate-message|cross-session-message)(?:\s|>)/i.test(value) || /^\s*<system-reminder>[\s\S]*?\bScheduled task\b[\s\S]*?<\/system-reminder>/i.test(value);
function textContent(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(x => x?.type === "text").map(x => x.text || "").join("\n") : "";
}
function usageValues(usage) {
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0) return null;
  const keys = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  if (keys.some(k => usage[k] !== undefined && (!Number.isSafeInteger(usage[k]) || usage[k] < 0))) return null;
  const context = keys.reduce((a, k) => a + (usage[k] || 0), 0);
  const processing = context + usage.output_tokens;
  return Number.isSafeInteger(processing) ? { context_tokens: context, processing_tokens: processing, output_tokens: usage.output_tokens } : null;
}
function readTranscript(file, { nowSeconds = Date.now() / 1000, maxBytes = MAX_TRANSCRIPT_BYTES } = {}) {
  const read = regularRead(file, maxBytes, { tail: true });
  if (read.status === "missing") return { status: "known", fresh: true, responses: [], provenance: [], current_context_tokens: 0, end_offset: 0, identity: null };
  if (read.status !== "known") return { status: "unknown", reason: read.reason, responses: [], provenance: [] };
  const messages = new Map();
  const provenance = [];
  let compact = null;
  let current = null;
  let malformed = false;
  let earliest = null;
  let offset = read.startOffset;
  for (const line of read.text.split("\n")) {
    const firstOffset = offset; offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { malformed = true; continue; }
    const at = timestamp(row.timestamp);
    if (at !== null) earliest = earliest === null ? at : Math.min(earliest, at);
    if (row.type === "system" && row.subtype === "compact_boundary") { compact = { timestamp: at, offset: firstOffset }; current = null; }
    const attachment = row.attachment || {};
    if (attachment.type === "queued_command" && attachment.origin?.kind === "human" && attachment.humanTurn === true && typeof attachment.prompt === "string") {
      provenance.push({ key: attachment.source_uuid || row.uuid, prompt_hash: hashPrompt(attachment.prompt), timestamp: timestamp(attachment.timestamp) ?? at, offset: firstOffset, kind: "human_queued" });
    }
    if (row.type === "user") {
      const text = textContent(row.message?.content);
      const explicitHuman = row.origin?.kind === "human";
      const nativeUser = !row.origin && typeof row.uuid === "string" && row.uuid && typeof row.message?.content === "string";
      if (text && (explicitHuman || nativeUser) && row.isMeta !== true && row.isSidechain !== true && (explicitHuman || !autonomousText(text)) && !/^\s*<(?:local-command|command-name)/.test(text)) {
        provenance.push({ key: row.uuid, prompt_hash: hashPrompt(text), timestamp: at, offset: firstOffset, kind: explicitHuman ? "human" : "native_user_correlated" });
      }
    }
    if (row.type !== "assistant" || row.message?.model === "<synthetic>" || row.isApiErrorMessage === true || row.error || row.message?.type === "error") continue;
    const message = row.message || {};
    if (typeof message.id !== "string" || !message.id || message.id.length > 256) { if (at === null || at >= nowSeconds - 3600) malformed = true; continue; }
    const values = usageValues(message.usage);
    const previous = messages.get(message.id);
    // Streaming/final rows update cumulative usage, not the provider response's
    // original time. A delayed final row must not move old spend into a window.
    const originalTimestamp = previous?.timestamp ?? at;
    const item = { id: message.id, timestamp: originalTimestamp, last_timestamp: at, first_offset: previous?.first_offset ?? firstOffset, last_offset: firstOffset, ...values, known: Boolean(values && originalTimestamp !== null) };
    messages.set(message.id, item);
    if (!compact || firstOffset > compact.offset && (compact.timestamp === null || originalTimestamp === null || originalTimestamp >= compact.timestamp)) current = item;
  }
  const responses = [...messages.values()];
  const recentUnknown = responses.some(x => !x.known && (x.timestamp === null || x.timestamp >= nowSeconds - 3600));
  const empty = !read.text.trim();
  const fresh = responses.length === 0 && (empty && !read.truncated || Boolean(compact));
  const contextKnown = current ? current.known : fresh || !read.truncated;
  return {
    status: malformed || recentUnknown || !contextKnown ? "unknown" : "known",
    reason: malformed ? "malformed_transcript_tail" : recentUnknown ? "usage_missing_or_invalid" : !contextKnown ? "bounded_tail_no_context" : undefined,
    fresh, responses, provenance, current_context_tokens: current?.known ? current.context_tokens : contextKnown ? 0 : null,
    latest_compact: compact, earliest_timestamp: earliest, truncated: read.truncated, end_offset: read.endOffset, identity: read.identity, mtime: read.mtime,
    window_complete: !read.truncated || earliest !== null && earliest <= nowSeconds - 3600
  };
}
function collectHostUsage(configDir, { nowSeconds = Date.now() / 1000 } = {}) {
  const recent = [];
  let entries = 0;
  let unknown = false;
  const root = path.join(configDir, "projects");
  function scan(directory, depth) {
    let handle;
    try {
      if (!fs.lstatSync(directory).isDirectory()) { unknown = true; return; }
      handle = fs.opendirSync(directory);
      let entry;
      while ((entry = handle.readSync()) !== null) {
        if (++entries > MAX_SCAN_ENTRIES) { unknown = true; break; }
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory() && depth < 3 && (depth < 2 || entry.name === "subagents")) scan(file, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const stat = fs.lstatSync(file);
          if (stat.isFile() && stat.mtimeMs / 1000 >= nowSeconds - 3600) recent.push({ file, mtime: stat.mtimeMs / 1000 });
        }
        if (entries > MAX_SCAN_ENTRIES) break;
      }
    } catch (error) { if (error.code !== "ENOENT") unknown = true; }
    finally { if (handle) handle.closeSync(); }
  }
  scan(root, 0);
  recent.sort((a, b) => b.mtime - a.mtime);
  if (recent.length > MAX_RECENT_FILES) unknown = true;
  const dedup = new Map();
  let bytes = 0;
  for (const { file } of recent.slice(0, MAX_RECENT_FILES)) {
    const allowance = Math.min(MAX_TRANSCRIPT_BYTES, MAX_TOTAL_BYTES - bytes);
    if (allowance <= 0) { unknown = true; break; }
    const result = readTranscript(file, { nowSeconds, maxBytes: allowance });
    bytes += Math.min(fs.lstatSync(file).size, allowance);
    if (result.status !== "known" || !result.window_complete) unknown = true;
    for (const row of result.responses) {
      if (!row.known || row.timestamp > nowSeconds + 30) continue;
      const previous = dedup.get(row.id);
      if (!previous) dedup.set(row.id, row);
      else dedup.set(row.id, { ...(row.processing_tokens >= previous.processing_tokens ? row : previous), timestamp: Math.min(previous.timestamp, row.timestamp) });
    }
  }
  const inWindow = [...dedup].filter(([, row]) => row.timestamp >= nowSeconds - 3600);
  const observed_messages = Object.fromEntries(inWindow.map(([id, row]) => [id, { timestamp: row.timestamp, processing_tokens: row.processing_tokens }]));
  return {
    status: unknown ? "unknown" : "known", reason: unknown ? "bounded_host_usage_incomplete" : "normal",
    responses_hour: inWindow.length,
    processing_tokens_10m: inWindow.map(([, row]) => row).filter(x => x.timestamp >= nowSeconds - 600).reduce((a, x) => a + x.processing_tokens, 0),
    observed_messages, files_read: Math.min(recent.length, MAX_RECENT_FILES), bytes_read: bytes,
    sampled_at: nowSeconds
  };
}
module.exports = { readTranscript, collectHostUsage, hashPrompt, autonomousText, usageValues, MAX_TRANSCRIPT_BYTES };
if (require.main === module) {
  try {
    const args = process.argv.slice(2); let configDir; let nowSeconds = Date.now() / 1000;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--config-dir") configDir = args[++i];
      else if (args[i] === "--now") nowSeconds = Number(args[++i]);
      else throw new Error("unknown_option");
    }
    if (!configDir || !path.isAbsolute(configDir) || !Number.isFinite(nowSeconds) || nowSeconds <= 0) throw new Error("invalid_arguments");
    process.stdout.write(JSON.stringify(collectHostUsage(fs.realpathSync(configDir), { nowSeconds })) + "\n");
  } catch { process.stdout.write(JSON.stringify({ status: "unknown", reason: "usage_scan_failed" }) + "\n"); process.exitCode = 1; }
}
