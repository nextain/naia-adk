"use strict";
// Plan gate responsibility: context.
const { AsyncLocalStorage } = require("async_hooks");
const gateConfigPin = require("./gate-config-pin.js");
const path = require("path");
const fs = require("fs");
const { discordConfirms } = require("./deploy-plan-discord.js");
const { validateReadOnlyScriptsConfig, verifyRepoFileGitClean } = require("./deploy-plan-readonly-policy.js");
const { sha256, readTargetFile, ROOT, resultFile } = require("./deploy-plan-common.js");

// 승인 확인은 비동기이며 검증 함수들은 동기식이다. 검증 범위마다 확인된 스냅샷만 전달한다.
const gateConfigContext = new AsyncLocalStorage();

async function approvedConfigAt(options, root) {
	const before = gateConfigPin.snapshotGateConfig(root);
	const approved = before ? await gateConfigPin.approvedGateConfig({ ...options, root, discordConfirms }) : null;
	const after = gateConfigPin.snapshotGateConfig(root);
	return approved && before && after && before.hash === approved.hash && after.hash === approved.hash ? { root, hash: approved.hash, config: approved.config } : null;
}

function withPolicyData(files, fn) { return gateConfigContext.run({ ...(gateConfigContext.getStore() || {}), policyData: files }, fn); }
function policyData(file) { const b=gateConfigContext.getStore()?.policyData?.get(file); return b?Buffer.from(b):undefined; }
function withRegisteredPolicyData(root,files,fn){return gateConfigContext.run({...gateConfigContext.getStore(),registeredSourceRoot:registeredRoot(root),policyData:files},fn);}
function withLegacyPolicyRoot(root,fn){return gateConfigContext.run({...gateConfigContext.getStore(),legacyPolicyRoot:registeredRoot(root)},fn);}


const PROFILE_ID = /^[a-z][a-z0-9_-]{0,63}$/;

function registeredRoot(root) {
	if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) throw new Error("A registered gate requires a canonical absolute directory");
	return root;
}

