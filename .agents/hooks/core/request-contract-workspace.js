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

function addSessionBinding(unit, client, sessionId, clientVersion = null, hostProcessId = null, hostProcessIdentity = null) {
	const cwd = path.dirname(path.dirname(path.dirname(path.dirname(unit.paths.unit))));
	return withRepositoryLock(cwd, () => {
		const existing = findUnit(cwd, client, sessionId);
		if (existing && (existing.error || existing.id !== unit.id)) {
			throw Object.assign(new Error("runtime session is already bound to another active lineage"), { code: "session_already_bound" });
		}
		return withUnitLock(unit, () => {
			assertUnitMutable(unit);
			const head = JSON.parse(JSON.stringify(requiredJson(unit.paths.head, "unit_head_corrupt")));
			head.session_bindings = head.session_bindings || [{ client: head.client, session_id: head.session_id }];
			const previousSessionBinding = head.session_bindings.find((b) => b.client === client && b.session_id === sessionId) || {};
			let sessionBinding = head.session_bindings.find((b) => b.client === client && b.session_id === sessionId);
			const added = !sessionBinding;
			if (!sessionBinding) {
				sessionBinding = { client, session_id: sessionId };
				head.session_bindings.push(sessionBinding);
			}
			sessionBinding.host_process_ids = [...new Set([...(sessionBinding.host_process_ids || []), hostProcessId].filter((value) => Number.isInteger(value) && value > 0))];
			sessionBinding.host_process_identities = [...new Set([...(sessionBinding.host_process_identities || []), hostProcessIdentity].filter(Boolean))];
			head.client_versions = head.client_versions || {};
			const clientVersionChanged = Boolean(clientVersion && head.client_versions[client] && head.client_versions[client] !== clientVersion);
			if (clientVersion) head.client_versions[client] = clientVersion;
			let binding = optionalJson(unit.paths.binding, null, "binding_state_corrupt");
			const hostProcessChanged = (hostProcessId && !(previousSessionBinding.host_process_ids || []).includes(hostProcessId))
				|| (hostProcessIdentity && !(previousSessionBinding.host_process_identities || []).includes(hostProcessIdentity));
			if (added || clientVersionChanged || hostProcessChanged) {
				head.work_revision += 1;
				if (binding) binding = { ...binding, binding_epoch: binding.binding_epoch + 1 };
			}
			const transaction = { version: VERSION, kind: "session", created_at: Date.now(), head, binding };
			secureJson(transactionPath(unit, "session"), transaction, { exclusive: true });
			applySessionTransaction(unit, transaction);
			unit.head = head;
			return unit;
		});
	});
}

function pathExcluded(rel, exclusions) {
	rel = normalizeRel(rel);
	return exclusions.some((x) => (x.includes("/") ? rel === x || rel.startsWith(x + "/") : rel.split("/").includes(x)));
}

function governedWorkspacePath(cwd, rel, config, opts = {}) {
	rel = normalizeRel(rel);
	if (!rel || path.isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.includes("/../")) return { ok: false, reason: "invalid" };
	if (pathExcluded(rel, config.exclusions)) return { ok: false, reason: "excluded" };
	const rooted = config.product_roots.some((root) => !root || root === "." || rel === root || rel.startsWith(root + "/"));
	if (!rooted) return { ok: false, reason: "outside_product_roots" };
	const absolute = path.resolve(cwd, rel);
	if (absolute !== cwd && !absolute.startsWith(cwd + path.sep)) return { ok: false, reason: "escape" };
	if (opts.physical) {
		try {
			const physicalRoot = fs.realpathSync.native(cwd);
			const physical = fs.realpathSync.native(absolute);
			if (physical !== physicalRoot && !physical.startsWith(physicalRoot + path.sep)) return { ok: false, reason: "symlink_escape" };
			let cursor = cwd;
			for (const segment of rel.split("/")) {
				cursor = path.join(cursor, segment);
				if (fs.lstatSync(cursor).isSymbolicLink()) return { ok: false, reason: "symlink" };
			}
			return { ok: true, rel, absolute, physical };
		} catch {
			return { ok: false, reason: "unreadable" };
		}
	}
	return { ok: true, rel, absolute };
}

