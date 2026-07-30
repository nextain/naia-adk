#!/usr/bin/env node
/**
 * Session Contract Gate (PreToolUse: Edit|Write|Bash) — HARD enforcement.
 *
 * "계약 없이 동작 불가." If the session is NOT bound to a contract (a progress
 * file carrying this session's `session_id`), mutating tools are BLOCKED — so
 * the AI cannot drift into off-contract work. Complements session-inject.js,
 * which only *injects* a reminder (soft) and is therefore ignorable.
 *
 * Binding (matches & extends session-inject): a progress file under
 * `<cwd>/.agents/progress` (or an immediate submodule's) whose `session_id`
 * equals the current session. Recognized in BOTH:
 *   - `.json`  : top-level `"session_id"` field
 *   - `.md`    : YAML frontmatter `session_id:` (the documented convention —
 *                session-inject only read .json, which is why .md anchors silently
 *                failed to bind. This gate closes that gap.)
 *
 * Escape hatches (never deadlock):
 *   - Opt-out: env CLAUDE_HARNESS in {off,0,false,no}, or file <cwd>/.claude/no-harness
 *   - Binding write: Write/Edit whose target path is under any .agents/progress dir
 *     is ALWAYS allowed, so the session can create/anchor its contract.
 *   - No session_id in the hook payload → fail-open (allow) to avoid breaking
 *     non-session/edge contexts.
 *
 * Block mechanism: legacy `{decision:"block", reason}` (same as commit-guard.js).
 */

const fs = require("fs"); // CommonJS: the repository package is ESM.
const path = require("path");

const HARNESS_OFF = new Set(["off", "0", "false", "no"]);
const HARNESS_ENV_VARS = ["AI_HARNESS", "CLAUDE_HARNESS", "CODEX_HARNESS"];
const HARNESS_CONFIG_DIRS = [".claude", ".codex"];

function normalizedToolName(name) {
  const leaf = String(name || "").split(/[.:/]/).pop().toLowerCase();
  if (["bash", "shell_command", "exec_command"].includes(leaf)) return "shell";
  if (["write", "edit", "notebookedit", "apply_patch"].includes(leaf)) return "file-mutation";
  return leaf;
}

function progressPath(filePath, cwd) {
  const target = path.resolve(cwd, String(filePath));
  return progressDirs(cwd).some((dir) => {
    const relative = path.relative(dir, target);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

function patchTargets(toolInput) {
  const patch = String(toolInput?.patch ?? toolInput?.command ?? toolInput?.input ?? "");
  const targets = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+?)\s*$/gm)) {
    targets.push(match[1]);
  }
  for (const match of patch.matchAll(/^\*\*\* Move to:\s+(.+?)\s*$/gm)) {
    targets.push(match[1]);
  }
  return targets;
}

function bindingWrite(toolName, toolInput, cwd) {
  if (normalizedToolName(toolName) !== "file-mutation") return false;
  const directPath = toolInput?.file_path || toolInput?.path;
  if (directPath) return progressPath(directPath, cwd);
  const targets = patchTargets(toolInput);
  return targets.length > 0 && targets.every((target) => progressPath(target, cwd));
}

const SAFE_READ_COMMANDS = [
  /^(?:get-content|gc|get-childitem|gci|dir|ls|get-item|gi|get-filehash|test-path|resolve-path)\b/i,
  /^(?:select-string|select-object|sort-object|where-object|measure-object)\b/i,
  /^(?:rg|grep|cat|head|tail|wc|pwd|stat|readlink)\b/i,
  /^git\s+(?:status|diff|log|show|remote|ls-files|check-ignore|rev-parse)\b/i,
  /^git\s+submodule\s+status\b/i,
];

