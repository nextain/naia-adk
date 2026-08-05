import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const requirementsRoot = join(root, ".agents", "requirements");
const codeTraceEntry = /^    - \{ path: "([^"]+)", symbols: (\[[^\]]+\]), coverage: (full|partial|legacy_compatibility) \}$/;
const testTraceEntry = /^    - \{ path: "([^"]+)", symbol: "([^"]+)", coverage: (full|partial|legacy_compatibility) \}$/;

function regularRepositoryFile(requirementFile, relative) {
	assert.ok(!relative.startsWith("/") && !relative.includes("\\"), `${requirementFile}: unsafe repository path ${relative}`);
	const absolute = resolve(root, relative);
	assert.ok(absolute.startsWith(`${root}${sep}`), `${requirementFile}: path escapes repository ${relative}`);
	const stat = lstatSync(absolute, { throwIfNoEntry: false });
	assert.ok(stat?.isFile() && !stat.isSymbolicLink(), `${requirementFile}: missing or non-regular file ${relative}`);
	return absolute;
}

function assertCodeSymbols(requirementFile, relative, target, symbols) {
	assert.ok(Array.isArray(symbols) && symbols.length > 0 && new Set(symbols).size === symbols.length, `${requirementFile}: code symbols must be a non-empty unique list`);
	for (const symbol of symbols) {
		assert.ok(typeof symbol === "string" && symbol.length > 0 && symbol.length <= 160, `${requirementFile}: invalid code symbol in ${relative}`);
		const found = /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(symbol)
			? new RegExp(`(?<![A-Za-z0-9_$-])${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$-])`).test(target)
			: target.includes(symbol);
		assert.ok(found, `${requirementFile}: exact code symbol is absent from ${relative}: ${symbol}`);
	}
}

function assertLocator(requirementFile, absolute, fragment) {
	if (!fragment) return;
	const content = readFileSync(absolute, "utf8");
	const segments = fragment.split(".");
	assert.ok(segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment)), `${requirementFile}: unsafe evidence fragment #${fragment}`);
	if (absolute.endsWith(".json")) {
		let cursor = JSON.parse(content);
		for (const segment of segments) {
			assert.ok(cursor && typeof cursor === "object" && Object.hasOwn(cursor, segment), `${requirementFile}: unresolved JSON evidence fragment #${fragment}`);
			cursor = cursor[segment];
		}
		return;
	}
	const paths = new Set();
	const stack = [];
	for (const line of content.split(/\r?\n/)) {
		const match = line.match(/^(\s*)([A-Za-z0-9_-]+):(?:\s|$)/);
		if (!match) continue;
		const depth = match[1].length;
		while (stack.length && stack.at(-1).depth >= depth) stack.pop();
		stack.push({ depth, key: match[2] });
		paths.add(stack.map((item) => item.key).join("."));
	}
	assert.ok(paths.has(fragment), `${requirementFile}: unresolved YAML evidence fragment #${fragment}`);
}

test("trace validators reject partial symbols and unresolved evidence fragments", () => {
	assert.throws(() => assertCodeSymbols("fixture.yaml", "fixture.mjs", "function exactSymbol() {}", ["exactSymbol", "missingSymbol"]), /missingSymbol/);
	const fixture = resolve(import.meta.dirname, "fixtures", "trace-locator-fixture.json");
	assertLocator("fixture.yaml", fixture, "reviews.planning");
	assert.throws(() => assertLocator("fixture.yaml", fixture, "reviews.DOES_NOT_EXIST"), /unresolved JSON evidence fragment/);
});

