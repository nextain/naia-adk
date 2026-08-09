"use strict";

/** Request-contract tests: client registries, transactions, and repository locks. */

const {
	test,
	assert,
	cp,
	crypto,
	fs,
	os,
	path,
	core,
	adapter,
	runnerEvidenceByReview,
	CLIENT_VERSIONS,
	fixture,
	start,
	bind,
	cleanReview,
} = require("./request-contract-test-helpers.js");

test("checked-in client registries satisfy the exact native lifecycle contract", () => {
	const root = path.resolve(__dirname, "..", "..", "..");
	assert.equal(core.clientRegistrySupports(root, "claude"), true);
	assert.equal(core.clientRegistrySupports(root, "codex"), true);
});
test("both client registries reject every missing event plus wrong adapters, arguments, roots, native Windows commands, matchers, duplicates, and conflicts", () => {
	const requiredEvents = ["PreToolUse", "SessionStart", "UserPromptSubmit", "PostToolUse", "PreCompact", "PostCompact", "Stop"];
	for (const client of ["claude", "codex"]) {
		const relativeRegistry = client === "claude" ? [".claude", "settings.json"] : [".codex", "hooks.json"];
		const adapterName = client === "claude" ? "request-contract.js" : "request-contract.cjs";
		const adapterPath = client === "claude" ? ".claude/hooks/request-contract.js" : ".codex/hooks/request-contract.cjs";
		const locate = (registry, event) => {
			for (const entry of registry.hooks[event] || []) {
				const hook = (entry.hooks || []).find((candidate) => [candidate.command, candidate.commandWindows, ...(candidate.args || [])].some((value) => typeof value === "string" && value.includes(adapterPath)));
				if (hook) return { entry, hook };
			}
			throw new Error(`missing request-contract fixture hook for ${client}:${event}`);
		};
		const replaceEverywhere = (hook, pattern, replacement) => {
			if (typeof hook.command === "string") hook.command = hook.command.replace(pattern, replacement);
			if (typeof hook.commandWindows === "string") hook.commandWindows = hook.commandWindows.replace(pattern, replacement);
			if (Array.isArray(hook.args)) hook.args = hook.args.map((arg) => arg.replace(pattern, replacement));
		};
		const mutations = requiredEvents.flatMap((event) => [
			{ name: `${event}:missing`, mutate: (registry) => { delete registry.hooks[event]; } },
			{ name: `${event}:wrong-adapter`, mutate: (registry) => { const { hook } = locate(registry, event); replaceEverywhere(hook, adapterName, `wrong-${adapterName}`); } },
			{ name: `${event}:wrong-event-argument`, mutate: (registry) => {
				const { hook } = locate(registry, event);
				const replacement = event === "Stop" ? "PostCompact" : "Stop";
				if (client === "codex" && event === "Stop") {
					hook.command = hook.command.replace('node "$hook" Stop', 'node "$hook" PostCompact');
					hook.commandWindows = hook.commandWindows.replace("node $hook Stop", "node $hook PostCompact");
				} else replaceEverywhere(hook, new RegExp(`${event}$`), replacement);
			} },
			{ name: `${event}:wrong-root`, mutate: (registry) => { const { hook } = locate(registry, event); if (client === "claude") hook.command = `node ${adapterPath} ${event}`; else { hook.command = `node ${adapterPath} ${event}`; hook.commandWindows = `node ${adapterPath} ${event}`; } } },
			{ name: `${event}:wrong-matcher`, mutate: (registry) => { const { entry } = locate(registry, event); entry.matcher = event === "PreToolUse" ? "Bash" : "Bash|Edit"; } },
			{ name: `${event}:duplicate`, mutate: (registry) => { const { entry, hook } = locate(registry, event); entry.hooks.push({ ...hook }); } },
			{ name: `${event}:conflicting-registration`, mutate: (registry) => { const { hook } = locate(registry, event); registry.hooks[`Conflict${event}`] = [{ hooks: [{ ...hook }] }]; } },
			...(client === "claude" ? [{ name: `${event}:unexpected-commandWindows`, mutate: (registry) => { locate(registry, event).hook.commandWindows = `node wrong-${adapterName} ${event}`; } }] : []),
			...(client === "codex" ? [{ name: `${event}:missing-commandWindows`, mutate: (registry) => { delete locate(registry, event).hook.commandWindows; } }] : []),
		]);
		for (const { name, mutate } of mutations) {
			const fx = fixture();
			const registryPath = path.join(fx.cwd, ...relativeRegistry);
			const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
			mutate(registry);
			fs.writeFileSync(registryPath, JSON.stringify(registry));
			const result = core.handleEvent({ client, clientVersion: CLIENT_VERSIONS[client], eventName: "SessionStart", sessionId: `REG-${crypto.randomBytes(4).toString("hex")}`, cwd: fx.cwd });
			assert.equal(result.code, "request_contract_client_capability_missing", `${client} registry mutation was accepted: ${name}`);
		}
	}
});

