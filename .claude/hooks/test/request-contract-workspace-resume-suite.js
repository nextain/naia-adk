"use strict";

/** Request-contract tests: workspace integrity, durable writes, and resume. */

const {
	test,
	assert,
	cp,
	fs,
	path,
	core,
	adapter,
	CLIENT_VERSIONS,
	withDeniedReaddir,
	fixture,
	start,
	signedReceipt,
	bind,
	cleanReview,
	ingestReview,
} = require("./request-contract-test-helpers.js");

test("product-root configuration drift invalidates completion", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (const id of ["R1", "R2"]) {
		const review = cleanReview(fx, unit, id);
		ingestReview(fx, unit, review);
	}
	const configFile = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
	config.product_roots.push("docs");
	fs.writeFileSync(configFile, JSON.stringify(config));
	const result = core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(result.kind, "block");
	assert(result.errors.includes("product_root_config_drift"));
});
test("whole-repository scope captures changes under skills and docs", () => {
	const fx = fixture();
	const configFile = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
	config.product_roots = ["."];
	config.exclusions.push("node_modules");
	fs.writeFileSync(configFile, JSON.stringify(config));
	const unit = start(fx);
	fs.mkdirSync(path.join(fx.cwd, "skills"), { recursive: true });
	fs.writeFileSync(path.join(fx.cwd, "skills", "new-skill.md"), "new governed content\n");
	fs.mkdirSync(path.join(fx.cwd, "packages", "demo", "node_modules", "ignored"), { recursive: true });
	fs.writeFileSync(path.join(fx.cwd, "packages", "demo", "node_modules", "ignored", "index.js"), "ignored\n");
	const captured = core.captureWorkspaceOccurrences(unit, fx.cwd);
	assert(captured.occurrences.some((occurrence) => occurrence.detail.path === "skills/new-skill.md"));
	assert(!captured.occurrences.some((occurrence) => occurrence.detail.path.includes("node_modules")));
});

test("workspace manifests fail closed on unreadable directories and unsupported file types", () => {
	const fx = fixture();
	const unreadable = path.join(fx.cwd, "src", "unreadable");
	fs.mkdirSync(unreadable);
	fs.writeFileSync(path.join(unreadable, "hidden.txt"), "must not disappear from the manifest\n");
	withDeniedReaddir(unreadable, () => assert.throws(() => core.workspaceManifest(fx.cwd), (error) => error.code === "workspace_manifest_unreadable"));
	if (process.platform === "win32") {
		const unsupported = path.join(fx.cwd, "src", "unsupported.entry");
		fs.writeFileSync(unsupported, "simulated unsupported type\n");
		const original = fs.lstatSync;
		fs.lstatSync = function unsupportedLstat(candidate, ...args) {
			if (path.resolve(candidate) === path.resolve(unsupported)) return { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false };
			return original.call(fs, candidate, ...args);
		};
		try {
			assert.throws(() => core.workspaceManifest(fx.cwd), (error) => error.code === "workspace_manifest_unsupported_type");
		} finally {
			fs.lstatSync = original;
		}
	} else {
		const fifo = path.join(fx.cwd, "src", "unsupported.fifo");
		cp.execFileSync("mkfifo", [fifo]);
		assert.throws(() => core.workspaceManifest(fx.cwd), (error) => error.code === "workspace_manifest_unsupported_type");
	}
});

test("POSIX backslashes remain distinct workspace path bytes", () => {
	if (process.platform === "win32") return;
	const fx = fixture();
	fs.mkdirSync(path.join(fx.cwd, "collision"), { recursive: true });
	fs.writeFileSync(path.join(fx.cwd, "collision", "path.txt"), "slash\n");
	fs.writeFileSync(path.join(fx.cwd, "collision\\path.txt"), "backslash\n");
	const first = core.workspaceManifest(fx.cwd).manifest;
	assert(first.files["collision/path.txt"]);
	assert(first.files["collision\\path.txt"]);
	assert.notEqual(first.files["collision/path.txt"].digest, first.files["collision\\path.txt"].digest);
	fs.writeFileSync(path.join(fx.cwd, "collision\\path.txt"), "changed backslash\n");
	const second = core.workspaceManifest(fx.cwd);
	assert.notEqual(second.digest, core.sha256(core.canonicalJson(first)));
});