function setManifestEntry(out, rel, value) {
	if (Object.prototype.hasOwnProperty.call(out, rel)) throw Object.assign(new Error("workspace paths collide after canonicalization"), { code: "workspace_manifest_path_collision", path: rel });
	out[rel] = value;
}

function walkEntry(abs, rel, exclusions, out, gitlinks = new Set(), cwd = "", gitModes = new Map()) {
	if (pathExcluded(rel, exclusions)) return;
	if (rel && gitlinks.has(rel)) {
		const submodule = path.join(cwd, rel);
		const initialized = fs.existsSync(path.join(submodule, ".git"));
		const commit = initialized ? gitStrict(submodule, ["rev-parse", "HEAD"]) : null;
		const digest = initialized ? workspaceRepositoryDigest(submodule, exclusions) : sha256(canonicalJson({ missing: true }));
		const reference = initialized ? referenceRepositoryDigest(submodule, commit, exclusions) : null;
		setManifestEntry(out, rel, { type: "gitlink", commit, dirty: !reference || digest !== reference, dirty_digest: digest });
		return;
	}
	let st;
	try {
		st = fs.lstatSync(abs);
	} catch (error) {
		throw Object.assign(new Error("workspace entry cannot be inspected"), { code: "workspace_manifest_unreadable", operation: "lstat", path: rel || ".", cause: error });
	}
	if (st.isSymbolicLink()) {
		setManifestEntry(out, rel, { type: "symlink", mode: process.platform === "win32" ? 0o777 : st.mode & 0o777, link: fs.readlinkSync(abs) });
		return;
	}
	if (st.isFile()) {
		setManifestEntry(out, rel, { type: "file", mode: process.platform === "win32" ? (gitModes.get(rel) || 0o644) : st.mode & 0o777, size: st.size, digest: sha256(fs.readFileSync(abs)) });
		return;
	}
	if (!st.isDirectory()) throw Object.assign(new Error("workspace entry type is unsupported"), { code: "workspace_manifest_unsupported_type", path: rel || "." });
	let entries = [];
	try {
		entries = fs.readdirSync(abs, { withFileTypes: true });
	} catch (error) {
		throw Object.assign(new Error("workspace directory cannot be read"), { code: "workspace_manifest_unreadable", operation: "readdir", path: rel || ".", cause: error });
	}
	for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (e.name === ".git") continue;
		const childRel = normalizeRel(path.posix.join(rel, e.name));
		walkEntry(path.join(abs, e.name), childRel, exclusions, out, gitlinks, cwd, gitModes);
	}
}

function git(cwd, args) {
	try {
		return cp.execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
	} catch {
		return "";
	}
}

function gitBuffer(cwd, args) {
	try {
		return cp.execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
	} catch {
		return Buffer.alloc(0);
	}
}

function gitStrict(cwd, args) {
	try {
		return cp.execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
	} catch (error) {
		throw Object.assign(new Error("Git manifest operation failed"), { code: "workspace_manifest_git_error", operation: args[0], cause: error });
	}
}

function gitBufferStrict(cwd, args) {
	try {
		return cp.execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
	} catch (error) {
		throw Object.assign(new Error("Git manifest operation failed"), { code: "workspace_manifest_git_error", operation: args[0], cause: error });
	}
}

function parseGitTree(raw) {
	const parsed = [];
	const paths = new Set();
	for (const entry of raw.toString("utf8").split("\0").filter(Boolean)) {
		const match = entry.match(/^(\d+)\s+(\S+)\s+([a-f0-9]+)\t([\s\S]+)$/);
		if (!match) throw Object.assign(new Error("Git tree output is malformed"), { code: "workspace_manifest_git_parse_error" });
		const [, mode, type, oid, rawPath] = match;
		const rel = normalizeRel(rawPath);
		if (!rel || paths.has(rel)) throw Object.assign(new Error("Git tree path set is invalid"), { code: "workspace_manifest_git_parse_error" });
		paths.add(rel);
		parsed.push({ mode, type, oid, rel });
	}
	return parsed;
}

