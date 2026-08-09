"use strict";
module.exports = function createRequestContractModule(api) {
const {
	fs, path, cp, VERSION, ZERO_HASH, sha256, publicKeyFingerprint, opaqueId,
	canonicalJson, ensureDir, durableRename, secureJson, appendJsonl, readJson, requiredJson, optionalJson,
	stateDigest, readJsonlStrict, normalizeRel, loadConfig, loadAuthorityKey, loadReviewerKey, loadReviewRunnerKey, harnessRoot,
	governed, unitPaths, processIdentity, withUnitLock, withRepositoryLock, transactionPath, applySourceTransaction, applySessionTransaction,
	assertUnitMutable, listUnits, findUnit, unresolvedUnits, validateSuccessfulHandoffsBeforeGenesis,
} = api;
function captureWorkspaceOccurrences(...args) { return api.captureWorkspaceOccurrences(...args); }
function addSessionBinding(...args) { return api.addSessionBinding(...args); }
function pathExcluded(...args) { return api.pathExcluded(...args); }
function governedWorkspacePath(...args) { return api.governedWorkspacePath(...args); }
function setManifestEntry(...args) { return api.setManifestEntry(...args); }
function walkEntry(...args) { return api.walkEntry(...args); }
function git(...args) { return api.git(...args); }
function gitBuffer(...args) { return api.gitBuffer(...args); }
function gitStrict(...args) { return api.gitStrict(...args); }
function gitBufferStrict(...args) { return api.gitBufferStrict(...args); }
function parseGitTree(...args) { return api.parseGitTree(...args); }
function gitIndexMetadata(...args) { return api.gitIndexMetadata(...args); }
function referenceRepositoryDigest(...args) { return api.referenceRepositoryDigest(...args); }
function workspaceRepositoryDigest(...args) { return api.workspaceRepositoryDigest(...args); }
function referenceManifest(...args) { return api.referenceManifest(...args); }
function workspaceManifest(...args) { return api.workspaceManifest(...args); }
function diffManifests(...args) { return api.diffManifests(...args); }

function quarantineRoot(cwd) {
	return path.join(harnessRoot(cwd), "quarantine");
}

function listQuarantine(cwd) {
	const dir = quarantineRoot(cwd);
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => {
				const item = { id: e.name, dir: path.join(dir, e.name), head: readJson(path.join(dir, e.name, "head.json")) };
				if (!item.head || typeof item.head !== "object") item.corrupt = "quarantine_head_corrupt";
				return item;
				});
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw Object.assign(new Error("request-contract quarantine storage cannot be read"), { code: "quarantine_storage_unreadable", cause: error });
	}
}

function quarantineAdoptionProjection(adoption) {
	return {
		version: adoption && adoption.version,
		quarantine_id: adoption && adoption.quarantine_id,
		chain_head: adoption && adoption.chain_head,
		count: adoption && adoption.count,
		source_ids: adoption && adoption.source_ids,
		consumed_by_unit: adoption && adoption.consumed_by_unit,
	};
}

function findQuarantineAdoption(cwd, q, verified) {
	for (const id of listUnits(cwd)) {
		const head = readJson(unitPaths(cwd, id).head);
		for (const adoption of head && head.adopted_quarantines || []) {
			const expected = {
				version: VERSION,
				quarantine_id: q.id,
				chain_head: q.head.chain_head,
				count: q.head.count,
				source_ids: verified.records.map((record) => record.source_id),
				consumed_by_unit: id,
			};
			if (canonicalJson(quarantineAdoptionProjection(adoption)) === canonicalJson(expected) && adoption.consumption_digest === sha256(canonicalJson(expected))) return { adoption, head };
		}
	}
	return null;
}

