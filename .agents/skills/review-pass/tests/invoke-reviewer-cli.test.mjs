import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = path.resolve(here, "../scripts/invoke-reviewer.mjs");
const dir = await mkdtemp(path.join(os.tmpdir(), "review-cli-"));
const base = path.join(dir, "base.md");
const atoms = path.join(dir, "atoms.json");
const delta = path.join(dir, "delta.md");
await writeFile(base, "stable");
await writeFile(delta, "review");
await writeFile(atoms, JSON.stringify([{ id:"ATOM-1", source_id:"SRC-1", text:"review", directive_ids:[], subject:"agent_workflow", effect:"verification", render_policy:"deny", target_ids:[], criterion_ids:[], evidence_ids:[] }]));

const executable = path.join(dir, "codex");
await writeFile(executable, `#!/bin/sh
case "$REVIEW_FAKE_MODE" in
  startup) sleep 1 ;;
  idle) echo progress; sleep 1 ;;
  total) while :; do echo progress; sleep 0.02; done ;;
  *) cat >/dev/null; echo "token=sk-secretvalue123" >&2; echo "provider login required" >&2; exit 7 ;;
esac
`);
await chmod(executable, 0o700);
const common = [runner, "--tool", "codex", "--repo", dir, "--base", base, "--atoms", atoms, "--delta", delta, "--startup-sec", "1", "--idle-sec", "1", "--total-sec", "2"];
const env = { ...process.env, PATH:`${dir}${path.delimiter}${process.env.PATH || ""}` };

const optional = spawnSync(process.execPath, common, { encoding:"utf8", env });
assert.equal(optional.status, 0, optional.stderr);
const notRun = JSON.parse(optional.stdout);
assert.deepEqual({ status:notRun.status, reviewer:notRun.reviewer, blocking:notRun.blocking }, { status:"NOT_RUN", reviewer:"codex", blocking:false });
assert.equal(notRun.reason, "codex reviewer authentication or account access is unavailable");
assert.doesNotMatch(`${optional.stdout}${optional.stderr}`, /secretvalue/);

const required = spawnSync(process.execPath, [...common, "--require-review", "true"], { encoding:"utf8", env });
assert.equal(required.status, 7);
assert.match(required.stderr, /review invocation failed/);
assert.doesNotMatch(required.stderr, /secretvalue/);

for (const [phase, timers] of [
	["startup", ["--startup-sec", "0.05", "--idle-sec", "0.2", "--total-sec", "0.3"]],
	["idle", ["--startup-sec", "0.2", "--idle-sec", "0.05", "--total-sec", "0.4"]],
	["total", ["--startup-sec", "0.2", "--idle-sec", "0.2", "--total-sec", "0.08"]],
]) {
	const timed = spawnSync(process.execPath, [...common.slice(0, -6), ...timers], { encoding:"utf8", env:{ ...env, REVIEW_FAKE_MODE:phase } });
	assert.equal(timed.status, 0, timed.stderr);
	assert.equal(JSON.parse(timed.stdout).reason, `codex reviewer ${phase} timed out`);
}

const invalid = spawnSync(process.execPath, [...common, "--require-review", "yes"], { encoding:"utf8", env });
assert.notEqual(invalid.status, 0);
assert.match(invalid.stderr, /must be true or false/);

const invalidTimer = spawnSync(process.execPath, [...common.slice(0, -6), "--startup-sec", "invalid", "--idle-sec", "1", "--total-sec", "2"], { encoding:"utf8", env });
assert.notEqual(invalidTimer.status, 0);
assert.match(invalidTimer.stderr, /startupMs must be a finite positive timer value/);
assert.doesNotMatch(invalidTimer.stdout, /NOT_RUN/);

console.log("review invocation CLI tests: PASS");