function gitIndexMetadata(repo) {
	const links = new Set();
	const modes = new Map();
	const raw = gitBufferStrict(repo, ["ls-files", "-s", "-z"]);
	for (const entry of raw.toString("utf8").split("\0").filter(Boolean)) {
		const match = entry.match(/^(\d+) ([a-f0-9]+) (\d+)\t([\s\S]+)$/);
		if (!match) throw Object.assign(new Error("Git index output is malformed"), { code: "workspace_manifest_git_parse_error" });
		const rel = normalizeRel(match[4]);
		if (match[1] === "160000") links.add(rel);
		else modes.set(rel, match[1] === "100755" ? 0o755 : match[1] === "120000" ? 0o777 : 0o644);
	}
	return { links, modes };
}
function referenceRepositoryDigest(repo, commit, exclusions) {
	const files = {};
	const raw = gitBufferStrict(repo, ["ls-tree", "-rz", "--full-tree", "-r", commit]);
	for (const { mode, type, oid, rel } of parseGitTree(raw)) {
		if (pathExcluded(rel, exclusions)) continue;
		if (mode === "160000" || type === "commit") {
			const nested = path.join(repo, rel);
			setManifestEntry(files, rel, { type: "gitlink", commit: oid, dirty: false, dirty_digest: fs.existsSync(path.join(nested, ".git")) ? referenceRepositoryDigest(nested, oid, exclusions) : sha256(canonicalJson({ missing: true, commit: oid })) });
			continue;
		}
		const blob = gitBufferStrict(repo, ["cat-file", "blob", oid]);
		if (mode === "120000") setManifestEntry(files, rel, { type: "symlink", mode: 0o777, link: blob.toString("utf8") });
		else setManifestEntry(files, rel, { type: "file", mode: mode === "100755" ? 0o755 : 0o644, size: blob.length, digest: sha256(blob) });
	}
	return sha256(canonicalJson({ head: commit, index_digest: sha256(""), files }));
}

function workspaceRepositoryDigest(repo, exclusions) {
	if (!fs.existsSync(repo)) return sha256(canonicalJson({ missing: true }));
	const files = {};
	const { links: gitlinks, modes: gitModes } = gitIndexMetadata(repo);
	walkEntry(repo, "", exclusions, files, gitlinks, repo, gitModes);
	return sha256(canonicalJson({
		head: gitStrict(repo, ["rev-parse", "HEAD"]),
		index_digest: sha256(gitBufferStrict(repo, ["diff", "--cached", "--binary", "--no-ext-diff"])),
		files,
	}));
}