function listUnconsumedQuarantine(cwd) {
	const unresolved = [];
	for (const q of listQuarantine(cwd)) {
		if (q.corrupt) {
			unresolved.push(q);
			continue;
		}
		const verified = verifyQuarantineChain(q);
		if (!verified.ok) {
			q.corrupt = verified.errors[0] || "quarantine_chain_corrupt";
			unresolved.push(q);
			continue;
		}
		const adoption = findQuarantineAdoption(cwd, q, verified);
		if (q.head.consumed === true) {
			const expectedDigest = adoption && adoption.adoption.consumption_digest;
			if (!adoption || q.head.consumed_by_unit !== adoption.adoption.consumed_by_unit || q.head.consumption_digest !== expectedDigest) {
				q.corrupt = "quarantine_consumption_unbound";
				unresolved.push(q);
			}
			continue;
		}
		if (adoption) {
			q.head.consumed = true;
			q.head.consumed_by_unit = adoption.adoption.consumed_by_unit;
			q.head.consumption_digest = adoption.adoption.consumption_digest;
			q.head.consumed_at = q.head.consumed_at || Date.now();
			secureJson(path.join(q.dir, "head.json"), q.head);
			continue;
		}
		unresolved.push(q);
	}
	return unresolved;
}

function verifyQuarantineChain(q) {
	const errors = [];
	if (!q || q.corrupt || !q.head) return { ok: false, errors: [q && q.corrupt || "quarantine_head_corrupt"], records: [] };
	let records = [];
	try {
		records = readJsonlStrict(path.join(q.dir, "sources.jsonl"), "quarantine_source_corrupt", { allowMissing: true });
	} catch (error) {
		return { ok: false, errors: [error.code], records: [] };
	}
	let prev = ZERO_HASH;
	for (let index = 0; index < records.length; index++) {
		const r = records[index];
		const base = { version: r.version, source_id: r.source_id, seq: r.seq, ts: r.ts, origin: r.origin, prompt_digest: r.prompt_digest, prev_hash: r.prev_hash };
		if (r.seq !== index + 1) errors.push("quarantine_sequence_gap");
		if (r.prev_hash !== prev) errors.push("quarantine_prev_hash_mismatch");
		if (sha256(r.prompt || "") !== r.prompt_digest) errors.push("quarantine_prompt_digest_mismatch");
		if (sha256(canonicalJson(base)) !== r.record_hash) errors.push("quarantine_record_hash_mismatch");
		prev = r.record_hash;
	}
	if (records.length !== q.head.count) errors.push("quarantine_head_count_mismatch");
	if ((records.length ? prev : ZERO_HASH) !== q.head.chain_head) errors.push("quarantine_head_digest_mismatch");
	return { ok: errors.length === 0, errors: [...new Set(errors)], records };
}

function appendQuarantine(cwd, client, sessionId, prompt, now = Date.now(), origin = "ambiguous") {
	return withRepositoryLock(cwd, () => appendQuarantineUnlocked(cwd, client, sessionId, prompt, now, origin), now);
}

function recoverQuarantineHead(q) {
	let records;
	try {
		records = readJsonlStrict(path.join(q.dir, "sources.jsonl"), "quarantine_source_corrupt", { allowMissing: true });
	} catch (error) {
		throw Object.assign(new Error(error.message), { code: error.code });
	}
	let prev = ZERO_HASH;
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		const base = { version: record.version, source_id: record.source_id, seq: record.seq, ts: record.ts, origin: record.origin, prompt_digest: record.prompt_digest, prev_hash: record.prev_hash };
		if (record.seq !== index + 1 || record.prev_hash !== prev || sha256(record.prompt || "") !== record.prompt_digest || sha256(canonicalJson(base)) !== record.record_hash) {
			throw Object.assign(new Error("quarantine chain is not recoverable"), { code: "quarantine_chain_corrupt" });
		}
		prev = record.record_hash;
	}
	if (q.head.count > records.length) throw Object.assign(new Error("quarantine head is ahead of its log"), { code: "quarantine_chain_corrupt" });
	if (q.head.count !== records.length || q.head.chain_head !== (records.length ? prev : ZERO_HASH)) {
		q.head.count = records.length;
		q.head.chain_head = records.length ? prev : ZERO_HASH;
		secureJson(path.join(q.dir, "head.json"), q.head);
	}
	return q;
}