test("DSO requirement trace structure, symbols, and evidence locators resolve", () => {
	const requirementFiles = readdirSync(requirementsRoot)
		.filter((name) => /^DSO-\d{3}-.+\.yaml$/.test(name))
		.sort();
	assert.ok(requirementFiles.length >= 12);

	for (const requirementFile of requirementFiles) {
		const requirement = readFileSync(join(requirementsRoot, requirementFile), "utf8");
		const lines = requirement.split(/\r?\n/);
		assert.equal(lines.filter((line) => line === "trace:").length, 1, `${requirementFile}: trace must be one top-level mapping`);
		const traceStart = lines.indexOf("trace:");
		const traceEndOffset = lines.slice(traceStart + 1).findIndex((line) => /^[A-Za-z_][A-Za-z0-9_]*:/.test(line));
		const traceLines = lines.slice(traceStart + 1, traceEndOffset < 0 ? lines.length : traceStart + 1 + traceEndOffset);
		assert.equal(traceLines.filter((line) => line === "  code:").length, 1, `${requirementFile}: trace.code must exist exactly once`);
		assert.equal(traceLines.filter((line) => line === "  tests:").length, 1, `${requirementFile}: trace.tests must exist exactly once`);
		assert.equal(traceLines.filter((line) => line.startsWith("  reviews:")).length, 1, `${requirementFile}: trace.reviews must exist exactly once`);

		let section = null;
		let entryCount = 0;
		let testCount = 0;
		for (const line of traceLines) {
			if (line === "  code:" || line === "  tests:") section = line.slice(2, -1);
			else if (/^  [A-Za-z_][A-Za-z0-9_]*:/.test(line)) section = null;
			if (!line.trimStart().startsWith("- { path:")) continue;
			assert.ok(section === "code" || section === "tests", `${requirementFile}: trace path lies outside code/tests`);
			const parsed = line.match(section === "code" ? codeTraceEntry : testTraceEntry);
			assert.ok(parsed, `${requirementFile}: malformed trace entry ${line.trim()}`);
			const [, relative, declared] = parsed;
			const absolute = regularRepositoryFile(requirementFile, relative);
			const target = readFileSync(absolute, "utf8");
			if (section === "tests") {
				assert.ok(target.includes(`test("${declared}"`) || target.includes(`test(\`${declared}\``), `${requirementFile}: named test is absent from ${relative}: ${declared}`);
			} else {
				let symbols;
				try { symbols = JSON.parse(declared); } catch { assert.fail(`${requirementFile}: malformed code symbol list for ${relative}`); }
				assertCodeSymbols(requirementFile, relative, target, symbols);
			}
			entryCount += 1;
			if (section === "tests") testCount += 1;
		}
		assert.ok(entryCount >= 2 && testCount >= 1, `${requirementFile}: trace must bind code and test evidence`);

		for (const match of requirement.matchAll(/"(\.agents\/[^"#]+)(?:#([^"]+))?"/g)) {
			const absolute = regularRepositoryFile(requirementFile, match[1]);
			assertLocator(requirementFile, absolute, match[2]);
		}
	}
});

test("FET_DSO_013_002 validates the complete UC and FE trace without orphan nodes", () => {
	const requirementFile = "DSO-013-meaningful-session-ledger.yaml";
	const requirement = readFileSync(join(requirementsRoot, requirementFile), "utf8");
	const section = (key) => {
		const match = requirement.match(new RegExp(`^${key}:\\n([\\s\\S]*?)(?=^[A-Za-z_][A-Za-z0-9_]*:|\\Z)`, "m"));
		assert.ok(match, `${requirementFile}: missing ${key}`);
		return match[1];
	};
	const ids = (key) => new Set([...section(key).matchAll(/\{ id: ([A-Z0-9_]+),/g)].map((match) => match[1]));
	const nodes = {
		directive: new Set(["USR-013"]),
		requirement: new Set(["DSO-013"]),
		use_case: ids("use_cases"),
		use_case_test: ids("use_case_tests"),
		feature: ids("features"),
		feature_test: ids("feature_tests"),
		implementation: ids("implementations"),
		evidence: ids("evidence"),
	};
	for (const [kind, values] of Object.entries(nodes)) assert.ok(values.size > 0, `${requirementFile}: ${kind} nodes are empty`);
	const kindPairs = new Map([
		["directives_to_requirements", ["directive", "requirement"]],
		["requirements_to_use_cases", ["requirement", "use_case"]],
		["use_cases_to_use_case_tests", ["use_case", "use_case_test"]],
		["use_case_tests_to_features", ["use_case_test", "feature"]],
		["features_to_feature_tests", ["feature", "feature_test"]],
		["feature_tests_to_implementations", ["feature_test", "implementation"]],
		["implementations_to_evidence", ["implementation", "evidence"]],
	]);
	const incoming = new Set();
	const outgoing = new Set();
	const edges = [...section("trace_edges").matchAll(/\{ kind: ([a-z_]+), from: ([A-Z0-9_-]+), to: ([A-Z0-9_-]+) \}/g)];
	assert.ok(edges.length >= kindPairs.size, `${requirementFile}: trace edges are incomplete`);
	for (const [, kind, from, to] of edges) {
		const pair = kindPairs.get(kind);
		assert.ok(pair, `${requirementFile}: unsupported trace edge ${kind}`);
		assert.ok(nodes[pair[0]].has(from), `${requirementFile}: unknown ${kind} source ${from}`);
		assert.ok(nodes[pair[1]].has(to), `${requirementFile}: unknown ${kind} target ${to}`);
		outgoing.add(from);
		incoming.add(to);
	}
	for (const [kind, values] of Object.entries(nodes)) {
		for (const id of values) {
			if (kind !== "directive") assert.ok(incoming.has(id), `${requirementFile}: orphan incoming node ${id}`);
			if (kind !== "evidence") assert.ok(outgoing.has(id), `${requirementFile}: orphan outgoing node ${id}`);
		}
	}
	const integration = readFileSync(join(root, ".agents/skills/manage-discord-sessions/tests/meaningful-session-ledger.integration.test.mjs"), "utf8");
	for (const testId of nodes.use_case_test) assert.ok(integration.includes(`test("${testId} `), `${requirementFile}: missing use-case test ${testId}`);
	for (const testId of ["FET_DSO_013_001"]) assert.ok(integration.includes(`test("${testId} `), `${requirementFile}: missing feature test ${testId}`);
});