test("malformed numeric lifecycle settings fail closed", () => {
	for (const [pathParts, value, code] of [
		[["stop_attempt_limit"], "invalid", "stop_attempt_limit_invalid"],
		[["minimum_clean_rounds"], 1.5, "minimum_clean_rounds_invalid"],
		[["retention", "success_hours"], 0, "retention_success_hours_invalid"],
	]) {
		const fx = fixture();
		const file = path.join(fx.cwd, ".agents", "context", "request-contract.json");
		const config = JSON.parse(fs.readFileSync(file, "utf8"));
		let target = config;
		for (const part of pathParts.slice(0, -1)) target = target[part];
		target[pathParts.at(-1)] = value;
		fs.writeFileSync(file, JSON.stringify(config));
		assert(core.loadConfig(fx.cwd).errors.includes(code));
		assert.throws(() => core.workspaceManifest(fx.cwd), (error) => error.code === "request_contract_config_invalid");
	}
});

test("unreadable unit and quarantine storage can never disengage sticky governance", () => {
	let fx = fixture();
	start(fx);
	const units = path.join(core.harnessRoot(fx.cwd), "units");
	withDeniedReaddir(units, () => {
		assert.throws(() => core.hasStickyGovernanceState(fx.cwd), (error) => error.code === "unit_storage_unreadable");
		const processed = adapter.processEnvelope("claude", { hook_event_name: "UserPromptSubmit", session_id: "S1", cwd: fx.cwd, prompt: "preserve during unreadable unit storage" });
		assert.equal(processed.output.decision, "block");
	});
	const preserved = core.listUnconsumedQuarantine(fx.cwd);
	assert.equal(core.readJsonl(path.join(preserved[0].dir, "sources.jsonl"))[0].prompt, "preserve during unreadable unit storage");
	fx = fixture();
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "Q", cwd: fx.cwd, prompt: "preserve me", origin: "native_user" });
	const quarantine = path.join(core.harnessRoot(fx.cwd), "quarantine");
	withDeniedReaddir(quarantine, () => assert.throws(() => core.hasStickyGovernanceState(fx.cwd), (error) => error.code === "quarantine_storage_unreadable"));
});

test("Git index and object failures abort manifests instead of hashing empty output", () => {
	const fx = fixture();
	const index = path.join(fx.cwd, ".git", "index");
	const savedIndex = fs.readFileSync(index);
	fs.writeFileSync(index, "corrupt index\n");
	try {
		assert.throws(() => core.workspaceManifest(fx.cwd), (error) => error.code === "workspace_manifest_git_error");
	} finally {
		fs.writeFileSync(index, savedIndex);
	}
	const oid = cp.execFileSync("git", ["rev-parse", "HEAD:src/product.txt"], { cwd: fx.cwd, encoding: "utf8" }).trim();
	const object = path.join(fx.cwd, ".git", "objects", oid.slice(0, 2), oid.slice(2));
	const hidden = `${object}.missing`;
	fs.renameSync(object, hidden);
	try {
		assert.throws(() => core.referenceManifest(fx.cwd), (error) => error.code === "workspace_manifest_git_error");
	} finally {
		fs.renameSync(hidden, object);
	}
});

test("atomic writes fsync content before rename and parent metadata after rename or unlink", () => {
	const fx = fixture();
	const dir = path.join(fx.cwd, "durability");
	fs.mkdirSync(dir);
	const target = path.join(dir, "state.json");
	const events = [];
	const fdPaths = new Map();
	const original = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, closeSync: fs.closeSync };
	fs.openSync = function(file, ...args) {
		const fd = original.openSync.call(fs, file, ...args);
		fdPaths.set(fd, String(file));
		return fd;
	};
	fs.fsyncSync = function(fd) {
		events.push({ kind: "fsync", file: fdPaths.get(fd) });
		return original.fsyncSync.call(fs, fd);
	};
	fs.renameSync = function(from, to) {
		events.push({ kind: "rename", from: String(from), to: String(to) });
		return original.renameSync.call(fs, from, to);
	};
	fs.unlinkSync = function(file) {
		events.push({ kind: "unlink", file: String(file) });
		return original.unlinkSync.call(fs, file);
	};
	fs.closeSync = function(fd) {
		try { return original.closeSync.call(fs, fd); } finally { fdPaths.delete(fd); }
	};
	try {
		core.secureWrite(target, "durable\n");
		core.durableUnlink(target);
	} finally {
		Object.assign(fs, original);
	}
	const rename = events.findIndex((event) => event.kind === "rename" && event.to === target);
	assert(rename > 0);
	assert(events.slice(0, rename).some((event) => event.kind === "fsync" && event.file && event.file.endsWith(".tmp")));
	assert(events.slice(rename + 1).some((event) => event.kind === "fsync" && event.file === dir));
	const unlink = events.findIndex((event) => event.kind === "unlink" && event.file === target);
	assert(unlink > rename);
	assert(events.slice(unlink + 1).some((event) => event.kind === "fsync" && event.file === dir));
});

