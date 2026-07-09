#!/usr/bin/env node
/*
 * sync-upstream.js — ADK fork-chain sync helper.
 *
 * Reports drift against a fork's declared upstream and (with --merge) performs
 * the proper `git merge upstream/main`, then stamps .agents/upstream-sync.yaml
 * and VERSION so drift is detectable next time.
 *
 * Reads its OWN repo's .agents/upstream-sync.yaml to know which upstream to
 * sync from. The top repo (upstream_repo: null) is a no-op (nothing to sync).
 *
 * Usage:
 *   node sync-upstream.js                # drift report only (no changes)
 *   node sync-upstream.js --merge        # fetch + merge + stamp version
 *   node sync-upstream.js --remote URL   # set/override upstream remote
 *
 * Conflict policy is upstream-structure-first (see SKILL.md); this script does
 * not auto-resolve — it runs the merge and leaves conflicts for the operator/
 * AI to resolve per policy, then stamps only on a clean merge.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = findRoot();
const SYNC_YAML = path.join(ROOT, ".agents", "upstream-sync.yaml");
const VERSION_FILE = path.join(ROOT, "VERSION");

function findRoot() {
  // anchor to the script's own location (skill lives at <root>/.agents/skills/sync-upstream/)
  // not to cwd, so the right repo is detected regardless of where node is invoked from.
  let d = path.resolve(__dirname, "..", "..", "..");
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(d, ".agents")) && fs.existsSync(path.join(d, ".git"))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return process.cwd();
}
function git(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), status: r.status };
}
function readYamlField(key) {
  if (!fs.existsSync(SYNC_YAML)) return null;
  const lines = fs.readFileSync(SYNC_YAML, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (/^\s*#/.test(line)) continue; // skip comment lines
    const m = line.match(new RegExp("^\\s*" + key + "\\s*:\\s*(.*)$"));
    if (m) {
      let v = m[1].replace(/#.*$/, "").trim();
      if (v === "" || v === "null" || v === "~") return null;
      if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
      return v;
    }
  }
  return null;
}
function localVersion() {
  if (!fs.existsSync(VERSION_FILE)) return "(no VERSION)";
  return fs.readFileSync(VERSION_FILE, "utf8").trim();
}
function inferUpstreamUrl(repo) {
  if (!repo) return null;
  if (/^https?:\/\//.test(repo) || /^git@/.test(repo)) return repo;
  return "https://github.com/" + repo + ".git";
}
function remoteUpstream() {
  const r = git(["remote", "get-url", "upstream"]);
  return r.ok ? r.out : null;
}

// ---------- main ----------
const DO_MERGE = process.argv.includes("--merge");
const REMOTE_ARG = (() => { const i = process.argv.indexOf("--remote"); return i >= 0 ? process.argv[i + 1] : null; })();

const declaredUpstream = readYamlField("upstream_repo");
console.log("adk_version(local): " + localVersion());
console.log("upstream_repo(declared): " + (declaredUpstream || "(null — this is the top of chain)"));

if (!declaredUpstream) {
  console.log("\nThis is the top of the fork chain (upstream_repo: null). Nothing to sync from.");
  console.log("If you intended this repo to be a downstream, set upstream_repo in .agents/upstream-sync.yaml.");
  process.exit(0);
}

// resolve upstream remote (priority: --remote arg > existing 'upstream' remote > declared upstream_repo)
let upUrl = REMOTE_ARG || remoteUpstream() || inferUpstreamUrl(declaredUpstream);
console.log("upstream url: " + upUrl);

// ensure 'upstream' remote exists & points correctly
const have = remoteUpstream();
if (!have) {
  git(["remote", "add", "upstream", upUrl]);
  console.log("added remote 'upstream' -> " + upUrl);
} else if (REMOTE_ARG && have !== upUrl) {
  git(["remote", "set-url", "upstream", upUrl]);
  console.log("updated remote 'upstream' -> " + upUrl);
}
const FETCH_REF = "upstream/main";

// fetch
console.log("\n=== fetch ===");
const fr = git(["fetch", "upstream", "main"], { stdio: ["ignore", "pipe", "pipe"] });
if (!fr.ok) { console.error("fetch failed:", fr.err); process.exit(1); }
console.log("fetched upstream/main");

const upTip = git(["rev-parse", FETCH_REF]).out;
console.log("upstream/main tip: " + upTip.slice(0, 10));

// drift
const mb = git(["merge-base", "HEAD", FETCH_REF]).out;
const mbDate = git(["log", "-1", "--format=%ad", "--date=short", mb]).out;
const mbSubj = git(["log", "-1", "--format=%s", mb]).out;
const behind = git(["rev-list", "--count", "HEAD.." + FETCH_REF]).out;
const ahead = git(["rev-list", "--count", FETCH_REF + "..HEAD"]).out;
console.log("\n=== drift ===");
console.log("merge-base: " + mb.slice(0, 10) + "  " + mbDate + "  " + mbSubj);
console.log("behind upstream: " + behind + " commits   ahead: " + ahead + " commits");

// upstream version stamp (read from upstream tree)
const upVerFile = git(["show", FETCH_REF + ":VERSION"]);
const upVer = upVerFile.ok ? upVerFile.out.trim() : "(no VERSION)";
console.log("upstream adk_version: " + upVer + "   (local: " + localVersion() + ")");
if (upVer !== localVersion() && upVer !== "(no VERSION)") {
  console.log("!! version drift — local is out of sync with upstream's version stamp");
}

if (!DO_MERGE) {
  console.log("\n(dry run — re-run with --merge to fetch+merge+stamp)");
  if (parseInt(behind, 10) > 0) console.log("note: " + behind + " commits behind — sync recommended.");
  process.exit(0);
}

// merge
console.log("\n=== merge upstream/main ===");
const mr = git(["merge", FETCH_REF, "--no-edit"], { stdio: ["ignore", "pipe", "pipe"] });
process.stdout.write(mr.out + "\n" + mr.err + "\n");
if (mr.status !== 0) {
  console.log("\nmerge produced conflicts (or was aborted). Resolve per conflict_policy=upstream-structure-first,");
  console.log("then `git commit`, then re-run with --merge to stamp the version (it will detect the merge is complete).");
  process.exit(2);
}

// stamp version on clean merge
stamp(upTip, upVer);
console.log("\nmerge clean — stamped .agents/upstream-sync.yaml + VERSION");
console.log("next: review changes, then `git push origin main`.");

function stamp(commit, version) {
  // bump local VERSION to upstream's version (we are now in sync)
  if (version && version !== "(no VERSION)") fs.writeFileSync(VERSION_FILE, version + "\n", "utf8");
  if (fs.existsSync(SYNC_YAML)) {
    let txt = fs.readFileSync(SYNC_YAML, "utf8");
    const now = new Date().toISOString().slice(0, 10);
    const repl = (key, val) => txt.replace(new RegExp("^(\\s*" + key + "\\s*:\\s*).*$", "m"), "$1" + val);
    txt = repl("upstream_commit", commit.slice(0, 10));
    txt = repl("upstream_version", version && version !== "(no VERSION)" ? version : '""');
    txt = repl("last_synced_at", now);
    if (version && version !== "(no VERSION)") txt = repl("adk_version", version);
    fs.writeFileSync(SYNC_YAML, txt, "utf8");
  }
}