function appendQuarantineUnlocked(cwd, client, sessionId, prompt, now = Date.now(), origin = "ambiguous") {
	ensureDir(quarantineRoot(cwd));
	let q = listUnconsumedQuarantine(cwd).find((x) => x.head && x.head.client === client && x.head.session_id === sessionId);
	if (!q) {
		const id = opaqueId();
		const dir = path.join(quarantineRoot(cwd), id);
		ensureDir(dir);
		q = { id, dir, head: { version: VERSION, id, client, session_id: sessionId, count: 0, chain_head: ZERO_HASH, consumed: false } };
		secureJson(path.join(q.dir, "head.json"), q.head, { exclusive: true });
	}
	recoverQuarantineHead(q);
	const seq = q.head.count + 1;
	const sourceId = `SRC-${opaqueId()}`;
	const promptDigest = sha256(prompt);
	const base = { version: VERSION, source_id: sourceId, seq, ts: now, origin: origin === "native_user" ? "native_user" : "ambiguous", prompt_digest: promptDigest, prev_hash: q.head.chain_head };
	const record = { ...base, prompt, record_hash: sha256(canonicalJson(base)) };
	appendJsonl(path.join(q.dir, "sources.jsonl"), record);
	q.head.count = seq;
	q.head.chain_head = record.record_hash;
	secureJson(path.join(q.dir, "head.json"), q.head);
	return { sourceId, quarantineId: q.id };
}

function createGenesis(cwd, client, sessionId, now = Date.now(), opts = {}) {
	return withRepositoryLock(cwd, () => createGenesisUnlocked(cwd, client, sessionId, now, opts), now);
}

function createGenesisUnlocked(cwd, client, sessionId, now = Date.now(), opts = {}) {
	const quarantined = listUnconsumedQuarantine(cwd);
	const corrupt = quarantined.flatMap((q) => verifyQuarantineChain(q).errors);
	if (corrupt.length) throw Object.assign(new Error(corrupt.join(", ")), { code: "quarantine_chain_corrupt", errors: corrupt });
	if (quarantined.length && !opts.adoptQuarantine) throw Object.assign(new Error("unconsumed quarantine chains"), { code: "unconsumed_quarantine" });
	const existing = findUnit(cwd, client, sessionId);
	if (existing) return existing;
	const unresolved = unresolvedUnits(cwd);
	if (unresolved.some((candidate) => candidate.corrupt)) {
		throw Object.assign(new Error("corrupt unresolved request lineage"), { code: "corrupt_unresolved_unit" });
	}
	validateSuccessfulHandoffsBeforeGenesis(cwd);
	const config = loadConfig(cwd);
	if (config.errors.length) throw Object.assign(new Error(config.errors.join(", ")), { code: "request_contract_config_invalid", errors: config.errors });
	const authorityKey = loadAuthorityKey(cwd, config);
	const reviewerKey = loadReviewerKey(cwd, config);
	const reviewRunnerKey = loadReviewRunnerKey(cwd, config);
	const credentialIds = [config.authority.credential_id, config.reviewer.credential_id, config.review_runner.credential_id];
	const keyFingerprints = [authorityKey, reviewerKey, reviewRunnerKey].filter(Boolean).map(publicKeyFingerprint);
	const pinnedExecutables = [config.reviewer.allowed_attestor_digests, config.review_runner.allowed_reviewer_digests, config.review_runner.allowed_sandbox_digests, config.review_runner.allowed_attestor_digests];
	if (!authorityKey || !reviewerKey || !reviewRunnerKey || credentialIds.some((id) => !id) || new Set(credentialIds).size !== credentialIds.length || new Set(keyFingerprints).size !== 3 || pinnedExecutables.some((digests) => !digests.length || digests.some((digest) => !/^[a-f0-9]{64}$/.test(digest)))) {
		throw Object.assign(new Error("governed mode requires three distinct pinned authority, reviewer, and review-runner credentials"), { code: "request_contract_credentials_unprovisioned" });
	}
	const baseline = referenceManifest(cwd, config);
	const genesisWorkspace = workspaceManifest(cwd, config);
	const id = opaqueId();
	const p = unitPaths(cwd, id);
	const stagingUnit = `${p.unit}.creating.${opaqueId()}`;
	const staged = Object.fromEntries(Object.entries(p).map(([key, value]) => [key, typeof value === "string" && value.startsWith(p.unit) ? stagingUnit + value.slice(p.unit.length) : value]));
	ensureDir(staged.unit);
	const initialState = { version: VERSION, baseline: baseline.manifest, baseline_digest: baseline.digest, genesis_workspace_digest: genesisWorkspace.digest, observed_workspace: baseline.manifest, occurrences: [], stop: null };
	const head = {
		version: VERSION,
		unit_id: id,
		client,
		session_id: sessionId,
		session_bindings: [{ client, session_id: sessionId, host_process_ids: [opts.hostProcessId || process.pid], host_process_identities: [opts.hostProcessIdentity || processIdentity(opts.hostProcessId || process.pid)].filter(Boolean) }],
		client_versions: opts.clientVersion ? { [client]: opts.clientVersion } : {},
		created_at: now,
		lifecycle: "active",
		config_digest: config.digest,
		authority_key_fingerprint: authorityKey ? publicKeyFingerprint(authorityKey) : null,
		reviewer_key_fingerprint: publicKeyFingerprint(reviewerKey),
		review_runner_key_fingerprint: publicKeyFingerprint(reviewRunnerKey),
		source_count: 0,
		source_head: ZERO_HASH,
		scope_epoch: 0,
		work_revision: 0,
		contract_digest: null,
		state_digest: stateDigest(initialState),
	};
	secureJson(staged.head, head, { exclusive: true });
	secureJson(staged.state, initialState, { exclusive: true });
	durableRename(staged.unit, p.unit);
	const unit = { id, paths: p, head };
	captureWorkspaceOccurrences(unit, cwd);
	if (opts.adoptQuarantine) adoptQuarantine(unit, cwd, now);
	return unit;
}