test("dirty tracked content inside a gitlink is captured", () => {
	const fx = fixture();
	const configFile = path.join(fx.cwd, ".agents", "context", "request-contract.json");
	const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
	config.product_roots = ["."];
	fs.writeFileSync(configFile, JSON.stringify(config));
	const sub = path.join(fx.cwd, "vendor", "child");
	fs.mkdirSync(sub, { recursive: true });
	cp.execFileSync("git", ["init", "-q"], { cwd: sub });
	fs.writeFileSync(path.join(sub, "tracked.txt"), "clean\n");
	cp.execFileSync("git", ["add", "tracked.txt"], { cwd: sub });
	cp.execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd: sub });
	const commit = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: sub, encoding: "utf8" }).trim();
	cp.execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${commit},vendor/child`], { cwd: fx.cwd });
	const unit = start(fx);
	fs.writeFileSync(path.join(sub, "tracked.txt"), "dirty\n");
	const captured = core.captureWorkspaceOccurrences(unit, fx.cwd);
	assert(captured.occurrences.some((occurrence) => occurrence.detail.path === "vendor/child" && occurrence.detail.after.dirty === true));
	const priorCount = captured.occurrences.length;
	fs.writeFileSync(path.join(sub, "tracked.txt"), "different dirty bytes\n");
	const recaptured = core.captureWorkspaceOccurrences(unit, fx.cwd);
	assert.equal(recaptured.occurrences.length, priorCount + 1);
	assert.notEqual(recaptured.occurrences.at(-1).detail.before.dirty_digest, recaptured.occurrences.at(-1).detail.after.dirty_digest);
});

test("third unchanged failed Stop writes an honest incomplete terminal", () => {
	const fx = fixture();
	const unit = start(fx);
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "incomplete");
	assert.equal(core.readJson(unit.paths.state).terminal.status, "incomplete");
});

test("a changed failure fingerprint starts a fresh consecutive Stop episode", () => {
	const fx = fixture();
	const unit = start(fx);
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	const firstEpisode = core.readJson(unit.paths.state).stop.episode_id;
	bind(fx, unit);
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	const secondStop = core.readJson(unit.paths.state).stop;
	assert.equal(secondStop.attempt, 1);
	assert.notEqual(secondStop.episode_id, firstEpisode);
	core.handleEvent({ client: "claude", eventName: "UserPromptSubmit", sessionId: "S1", cwd: fx.cwd, prompt: "new required scope", origin: "native_user" });
	assert.equal(core.evaluateCompletion(unit, fx.cwd, "claude").kind, "block");
	const thirdStop = core.readJson(unit.paths.state).stop;
	assert.equal(thirdStop.attempt, 1);
	assert.notEqual(thirdStop.episode_id, secondStop.episode_id);
	assert.equal(core.readJson(unit.paths.state).terminal, undefined);
});

test("incomplete lineage requires a fresh signed resume and rejects replay", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	for (let i = 0; i < 3; i++) core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.equal(core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "S2", cwd: fx.cwd }).code, "incomplete_lineage_requires_resume");
	const head = core.readJson(unit.paths.head);
	const binding = core.readJson(unit.paths.binding);
	const scope = core.sha256(core.canonicalJson(core.scopeProjection(core.readJson(unit.paths.contract))));
	const authority = { operation: "resume", target_directive_ids: [] };
	const presentation = core.authorityPresentation(authority, scope, scope, head.scope_epoch + 1, binding.binding_epoch + 1);
	const challenge = core.issueAuthorityChallenge(unit, fx.cwd, presentation);
	const receipt = signedReceipt(fx, {
		operation: "resume",
		prior_scope_digest: scope,
		resulting_scope_digest: scope,
		resulting_scope_epoch: head.scope_epoch + 1,
		binding_epoch: binding.binding_epoch + 1,
		challenge: challenge.challenge,
		presentation_digest: challenge.presentation_digest,
		target_directive_ids: [],
		sign_count: 2,
	});
	core.resumeIncomplete(unit, receipt, fx.cwd);
	assert.equal(core.handleEvent({ client: "codex", clientVersion: CLIENT_VERSIONS.codex, eventName: "SessionStart", sessionId: "S2", cwd: fx.cwd }).kind, "context");
	for (let i = 0; i < 3; i++) core.evaluateCompletion(unit, fx.cwd, "claude");
	assert.throws(() => core.resumeIncomplete(unit, receipt, fx.cwd), /authority_/);
});