function referenceManifest(cwd, config = loadConfig(cwd)) {
	if (config.errors && config.errors.length) throw Object.assign(new Error(config.errors.join(", ")), { code: "request_contract_config_invalid", errors: config.errors });
	const files = {};
	const raw = gitBufferStrict(cwd, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
	for (const { mode, type, oid, rel } of parseGitTree(raw)) {
		if (!governedWorkspacePath(cwd, rel, config).ok) continue;
		if (mode === "160000" || type === "commit") {
			const submodule = path.join(cwd, rel);
			setManifestEntry(files, rel, { type: "gitlink", commit: oid, dirty: false, dirty_digest: fs.existsSync(path.join(submodule, ".git")) ? referenceRepositoryDigest(submodule, oid, config.exclusions) : sha256(canonicalJson({ missing: true, commit: oid })) });
			continue;
		}
		const blob = gitBufferStrict(cwd, ["cat-file", "blob", oid]);
		if (mode === "120000") setManifestEntry(files, rel, { type: "symlink", mode: 0o777, link: blob.toString("utf8") });
		else setManifestEntry(files, rel, { type: "file", mode: mode === "100755" ? 0o755 : 0o644, size: blob.length, digest: sha256(blob) });
	}
	const manifest = {
		version: VERSION,
		config_digest: config.digest,
		head: gitStrict(cwd, ["rev-parse", "HEAD"]),
		index_digest: sha256(""),
		submodules_digest: sha256(canonicalJson(Object.entries(files).filter(([, value]) => value.type === "gitlink").map(([rel, value]) => [rel, value.commit]))),
		files,
	};
	return { manifest, digest: sha256(canonicalJson(manifest)) };
}

function workspaceManifest(cwd, config = loadConfig(cwd)) {
	if (config.errors && config.errors.length) throw Object.assign(new Error(config.errors.join(", ")), { code: "request_contract_config_invalid", errors: config.errors });
	const files = {};
	const { links: gitlinks, modes: gitModes } = gitIndexMetadata(cwd);
	for (const root of config.product_roots) {
		if (!root || root === ".") {
			walkEntry(cwd, "", config.exclusions, files, gitlinks, cwd, gitModes);
			continue;
		}
		const rootPath = path.join(cwd, root);
		if (!fs.existsSync(rootPath)) setManifestEntry(files, root, { type: "missing" });
		else walkEntry(rootPath, root, config.exclusions, files, gitlinks, cwd, gitModes);
	}
	const manifest = {
		version: VERSION,
		config_digest: config.digest,
		head: gitStrict(cwd, ["rev-parse", "HEAD"]),
		index_digest: sha256(gitBufferStrict(cwd, ["diff", "--cached", "--binary", "--no-ext-diff"])),
		submodules_digest: sha256(canonicalJson(Object.entries(files).filter(([, value]) => value.type === "gitlink").map(([rel, value]) => [rel, value.commit]))),
		files,
	};
	return { manifest, digest: sha256(canonicalJson(manifest)) };
}

function diffManifests(before, after) {
	const out = [];
	const a = (before && before.files) || {};
	const b = (after && after.files) || {};
	for (const rel of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
		const av = a[rel] || null;
		const bv = b[rel] || null;
		if (canonicalJson(av) === canonicalJson(bv)) continue;
		out.push({ path: rel, kind: av && bv ? "modify" : av ? "delete" : "add", before: av, after: bv });
	}
	for (const field of ["head", "index_digest", "submodules_digest"]) {
		const av = before && before[field];
		const bv = after && after[field];
		if (av !== bv) out.push({ path: `@workspace/${field}`, kind: "metadata", before: av || null, after: bv || null });
	}
	return out;
}

function quarantineRoot(...args) { return api.quarantineRoot(...args); }
function listQuarantine(...args) { return api.listQuarantine(...args); }
function quarantineAdoptionProjection(...args) { return api.quarantineAdoptionProjection(...args); }
function findQuarantineAdoption(...args) { return api.findQuarantineAdoption(...args); }
function listUnconsumedQuarantine(...args) { return api.listUnconsumedQuarantine(...args); }
function verifyQuarantineChain(...args) { return api.verifyQuarantineChain(...args); }
function appendQuarantine(...args) { return api.appendQuarantine(...args); }
function recoverQuarantineHead(...args) { return api.recoverQuarantineHead(...args); }
function appendQuarantineUnlocked(...args) { return api.appendQuarantineUnlocked(...args); }
function createGenesis(...args) { return api.createGenesis(...args); }
function createGenesisUnlocked(...args) { return api.createGenesisUnlocked(...args); }
function adoptQuarantine(...args) { return api.adoptQuarantine(...args); }
function adoptQuarantineUnlocked(...args) { return api.adoptQuarantineUnlocked(...args); }
function verifySourceChain(...args) { return api.verifySourceChain(...args); }
function appendSource(...args) { return api.appendSource(...args); }
function appendSourceUnlocked(...args) { return api.appendSourceUnlocked(...args); }


	return {
		captureWorkspaceOccurrences,
		addSessionBinding,
		pathExcluded,
		governedWorkspacePath,
		setManifestEntry,
		walkEntry,
		git,
		gitBuffer,
		gitStrict,
		gitBufferStrict,
		parseGitTree,
		gitIndexMetadata,
		referenceRepositoryDigest,
		workspaceRepositoryDigest,
		referenceManifest,
		workspaceManifest,
		diffManifests,
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