function readOnlyShell(command) {
  const source = String(command || "").trim();
  if (!source) return true;
  if (
    /[><`]/.test(source) ||
    /\$\(/.test(source) ||
    /&&|\|\|/.test(source) ||
    /\b(?:set-content|add-content|out-file|tee|new-item|remove-item|move-item|copy-item|rename-item)\b/i.test(source) ||
    /\bgit\s+remote\s+(?:add|remove|rm|rename|set-head|set-branches|set-url|prune|update)\b/i.test(source)
  ) {
    return false;
  }
  const statements = source
    .split(";")
    .flatMap((statement) => statement.split("|"))
    .map((statement) => statement.trim())
    .filter(Boolean);
  return statements.length > 0 &&
    statements.every((statement) => SAFE_READ_COMMANDS.some((pattern) => pattern.test(statement)));
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function mdSessionId(content) {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  const fm = end === -1 ? content : content.slice(0, end);
  const m = fm.match(/^\s*session_id:\s*["']?([^"'\s]+)["']?/m);
  return m ? m[1] : null;
}

function progressDirs(cwd) {
  const dirs = new Set();
  // Self + ancestors (UP): a binding at the workspace root (alpha-adk) must cover
  // subproject cwds too. Walk up a bounded number of levels.
  let d = path.resolve(cwd);
  for (let i = 0; i < 12; i++) {
    const p = path.join(d, ".agents", "progress");
    if (fs.existsSync(p)) dirs.add(p);
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  // Immediate children (DOWN): submodule progress dirs.
  try {
    for (const e of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const sub = path.join(cwd, e.name, ".agents", "progress");
      if (fs.existsSync(sub)) dirs.add(sub);
    }
  } catch {
    /* ignore */
  }
  return [...dirs];
}

function isBound(dirs, sessionId) {
  for (const dir of dirs) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.startsWith(".")) continue;
      const fp = path.join(dir, f);
      try {
        if (f.endsWith(".json")) {
          const j = JSON.parse(fs.readFileSync(fp, "utf8"));
          if (j && j.session_id === sessionId) return true;
        } else if (f.endsWith(".md")) {
          if (mdSessionId(fs.readFileSync(fp, "utf8")) === sessionId) return true;
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  return false;
}

function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

function main() {
  const raw = readStdin();
  let cwd = process.cwd();
  let sessionId = null;
  let toolName = "";
  let toolInput = {};
  if (raw) {
    try {
      const d = JSON.parse(raw);
      if (d.cwd) cwd = d.cwd;
      if (d.session_id) sessionId = d.session_id;
      if (d.tool_name) toolName = d.tool_name;
      if (d.tool_input) toolInput = d.tool_input;
    } catch {
      /* fail-open below */
    }
  }

  // Opt-out
  if (HARNESS_ENV_VARS.some((name) => HARNESS_OFF.has((process.env[name] || "").trim().toLowerCase()))) {
    process.exit(0);
  }
  if (HARNESS_CONFIG_DIRS.some((dir) => fs.existsSync(path.join(cwd, dir, "no-harness")))) {
    process.exit(0);
  }

  // Fail-open if we can't identify the session (edge/non-session contexts)
  if (!sessionId) process.exit(0);

  const dirs = progressDirs(cwd);
  // If there is no progress dir at all, this isn't an IDD workspace — allow.
  if (dirs.length === 0) process.exit(0);

  if (isBound(dirs, sessionId)) process.exit(0); // bound → allow everything

  // ── Unbound ──────────────────────────────────────────────────────────────
  // Escape hatch: allow Write/Edit to a progress file so the session can bind.
  // Component-EXACT check (not substring) — the file's directory chain must
  // contain adjacent ".agents"/"progress" path components, so a path that merely
  // contains the substring (e.g. ".../fake.agents/progress-x/...") cannot bypass.
  const fp = toolInput && (toolInput.file_path || toolInput.path);
  if (bindingWrite(toolName, toolInput, cwd)) process.exit(0);
  if (normalizedToolName(toolName) === "shell" && readOnlyShell(toolInput.command)) {
    process.exit(0);
  }
  if ((toolName === "Write" || toolName === "Edit" || toolName === "NotebookEdit") && fp && progressPath(fp, cwd)) {
    // EXACT lowercase ".agents"/"progress" — must match isBound()/progressDirs()
    // exactly (they path.join the lowercase literals). If the escape were
    // case-insensitive but isBound is exact, a case-variant write would be
    // allowed yet never recognized as a binding → orphan deadlock. Exact match
    // keeps allow-set == bind-set: a wrong-case write is blocked, forcing the
    // correct path, which DOES bind.
    const parts = path.dirname(path.resolve(String(fp))).split(path.sep);
    for (let i = 0; i + 1 < parts.length; i++) {
      if (parts[i] === ".agents" && parts[i + 1] === "progress") process.exit(0);
    }
  }

  block(
    "⛔ [HARNESS] SESSION UNBOUND — 계약(progress 파일)에 바인딩되지 않아 이 작업을 막습니다.\n" +
      "계약 없이 mutating 작업(Edit/Write/Bash) 금지.\n\n" +
      "해제 방법 (하나):\n" +
      `  1) 바인딩: .agents/progress/ 아래 progress 파일에 "session_id": "${sessionId}" 를 기록\n` +
      "     (.json 의 top-level 필드 또는 .md 의 frontmatter). 그 즉시 bound → 작업 허용.\n" +
      "  2) IDD 외 자유작업: env CODEX_HARNESS=off  또는  touch .codex/no-harness\n" +
      "\nprogress 파일 쓰기 자체는 허용되어 있으니 먼저 계약을 박으세요.",
  );
}

if (require.main === module) main();
module.exports = { bindingWrite, normalizedToolName, patchTargets, progressPath, readOnlyShell };