test("prepared review ingestion recovers its log, head, invocation, and bundle", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const review = cleanReview(fx, unit, "CRASH-REVIEW");
	assert.throws(() => core.appendReview(unit, review, { expectedBundleDigest: review.bundle_digest, reviewerPublicKey: fx.reviewerPublicKeyPem, reviewerCredentialId: "test-review-executor", reviewRunnerPublicKey: fx.runnerPublicKeyPem, reviewRunnerCredentialId: "test-isolation-runner", runnerEvidence: runnerEvidenceByReview.get(review), cwd: fx.cwd, afterTransactionPrepared: () => { throw new Error("simulated review crash"); } }), /simulated review crash/);
	core.withUnitLock(unit, () => null);
	assert(core.verifyReviewChain(unit.paths).ok);
	assert.equal(core.verifyReviewChain(unit.paths).records.length, 1);
	assert(!fs.existsSync(path.join(unit.paths.transactions, "review.json")));
});

test("cleanup destroys bundles whose invocation manifest is corrupt", () => {
	const fx = fixture();
	const unit = start(fx);
	bind(fx, unit);
	const issued = core.issueReviewInvocation(unit, fx.cwd, "S1");
	const bundle = path.resolve(fx.cwd, issued.manifest.bundle_locator);
	fs.writeFileSync(path.join(unit.paths.pending, `review-${issued.manifest.nonce}.json`), "not json");
	core.issueReviewInvocation(unit, fx.cwd, "S1");
	assert(!fs.existsSync(bundle));
});

test("a stale lock with a recycled pid identity is reclaimed safely", () => {
	const fx = fixture();
	const unit = start(fx);
	const lock = path.join(unit.paths.locks, "lifecycle");
	fs.mkdirSync(lock, { recursive: true });
	fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, process_identity: "different-boot:1", nonce: "old" }));
	const old = new Date(Date.now() - 120_000);
	fs.utimesSync(lock, old, old);
	assert.equal(core.withUnitLock(unit, () => "reclaimed"), "reclaimed");
});

test("a lock owner is complete before publication and cannot enter through a replaced pathname", () => {
	const fx = fixture();
	const lock = path.join(fx.cwd, ".agents", "harness", "locks", "publication-test");
	const corePath = path.resolve(__dirname, "..", "..", "..", ".agents", "hooks", "core", "request-contract.js");
	const entered = core.withDirectoryLock(lock, () => "parent", Date.now(), 5_000, {
		afterCandidatePrepared: () => {
			assert(!fs.existsSync(lock));
			const output = cp.execFileSync(process.execPath, ["-e", "const core=require(process.argv[1]);core.withDirectoryLock(process.argv[2],()=>process.stdout.write('child'));", corePath, lock], { encoding: "utf8" });
			assert.equal(output, "child");
			assert(!fs.existsSync(lock));
		},
	});
	assert.equal(entered, "parent");
	assert(!fs.existsSync(lock));
});

test("Windows lock retries preserve the underlying publication diagnostic", () => {
	if (process.platform !== "win32") return;
	const fx = fixture();
	const lock = path.join(fx.cwd, ".agents", "harness", "locks", "diagnostic-test");
	assert.throws(
		() => core.withDirectoryLock(lock, () => "never", Date.now(), 30, {
			afterCandidatePrepared: () => { throw Object.assign(new Error("simulated access denial"), { code: "EPERM" }); },
		}),
		(error) => error.code === "lifecycle_lock_busy"
			&& error.publication_error?.code === "EPERM"
			&& /last publication error EPERM/.test(error.message),
	);
});

