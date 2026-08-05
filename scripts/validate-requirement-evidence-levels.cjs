#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const requirements = path.join(root, ".agents", "requirements");

function fail(message) { throw new Error(`requirement evidence levels: ${message}`); }
function inlineValues(text, key) {
	const match = text.match(new RegExp(`^${key}: \\[(.*)\\]$`, "m"));
	if (!match) fail(`missing inline list ${key}`);
	return match[1].split(",").map((item) => item.trim()).filter(Boolean);
}

function assertObligationCoverage(name, actual, declared) {
	for (const obligation of actual) if (!declared.has(obligation)) fail(`${name}: source obligation omitted from scope: ${obligation}`);
}

function assertInstalledEvidence(name, text, exists = fs.existsSync) {
	if (!/installed[- ]runtime/i.test(text)) return;
	const evidence = [...text.matchAll(/- \{ id: ([A-Z0-9_]+), level: ([a-z_]+), path: (?:"([^"]+)"|null), state: ([a-z_]+) \}/g)].map((match) => ({ id: match[1], level: match[2], path: match[3] ?? null, state: match[4] }));
	if (evidence.length === 0) fail(`${name}: installed-runtime claim has no classified evidence`);
	const installed = evidence.filter((item) => item.level === "installed_runtime");
	if (installed.length === 0) fail(`${name}: installed-runtime claim has only fixture evidence`);
	for (const item of installed) {
		if (item.path && /\b(?:fixture|fake|mock)\b/i.test(item.path)) fail(`${name}: fixture path is labelled installed_runtime`);
		if (/^status: verified$/m.test(text) && (item.state !== "present" || !item.path || !exists(path.join(root, item.path)))) fail(`${name}: verified status lacks installed-runtime receipt ${item.id}`);
	}
}

if (process.argv.includes("--self-test")) {
	for (const action of [
		() => assertObligationCoverage("fault-omission", new Set(["monitor", "cancel"]), new Set(["monitor"])),
		() => assertInstalledEvidence("fault-fixture", "installed-runtime\nstatus: active\n  - { id: EVD_FIXTURE, level: fixture_integration, path: \"tests/fake.test.mjs\", state: present }"),
		() => assertInstalledEvidence("fault-fake-installed", "installed-runtime\nstatus: verified\n  - { id: EVD_INSTALLED, level: installed_runtime, path: \"tests/fixtures/fake.json\", state: present }", () => true),
	]) {
		let rejected = false;
		try { action(); } catch { rejected = true; }
		if (!rejected) fail("fault injection was accepted");
	}
	console.log("requirement evidence levels self-test: PASS");
	process.exit(0);
}

for (const name of fs.readdirSync(requirements).filter((item) => /^(?:DSO|RCI|BMC|REQ|NDT)-\d+.*\.ya?ml$/.test(item)).sort()) {
	const file = path.join(requirements, name);
	const text = fs.readFileSync(file, "utf8");
	if (!/^source_provenance: ledger_resolved$/m.test(text)) continue;
	const sourceIds = inlineValues(text, "source_evidence");
	if (/^source_obligations:/m.test(text)) {
		const declared = new Set([...inlineValues(text, "source_obligations"), ...inlineValues(text, "deferred_obligations")]);
		const actual = new Set();
		for (const id of sourceIds) {
			const sourceName = fs.readdirSync(path.join(requirements, "sources")).find((candidate) => candidate.startsWith(`${id}-`) && candidate.endsWith(".json"));
			if (!sourceName) fail(`${name}: missing source ${id}`);
			const source = JSON.parse(fs.readFileSync(path.join(requirements, "sources", sourceName), "utf8"));
			for (const event of source.events ?? []) for (const obligation of event.obligations ?? []) actual.add(obligation);
		}
		assertObligationCoverage(name, actual, declared);
	}
	assertInstalledEvidence(name, text);
}

console.log("requirement evidence levels: PASS");
