import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const requirementsRoot = join(root, ".agents", "requirements");
const traceEntry = /^    - \{ path: "([^"]+)", symbol: "([^"]+)", coverage: (full|partial|legacy_compatibility) \}$/;

function regularRepositoryFile(requirementFile, relative) {
	assert.ok(!relative.startsWith("/") && !relative.includes("\\"), `${requirementFile}: unsafe repository path ${relative}`);
	const absolute = resolve(root, relative);
	assert.ok(absolute.startsWith(`${root}${sep}`), `${requirementFile}: path escapes repository ${relative}`);
	const stat = lstatSync(absolute, { throwIfNoEntry: false });
	assert.ok(stat?.isFile() && !stat.isSymbolicLink(), `${requirementFile}: missing or non-regular file ${relative}`);
	return absolute;
}

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
			const parsed = line.match(traceEntry);
			assert.ok(parsed, `${requirementFile}: malformed trace entry ${line.trim()}`);
			const [, relative, symbol] = parsed;
			const absolute = regularRepositoryFile(requirementFile, relative);
			const target = readFileSync(absolute, "utf8");
			if (section === "tests") {
				assert.ok(target.includes(`test("${symbol}"`) || target.includes(`test(\`${symbol}\``), `${requirementFile}: named test is absent from ${relative}: ${symbol}`);
			} else {
				for (const claim of symbol.split("/")) {
					const identifiers = claim.match(/[A-Za-z_$][A-Za-z0-9_$-]{2,}/g) || [];
					assert.ok(identifiers.some((identifier) => target.includes(identifier)), `${requirementFile}: code symbol claim is absent from ${relative}: ${claim.trim()}`);
				}
			}
			entryCount += 1;
			if (section === "tests") testCount += 1;
		}
		assert.ok(entryCount >= 2 && testCount >= 1, `${requirementFile}: trace must bind code and test evidence`);

		for (const match of requirement.matchAll(/"(\.agents\/[^"#]+)(?:#[^"]+)?"/g)) {
			regularRepositoryFile(requirementFile, match[1]);
		}
	}
});
