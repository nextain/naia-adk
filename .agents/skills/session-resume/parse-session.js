#!/usr/bin/env node
/*
 * parse-session.js — Unified reader for Claude Code / Codex / opencode sessions.
 *
 * Normalizes any of the three session stores into a common digest:
 *   { meta, turns[] } where turn = { role, text, tool?, ts, seq }
 *
 * Usage:
 *   node parse-session.js <id|path> [--tool auto|claude|codex|opencode]
 *                        [--cwd <path>] [--out <file>] [--last <n>] [--list]
 *
 * Output: a readable UTF-8 digest written to <out> (default: temp). stdout is
 * ASCII-safe (paths/counts/tool/interrupt) so console codepage can't mojibake it;
 * the AI reads the digest file for the Korean/verbose content.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const HOME = os.homedir();
const OPENCODE_BIN =
  path.join(HOME, "AppData", "Roaming", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");

// ---------- arg parsing ----------
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : null;
}
let target = args.find((a) => !a.startsWith("--"));
const TOOL = flag("tool") || "auto";
const CWD = flag("cwd");
const OUT = flag("out");
const LAST = flag("last") ? parseInt(flag("last"), 10) : 0;
const LIST = args.includes("--list");

const TMP = path.join(os.tmpdir(), "session-resume");
fs.mkdirSync(TMP, { recursive: true });

// ---------- helpers ----------
function readJSONL(p) {
  const out = [];
  const raw = fs.readFileSync(p, "utf8").split(/\r?\n/);
  for (const line of raw) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) {}
  }
  return out;
}
function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "…" : s; }
function briefToolInput(input) {
  if (!input || typeof input !== "object") return "";
  if (input.command) return clip(input.command, 120);
  if (input.filePath) return input.filePath;
  if (input.file_path) return input.file_path;
  if (input.pattern) return "/" + input.pattern + "/";
  if (input.url) return input.url;
  if (input.prompt) return clip(input.prompt, 100);
  try { return clip(JSON.stringify(input), 100); } catch (_) { return ""; }
}
function looksLikeRealUserText(t) {
  // Claude injects command wrappers / task notifications as user-role strings starting with '<'
  return typeof t === "string" && !/^\s*</.test(t) && t.trim().length > 0;
}

// ---------- finders ----------
function claudeEncodeCwd(cwd) {
  // D:\alpha-adk -> D--alpha-adk  (colon -> '-', backslash -> '-', each single)
  // /home/luke   -> -home-luke
  return cwd.replace(/\\/g, "-").replace(/\//g, "-").replace(/:/g, "-");
}
function findClaude(idOrPath, cwd) {
  if (idOrPath && fs.existsSync(idOrPath) && idOrPath.endsWith(".jsonl")) return idOrPath;
  const root = path.join(HOME, ".claude", "projects");
  if (!fs.existsSync(root)) return null;
  const dirs = cwd ? [claudeEncodeCwd(cwd)] : fs.readdirSync(root);
  for (const d of dirs) {
    const full = path.join(root, d);
    if (!fs.existsSync(full)) continue;
    const files = fs.readdirSync(full).filter((f) => f.endsWith(".jsonl"));
    let m = files.find((f) => f === idOrPath + ".jsonl") ||
            files.find((f) => f.startsWith(idOrPath));
    if (m) return path.join(full, m);
  }
  return null;
}
function listClaude(cwd) {
  const root = path.join(HOME, ".claude", "projects");
  if (!fs.existsSync(root)) return [];
  const dirs = cwd ? [claudeEncodeCwd(cwd)] : fs.readdirSync(root);
  const out = [];
  for (const d of dirs) {
    const full = path.join(root, d);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(full, f);
      out.push({ tool: "claude", id: f.replace(/\.jsonl$/, ""), path: p, mtime: fs.statSync(p).mtimeMs, dir: d });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function findCodex(idOrPath) {
  if (idOrPath && fs.existsSync(idOrPath) && idOrPath.endsWith(".jsonl")) return idOrPath;
  const root = path.join(HOME, ".codex", "sessions");
  if (!fs.existsSync(root)) return null;
  let found = null;
  function walk(dir) {
    if (found) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        if (!idOrPath || e.name.includes(idOrPath)) { found = p; return; }
      }
    }
  }
  walk(root);
  return found;
}
function listCodex() {
  const root = path.join(HOME, ".codex", "sessions");
  if (!fs.existsSync(root)) return [];
  const out = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) out.push({ tool: "codex", id: e.name.replace(/\.jsonl$/, ""), path: p, mtime: fs.statSync(p).mtimeMs });
    }
  }
  walk(root);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function opencodeList() {
  if (!fs.existsSync(OPENCODE_BIN)) return [];
  const r = spawnSync(OPENCODE_BIN, ["session", "list"], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) return [];
  const out = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^(ses_\S+)\s+(.*?)\s+(\S.+)$/);
    if (m) out.push({ tool: "opencode", id: m[1], title: m[2].trim(), when: m[3].trim() });
  }
  return out;
}
function opencodeExport(sid) {
  const r = spawnSync(OPENCODE_BIN, ["export", sid], { encoding: "buffer", maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error("opencode export failed: " + r.stderr.toString());
  let buf = r.stdout;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) buf = Buffer.from(buf.toString("utf16le"), "utf8");
  return JSON.parse(buf.toString("utf8"));
}

// ---------- format detectors ----------
function isOpencodeId(s) { return /^ses_/.test(s || ""); }
function detectTool(idOrPath) {
  if (!idOrPath) return "auto";
  if (isOpencodeId(idOrPath)) return "opencode";
  if (/rollout-|\.codex[\\/]/.test(idOrPath)) return "codex";
  if (fs.existsSync(idOrPath)) {
    const first = readJSONL(idOrPath)[0] || {};
    if (first.type === "session_meta" || (first.payload && first.payload.cwd && first.originator)) return "codex";
    if (first.sessionId || first.type === "user" || first.type === "summary") return "claude";
  }
  // bare id: try claude first (uuid shape), then codex
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(idOrPath)) return "claude";
  return "auto";
}

// ---------- parsers (each returns { meta, turns[] }) ----------
function parseClaude(p) {
  const lines = readJSONL(p);
  const meta = { tool: "claude", path: p };
  const turns = [];
  let seq = 0;
  for (const o of lines) {
    if (!meta.sessionId && o.sessionId) meta.sessionId = o.sessionId;
    if (!meta.cwd && o.cwd) meta.cwd = o.cwd;
    if (!meta.gitBranch && o.gitBranch) meta.gitBranch = o.gitBranch;
    if (!meta.version && o.version) meta.version = o.version;
    if (!meta.ts && o.timestamp) meta.ts = o.timestamp;
    if (o.type === "summary" && o.summary) meta.title = o.summary;
    if (o.type === "user" && o.message && o.message.role === "user") {
      const c = o.message.content;
      if (typeof c === "string") {
        if (looksLikeRealUserText(c)) turns.push({ seq: ++seq, role: "user", text: c, ts: o.timestamp });
      }
      // array content = tool_result → skip (noise)
    } else if (o.type === "assistant" && o.message && o.message.role === "assistant") {
      const blocks = o.message.content || [];
      for (const b of blocks) {
        if (b.type === "text" && b.text && b.text.trim())
          turns.push({ seq: ++seq, role: "assistant", text: b.text, ts: o.timestamp });
        else if (b.type === "tool_use")
          turns.push({ seq: ++seq, role: "tool", tool: b.name, text: briefToolInput(b.input), ts: o.timestamp });
      }
    }
  }
  meta.lastTs = lines.length ? lines[lines.length - 1].timestamp : meta.ts;
  return { meta, turns };
}

function parseCodex(p) {
  const lines = readJSONL(p);
  const meta = { tool: "codex", path: p };
  const turns = [];
  let seq = 0;
  for (const o of lines) {
    if (o.type === "session_meta" && o.payload) {
      meta.sessionId = o.payload.id;
      meta.cwd = o.payload.cwd;
      meta.version = o.payload.cli_version;
      if (o.payload.git) { meta.gitBranch = o.payload.git.branch; meta.gitRepo = o.payload.git.repository_url; }
      if (o.payload.model_provider) meta.model = o.payload.model_provider;
    }
    if (o.type !== "response_item" || !o.payload) continue;
    const pl = o.payload;
    if (pl.type === "message" && pl.content) {
      const role = pl.role === "developer" ? "system" : pl.role;
      for (const c of pl.content) {
        const txt = c.text || c.output_text || c.input_text;
        if (!txt || !txt.trim()) continue;
        if (role === "user" && !looksLikeRealUserText(txt)) continue;
        if (role === "system") {
          // developer/permissions/skills instructions — keep a tiny marker only
          if (/<(permissions|apps|skills)_instructions>/.test(txt)) continue;
          turns.push({ seq: ++seq, role: "system", text: clip(txt, 200), ts: o.timestamp });
        } else {
          turns.push({ seq: ++seq, role, text: txt, ts: o.timestamp });
        }
      }
    } else if (pl.type === "function_call") {
      turns.push({ seq: ++seq, role: "tool", tool: pl.name, text: briefToolInput(parseArgs(pl.arguments)), ts: o.timestamp });
    } else if (pl.type === "local_shell_call" && pl.action) {
      turns.push({ seq: ++seq, role: "tool", tool: "shell", text: clip((pl.action.command || "") + " " + (pl.action.args || []).join(" "), 120), ts: o.timestamp });
    }
  }
  return { meta, turns };
}
function parseArgs(a) { try { return typeof a === "string" ? JSON.parse(a) : a; } catch (_) { return {}; } }

function parseOpencode(d) {
  const info = d.info || {};
  const meta = {
    tool: "opencode",
    sessionId: info.id,
    title: info.title,
    cwd: info.directory,
    agent: info.agent,
    model: info.model && (info.model.providerID + "/" + info.model.id),
    version: info.version,
    tokens: info.tokens,
    ts: info.time && info.time.created,
    lastTs: info.time && info.time.updated,
  };
  const turns = [];
  let seq = 0;
  for (const m of d.messages || []) {
    const role = (m.info && m.info.role) || "user";
    for (const part of m.parts || []) {
      if (part.type === "text" && part.text && part.text.trim())
        turns.push({ seq: ++seq, role, text: part.text, ts: m.info && m.info.time && m.info.time.created });
      else if (part.type === "tool")
        turns.push({ seq: ++seq, role: "tool", tool: part.tool, text: briefToolInput(part.input), ts: m.info && m.info.time && m.info.time.created });
    }
  }
  return { meta, turns };
}

// ---------- interrupt detection ----------
function detectInterrupt(meta, turns) {
  const lastUser = [...turns].reverse().find((t) => t.role === "user");
  const lastAsst = [...turns].reverse().find((t) => t.role === "assistant");
  const lastTexts = turns.slice(-12).map((t) => t.text || "").join(" ");
  if (/weekly limit|rate.?limit|hit your|quota exceeded|capacity/i.test(lastTexts))
    return { kind: "quota", note: "session likely cut off by rate/usage limit" };
  if (/(\/exit|See ya|have a good|goodbye)/i.test(lastUser ? lastUser.text : ""))
    return { kind: "exited", note: "user ran /exit — clean end" };
  if (/(\/compact)/i.test(lastUser ? lastUser.text : ""))
    return { kind: "compacted", note: "context was compacted" };
  const last = lastAsst ? lastAsst.text : "";
  if (/error|failed|cannot|unable to/i.test(last) && turns.length && turns[turns.length - 1].role !== "user")
    return { kind: "maybe-error", note: "last assistant msg looks like an error/unable" };
  if (turns.length && turns[turns.length - 1].role === "tool")
    return { kind: "mid-action", note: "ends mid-tool — possibly interrupted" };
  return { kind: "normal", note: "appears to end on an assistant/user turn" };
}

// ---------- digest formatting ----------
function fmtDigest({ meta, turns }) {
  const interrupt = detectInterrupt(meta, turns);
  const userTurns = turns.filter((t) => t.role === "user");
  const shown = LAST ? turns.slice(-LAST) : turns;
  const L = [];
  L.push("# Session digest — " + (meta.tool || "?"));
  L.push("");
  L.push("- sessionId: " + (meta.sessionId || "?"));
  if (meta.title) L.push("- title: " + meta.title);
  if (meta.cwd) L.push("- cwd: " + meta.cwd);
  if (meta.gitBranch) L.push("- branch: " + meta.gitBranch);
  if (meta.model) L.push("- model: " + meta.model);
  if (meta.agent) L.push("- agent: " + meta.agent);
  if (meta.version) L.push("- version: " + meta.version);
  if (meta.ts) L.push("- started: " + meta.ts);
  if (meta.lastTs) L.push("- last: " + meta.lastTs);
  L.push("- turns: " + turns.length + " (user msgs: " + userTurns.length + ")");
  L.push("- interrupt: " + interrupt.kind.toUpperCase() + " — " + interrupt.note);
  L.push("");
  L.push("## Conversation flow");
  for (const t of shown) {
    const tag = t.role === "user" ? "USER" : t.role === "assistant" ? "AI" : t.role === "system" ? "SYS" : "TOOL";
    const cap = t.role === "user" ? 600 : t.role === "tool" ? 120 : 350;
    const body = t.tool ? "[" + t.tool + "] " + (t.text || "") : t.text;
    L.push("");
    L.push("[" + tag + " #" + t.seq + "] " + clip(body.replace(/\s+/g, " ").trim(), cap));
  }
  L.push("");
  L.push("## Last user intent");
  L.push(lastWords(userTurns));
  L.push("");
  L.push("## Suggested next step");
  L.push(suggestNext(interrupt, turns));
  return L.join("\n");
}
function lastWords(userTurns) {
  const last3 = userTurns.slice(-3).map((t) => "• " + clip(t.text.replace(/\s+/g, " ").trim(), 300));
  return last3.length ? last3.join("\n") : "(no clear user messages)";
}
function suggestNext(interrupt, turns) {
  const lastUser = [...turns].reverse().find((t) => t.role === "user");
  const lastAsst = [...turns].reverse().find((t) => t.role === "assistant");
  if (interrupt.kind === "quota")
    return "Session was cut off by a usage limit. Resume from the last user request: \"" + clip(lastUser ? lastUser.text : "", 200) + "\". The AI's last partial action was: " + clip(lastAsst ? lastAsst.text : "(none)", 160) + ".";
  if (interrupt.kind === "mid-action")
    return "Session ended mid-tool-call. Verify whether the in-flight change completed, then continue the last user request: \"" + clip(lastUser ? lastUser.text : "", 200) + "\".";
  return "Continue from the last user request: \"" + clip(lastUser ? lastUser.text : "", 200) + "\".";
}

// ---------- main ----------
function main() {
  if (LIST) {
    const all = [...listClaude(CWD), ...listCodex(), ...opencodeList()]
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
      .slice(0, 20);
    for (const s of all) console.log(s.tool.padEnd(9) + "  " + (s.id || "").padEnd(40) + "  " + (s.title || s.dir || s.when || ""));
    return;
  }

  let tool = TOOL;
  if (tool === "auto") tool = detectTool(target);

  let result = null;
  let usedTool = tool;
  let resolvedPath = null;

  if (tool === "opencode" || (tool === "auto" && isOpencodeId(target))) {
    try { result = parseOpencode(opencodeExport(target)); usedTool = "opencode"; }
    catch (e) { console.error("opencode error:", e.message); }
  }
  if (!result && (tool === "codex" || tool === "auto")) {
    const p = findCodex(target);
    if (p) { result = parseCodex(p); usedTool = "codex"; resolvedPath = p; }
  }
  if (!result && (tool === "claude" || tool === "auto")) {
    const p = findClaude(target, CWD);
    if (p) { result = parseClaude(p); usedTool = "claude"; resolvedPath = p; }
  }

  if (!result) {
    console.error("Could not resolve session for: " + (target || "(none)") + " (tool=" + tool + ")");
    console.error("Tip: run with --list to see recent sessions, or pass --tool claude|codex|opencode explicitly.");
    process.exit(2);
  }

  const digest = fmtDigest(result);
  const interrupt = detectInterrupt(result.meta, result.turns);
  const outPath = OUT || path.join(TMP, "digest-" + (result.meta.sessionId || "session").replace(/[^a-z0-9]+/gi, "_").slice(0, 24) + ".md");
  fs.writeFileSync(outPath, digest, "utf8");

  // ASCII-safe stdout (no Korean) so console codepage can't corrupt it
  console.log("tool=" + usedTool);
  console.log("id=" + (result.meta.sessionId || "?"));
  console.log("path=" + (resolvedPath || result.meta.path || "-"));
  console.log("digest=" + outPath);
  console.log("turns=" + result.turns.length + " users=" + result.turns.filter((t) => t.role === "user").length);
  console.log("interrupt=" + interrupt.kind);
}

main();