test("Windows lock release retries a transient sharing violation without deleting another owner", () => {
	if (process.platform !== "win32") return;
	const fx = fixture();
	const lock = path.join(fx.cwd, ".agents", "harness", "locks", "release-retry-test");
	const originalRename = fs.renameSync;
	let injected = false;
	fs.renameSync = (from, to) => {
		if (!injected && from === lock && String(to).startsWith(`${lock}.released.`)) {
			injected = true;
			throw Object.assign(new Error("simulated sharing violation"), { code: "EPERM" });
		}
		return originalRename(from, to);
	};
	try {
		assert.equal(core.withDirectoryLock(lock, () => "released"), "released");
	} finally {
		fs.renameSync = originalRename;
	}
	assert.equal(injected, true);
	assert.equal(fs.existsSync(lock), false);
});

test("an index change starts a fresh consecutive Stop episode", () => {
	const fx = fixture();
	const unit = start(fx);
	core.evaluateCompletion(unit, fx.cwd, "claude");
	const firstStop = core.readJson(unit.paths.state).stop;
	assert.equal(firstStop.attempt, 1);
	fs.writeFileSync(path.join(fx.cwd, "src", "product.txt"), "staged mutation\n");
	cp.execFileSync("git", ["add", "src/product.txt"], { cwd: fx.cwd });
	core.evaluateCompletion(unit, fx.cwd, "claude");
	const secondStop = core.readJson(unit.paths.state).stop;
	assert.equal(secondStop.attempt, 1);
	assert.notEqual(secondStop.episode_id, firstStop.episode_id);
});

test("repository locking serializes concurrent genesis and quarantine writers", () => {
	let fx = fixture();
	const worker = path.join(os.tmpdir(), `request-contract-worker-${crypto.randomBytes(8).toString("hex")}.cjs`);
	const coordinator = path.join(os.tmpdir(), `request-contract-coordinator-${crypto.randomBytes(8).toString("hex")}.cjs`);
	const corePath = path.resolve(__dirname, "..", "..", "..", ".agents", "hooks", "core", "request-contract.js");
	fs.writeFileSync(worker, `const core=require(${JSON.stringify(corePath)});const [mode,cwd,client,session,prompt]=process.argv.slice(2);const event=mode==="start"?{client,clientVersion:client==="claude"?"2.1.207":"0.144.1",eventName:"SessionStart",sessionId:session,cwd}:{client,eventName:"UserPromptSubmit",sessionId:session,cwd,prompt,origin:"native_user"};const result=core.handleEvent(event);if(mode==="start"&&result.kind!=="context")process.exit(2);if(mode==="prompt"&&result.code!=="request_contract_missing_genesis")process.exit(3);\n`);
	fs.writeFileSync(coordinator, 'const cp=require("child_process");const [worker,cwd,mode]=process.argv.slice(2);const specs=mode==="start"?[["start",cwd,"claude","A"],["start",cwd,"codex","B"]]:Array.from({length:6},(_,i)=>["prompt",cwd,"codex","Q","prompt-"+(i+1)]);Promise.all(specs.map(args=>new Promise(resolve=>{const child=cp.spawn(process.execPath,[worker,...args],{stdio:["ignore","ignore","pipe"]});let stderr="";child.stderr.on("data",x=>stderr+=x);child.on("exit",code=>resolve({code,stderr}));}))).then(results=>{for(const result of results)if(result.code!==0){process.stderr.write(result.stderr);process.exit(result.code)}process.exit(0)});\n');
	let result = cp.spawnSync(process.execPath, [coordinator, worker, fx.cwd, "start"], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(core.listUnits(fx.cwd).length, 2);
	for (const id of core.listUnits(fx.cwd)) {
		const unit = { id, paths: core.unitPaths(fx.cwd, id) };
		assert.equal(core.readJson(unit.paths.head).session_bindings.length, 1);
	}

	fx = fixture();
	result = cp.spawnSync(process.execPath, [coordinator, worker, fx.cwd, "prompt"], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" });
	assert.equal(result.status, 0, result.stderr);
	const quarantine = core.listUnconsumedQuarantine(fx.cwd);
	assert.equal(quarantine.length, 1);
	assert.equal(quarantine[0].head.count, 6);
	fs.unlinkSync(worker);
	fs.unlinkSync(coordinator);
});