function registeredPolicyRoot(root) {
	registeredRoot(root);
	for (const name of gateConfigPin.GATE_CONFIG_FILES) {
		const file = path.join(root, name);
		if (fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error("Registered gate configuration must stay in its site root");
	}
	return root;
}

function siteAllowlist(root, verifyCommit = false) {
	const dir = path.join(root, "config"), file = path.join(dir, "deploy-gate.json");
	for (const [target, directory] of [[dir, true], [file, false]]) {
		let st;
		try { st = fs.lstatSync(target); }
		catch (error) { if (error.code === "ENOENT") return { digest: null, items: [] }; throw error; }
		if (!(directory ? st.isDirectory() : st.isFile())) throw new Error("Gate policy must be a regular file in its registered root");
	}
	const bytes = fs.readFileSync(file);
	const policy = validateReadOnlyScriptsConfig(JSON.parse(bytes));
	if (!policy.ok) throw new Error(policy.why);
	if (verifyCommit && policy.items.length) {
		const clean = verifyRepoFileGitClean(file, null, "config/deploy-gate.json");
		if (!clean.ok || clean.sha256 !== sha256(bytes)) throw new Error("Registered read-only gate policy differs from its committed bytes");
	}
	return { digest: sha256(bytes), items: policy.items };
}

// Observe the site's policy bytes so edits invalidate open reviews. Strict review
// never interprets these bytes as a reviewer setting or a command exception.
function strictPolicyFileDigest(root, name) {
	const file = path.join(root, name);
	let current = root;
	for (const part of name.split("/")) {
		current = path.join(current, part);
		let stat;
		try { stat = fs.lstatSync(current); }
		catch (error) { if (error.code === "ENOENT") return null; throw error; }
		if (current === file ? !stat.isFile() : !stat.isDirectory()) throw new Error("Strict gate policy files must stay in their registered site root");
	}
	return readTargetFile(root, name).digest;
}

function strictReviewPolicy(root) {
	const inputs = gateConfigPin.GATE_CONFIG_FILES.map(name => [name, strictPolicyFileDigest(root, name)]);
	return {
		root, strictDefaults: true, config: null,
		hash: sha256(JSON.stringify(["gate-review/strict-defaults/v1", inputs])),
		allowlist: { digest: strictPolicyFileDigest(root, "config/deploy-gate.json"), items: [] },
	};
}

async function withGateConfig(options, fn) {
	const root = path.resolve(options.root || ROOT);
	const trusted = await approvedConfigAt(options, root);
	if (options.reviewProfiles === undefined) {
		if (options.admissionProfile !== undefined) throw new Error("An admission identity requires registered review profiles");
		const data=gateConfigContext.getStore()?.policyData;
        return gateConfigContext.run(data?{...(trusted||{}),policyData:data,...(gateConfigContext.getStore()?.legacyPolicyRoot?{legacyPolicyRoot:gateConfigContext.getStore().legacyPolicyRoot}:{}),...(gateConfigContext.getStore()?.registeredSourceRoot?{registeredSourceRoot:gateConfigContext.getStore().registeredSourceRoot}:{})}:trusted,fn);
	}
	registeredRoot(root);
	if (!Array.isArray(options.reviewProfiles) || !options.reviewProfiles.length) throw new Error("reviewProfiles must register at least one gate");
	const profiles = [], ids = new Set(), roots = new Set();
	for (const entry of options.reviewProfiles) {
		const site = registeredRoot(entry?.root);
		if (typeof entry?.id !== "string" || !PROFILE_ID.test(entry.id) || ids.has(entry.id) || roots.has(site)) throw new Error("Each gate requires a distinct profile ID and site root");
		ids.add(entry.id); roots.add(site);
		if (entry.policy === "strict-defaults") {
			profiles.push({ ...strictReviewPolicy(site), id: entry.id });
		} else {
			if (entry.policy !== undefined && entry.policy !== "approved-config") throw new Error(`Gate ${entry.id} has an unknown review policy`);
			const policy = await approvedConfigAt(entry, registeredPolicyRoot(site));
			if (!policy) throw new Error(`Gate ${entry.id} has no current approved policy`);
			profiles.push({ ...policy, id: entry.id, approverId: entry.approverId, allowlist: siteAllowlist(site, true) });
		}
	}
	profiles.sort((a, b) => a.id < b.id ? -1 : 1);
	let admissionDomain = null;
	if (options.admissionProfile !== undefined) {
		const profile = profiles.find(item => item.id === options.admissionProfile);
		if (!profile) throw new Error("Admission identity must name a required registered review profile");
		admissionDomain = sha256(JSON.stringify(["gate-admission/v1", profile.id, profile.root, profile.hash, profile.allowlist.digest, profile.approverId]));
	}
	const registrationSha=options.executionRegistrationSha256;
 if(registrationSha!==undefined&&!/^[a-f0-9]{64}$/.test(registrationSha))throw new Error("Invalid execution registration SHA");
 if(registrationSha&&admissionDomain)admissionDomain=sha256(JSON.stringify(["registered-gate/v2",admissionDomain,registrationSha]));
 return gateConfigContext.run({ root, owner: trusted, profiles, admissionDomain, executionRegistrationSha256:registrationSha, admissionProfile:options.admissionProfile, policyData:gateConfigContext.getStore()?.policyData, ...(gateConfigContext.getStore()?.registeredSourceRoot?{registeredSourceRoot:gateConfigContext.getStore().registeredSourceRoot}:{}) }, fn);
}

function registeredReviewProfiles(root, verifyCommits = false) {
	const ctx = gateConfigContext.getStore();
	if (!ctx?.profiles) return [];
	if (ctx.root !== path.resolve(root)) throw new Error("Plan root differs from the registered review scope");
	for (const p of ctx.profiles) {
		const current = p.strictDefaults ? strictReviewPolicy(registeredRoot(p.root)) : {
			hash: gateConfigPin.snapshotGateConfig(registeredPolicyRoot(p.root))?.hash, allowlist: siteAllowlist(p.root, verifyCommits),
		};
		if (current.hash !== p.hash || current.allowlist.digest !== p.allowlist.digest) throw new Error(`Gate ${p.id} policy changed; reload its registered policy`);
	}
	return ctx.profiles;
}

function registeredReviewProfileIds(root) {
	return registeredReviewProfiles(root).map(profile => profile.id);
}

function withReviewProfile(root, id, fn) {
	const profile = registeredReviewProfiles(root).find(p => p.id === id);
	if (!profile) throw new Error("Unregistered review profile");
	return gateConfigContext.run({ ...gateConfigContext.getStore(), selected: profile }, fn);
}

function reviewProfileBinding(planFile, root) {
	const ctx = gateConfigContext.getStore();
	if (!ctx?.selected) return null;
	registeredReviewProfiles(root);
	const p = ctx.selected;
	const plan = resultFile(ctx.root, path.relative(ctx.root, path.resolve(planFile)));
	if (plan !== path.resolve(planFile)) throw new Error("Review requires a canonical plan within its registered root");
	const values=["gate-review/v1",p.id,p.root,p.hash,p.allowlist.digest,p.approverId,ctx.root,plan];
 if(ctx.executionRegistrationSha256)values.push("registered-gate/v2",ctx.executionRegistrationSha256);
 return{id:p.id,...(p.strictDefaults?{policy:"strict-defaults"}:{}),scope_sha256:sha256(JSON.stringify(values))};
}

function reviewRecordDirectory(gatesDir, create = false) {
	const p = gateConfigContext.getStore()?.selected;
	if (!p) return gatesDir;
	let dir = fs.realpathSync(gatesDir);
	for (const part of ["reviews", p.id]) {
		dir = path.join(dir, part);
		if (create) {
			try { fs.mkdirSync(dir); } catch (error) { if (error.code !== "EEXIST") throw error; }
		}
		if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== dir) throw new Error("Invalid gate review directory");
	}
	return dir;
}

function trustedGateConfig(root) {
	let ctx = gateConfigContext.getStore();
	if (ctx?.profiles) {
		registeredReviewProfiles(root);
		if (ctx.selected) return ctx.selected.config;
		ctx = ctx.owner;
	}
	if (!ctx || ctx.root !== path.resolve(root)) return null;
	const current = gateConfigPin.snapshotGateConfig(root);
	return current && current.hash === ctx.hash ? ctx.config : null;
}

// Extraction must not expose the previously private storage writer or mutable
// policy snapshots. Other responsibilities receive read-only detached views.
const copyContext = value => value == null ? value : structuredClone(value);
const gateConfigView = Object.freeze({ getStore: () => copyContext(gateConfigContext.getStore()) });

module.exports = {
	withRegisteredPolicyData,
	withLegacyPolicyRoot,
 withPolicyData, policyData,
	gateConfigView,
	approvedConfigAt,
	PROFILE_ID,
	registeredRoot,
	registeredPolicyRoot,
	siteAllowlist,
	strictPolicyFileDigest,
	strictReviewPolicy,
	withGateConfig,
	registeredReviewProfiles: (...args) => copyContext(registeredReviewProfiles(...args)),
	registeredReviewProfileIds,
	withReviewProfile,
	reviewProfileBinding,
	reviewRecordDirectory,
	trustedGateConfig: (...args) => copyContext(trustedGateConfig(...args)),
};