function adoptQuarantine(unit, cwd, now = Date.now()) {
	return withRepositoryLock(cwd, () => withUnitLock(unit, () => adoptQuarantineUnlocked(unit, cwd, now), now), now);
}

function adoptQuarantineUnlocked(unit, cwd, now = Date.now()) {
	const bindingHead = requiredJson(unit.paths.head, "unit_head_corrupt");
	const boundSessions = new Set((bindingHead.session_bindings || [{ client: bindingHead.client, session_id: bindingHead.session_id }])
		.map((binding) => `${binding.client}\u0000${binding.session_id}`));
	for (const q of listUnconsumedQuarantine(cwd).sort((a, b) => a.id.localeCompare(b.id))) {
		recoverQuarantineHead(q);
		const verified = verifyQuarantineChain(q);
		if (!verified.ok) throw Object.assign(new Error(verified.errors.join(", ")), { code: "quarantine_chain_corrupt", errors: verified.errors });
		if (q.corrupt) throw Object.assign(new Error(q.corrupt), { code: q.corrupt });
		if (!boundSessions.has(`${q.head.client}\u0000${q.head.session_id}`)) continue;
		const destinationHead = requiredJson(unit.paths.head, "unit_head_corrupt");
		const destinationChain = verifySourceChain(unit.paths, destinationHead);
		if (!destinationChain.ok) throw Object.assign(new Error(destinationChain.errors.join(", ")), { code: "source_log_corrupt", errors: destinationChain.errors });
		const destinationSources = new Map(destinationChain.records.map((record) => [record.source_id, record]));
		for (const record of verified.records) {
			const existing = destinationSources.get(record.source_id);
			if (existing) {
				if (existing.prompt_digest !== record.prompt_digest || existing.prompt !== record.prompt) throw Object.assign(new Error("quarantine source ID collides with different destination content"), { code: "quarantine_adoption_collision" });
				continue;
			}
			const appended = appendSourceUnlocked(unit, record.prompt || "", record.origin || "ambiguous", record.ts || now, { sourceId: record.source_id });
			destinationSources.set(appended.source_id, appended);
		}
		const adoptedHead = requiredJson(unit.paths.head, "unit_head_corrupt");
		const adoption = {
			version: VERSION,
			quarantine_id: q.id,
			chain_head: q.head.chain_head,
			count: q.head.count,
			source_ids: verified.records.map((record) => record.source_id),
			consumed_by_unit: unit.id,
		};
		adoption.consumption_digest = sha256(canonicalJson(quarantineAdoptionProjection(adoption)));
		adoptedHead.adopted_quarantines = adoptedHead.adopted_quarantines || [];
		const priorAdoption = adoptedHead.adopted_quarantines.find((item) => item.quarantine_id === q.id);
		if (priorAdoption && canonicalJson(priorAdoption) !== canonicalJson(adoption)) throw Object.assign(new Error("quarantine adoption binding conflicts with destination head"), { code: "quarantine_adoption_collision" });
		if (!priorAdoption) adoptedHead.adopted_quarantines.push(adoption);
		secureJson(unit.paths.head, adoptedHead);
		q.head.consumed = true;
		q.head.consumed_by_unit = unit.id;
		q.head.consumed_at = now;
		q.head.consumption_digest = adoption.consumption_digest;
		secureJson(path.join(q.dir, "head.json"), q.head);
	}
	return unit;
}

