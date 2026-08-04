import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const requirementsRoot = join(root, ".agents", "requirements");

test("DSO requirement trace paths resolve to current regular files", () => {
	const requirementFiles = readdirSync(requirementsRoot)
		.filter((name) => /^DSO-\d{3}-.+\.yaml$/.test(name))
		.sort();
	assert.ok(requirementFiles.length >= 12);

	for (const requirementFile of requirementFiles) {
		const requirement = readFileSync(join(requirementsRoot, requirementFile), "utf8");
		const paths = [...requirement.matchAll(/\{ path: "([^"]+)"/g)].map((match) => match[1]);
		assert.ok(paths.length > 0, `${requirementFile} must carry concrete trace paths`);
		for (const relative of paths) {
			assert.ok(!relative.startsWith("/") && !relative.includes("\\"), `${requirementFile}: unsafe trace path ${relative}`);
			const absolute = resolve(root, relative);
			assert.ok(absolute.startsWith(`${root}${sep}`), `${requirementFile}: trace escapes repository ${relative}`);
			const stat = lstatSync(absolute, { throwIfNoEntry: false });
			assert.ok(stat?.isFile() && !stat.isSymbolicLink(), `${requirementFile}: missing or non-regular trace ${relative}`);
		}
	}
});