function verifySourceChain(paths, head) {
	let records;
	try {
		records = readJsonlStrict(paths.sources, "source_log_corrupt", { allowMissing: true });
	} catch (error) {
		return { ok: false, errors: [error.code], records: [] };
	}
	const errors = [];
	let prev = ZERO_HASH;
	for (let i = 0; i < records.length; i++) {
		const r = records[i];
		const base = { version: r.version, source_id: r.source_id, seq: r.seq, ts: r.ts, origin: r.origin, prompt_digest: r.prompt_digest, prev_hash: r.prev_hash };
		if (r.seq !== i + 1) errors.push("source_sequence_gap");
		if (r.prev_hash !== prev) errors.push("source_prev_hash_mismatch");
		if (sha256(r.prompt || "") !== r.prompt_digest) errors.push("source_prompt_digest_mismatch");
		if (sha256(canonicalJson(base)) !== r.record_hash) errors.push("source_record_hash_mismatch");
		prev = r.record_hash;
	}
	if (records.length !== head.source_count) errors.push("source_head_count_mismatch");
	if ((records.length ? prev : ZERO_HASH) !== head.source_head) errors.push("source_head_digest_mismatch");
	return { ok: errors.length === 0, errors: [...new Set(errors)], records };
}

function appendSource(unit, prompt, origin = "ambiguous", now = Date.now(), opts = {}) {
	return withUnitLock(unit, () => appendSourceUnlocked(unit, prompt, origin, now, opts), now);
}

function appendSourceUnlocked(unit, prompt, origin = "ambiguous", now = Date.now(), opts = {}) {
	assertUnitMutable(unit);
	const head = requiredJson(unit.paths.head, "unit_head_corrupt");
	const existingChain = verifySourceChain(unit.paths, head);
	if (!existingChain.ok) throw Object.assign(new Error(existingChain.errors.join(", ")), { code: "source_log_corrupt", errors: existingChain.errors });
	if (opts.sourceId) {
		const existing = existingChain.records.find((record) => record.source_id === opts.sourceId);
		if (existing) {
			if (existing.prompt_digest !== sha256(prompt)) throw Object.assign(new Error("imported source id conflicts with existing source"), { code: "source_import_conflict" });
			return existing;
		}
	}
	const seq = head.source_count + 1;
	const sourceId = opts.sourceId || `SRC-${opaqueId()}`;
	const base = {
		version: VERSION,
		source_id: sourceId,
		seq,
		ts: now,
		origin: origin || "ambiguous",
		prompt_digest: sha256(prompt),
		prev_hash: head.source_head,
	};
	const record = { ...base, prompt, record_hash: sha256(canonicalJson(base)) };
	const nextHead = { ...head, source_count: seq, source_head: record.record_hash, work_revision: head.work_revision + 1 };
	const transaction = { version: VERSION, kind: "source", created_at: now, expected: { count: head.source_count, chain_head: head.source_head }, record, head: nextHead };
	secureJson(transactionPath(unit, "source"), transaction, { exclusive: true });
	if (opts.afterTransactionPrepared) opts.afterTransactionPrepared(transaction);
	applySourceTransaction(unit, transaction);
	unit.head = nextHead;
	return record;
}

	return {
		quarantineRoot,
		listQuarantine,
		quarantineAdoptionProjection,
		findQuarantineAdoption,
		listUnconsumedQuarantine,
		verifyQuarantineChain,
		appendQuarantine,
		recoverQuarantineHead,
		appendQuarantineUnlocked,
		createGenesis,
		createGenesisUnlocked,
		adoptQuarantine,
		adoptQuarantineUnlocked,
		verifySourceChain,
		appendSource,
		appendSourceUnlocked,
	};
};
