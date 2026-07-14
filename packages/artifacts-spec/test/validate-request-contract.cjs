#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Ajv2020 = require("ajv/dist/2020").default;

const root = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(root, "..", "..");
const runtime = require(path.join(repositoryRoot, ".agents", "hooks", "core", "request-contract.js"));
const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "request-contract.schema.json"), "utf8"));
const example = JSON.parse(fs.readFileSync(path.join(root, "examples", "request-contract.minimal.json"), "utf8"));
const exampleAuthorityPublicKey = fs.readFileSync(path.join(root, "examples", "request-contract.example-authority.pub"), "utf8");
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const validate = ajv.compile(schema);

assert(validate(example), ajv.errorsText(validate.errors, { separator: "\n" }));
const examplePrompt = example.sources[0].obligation_atoms.map((atom) => atom.text).join("");
const exampleSource = {
	source_id: example.sources[0].id,
	prompt: examplePrompt,
	prompt_digest: runtime.sha256(examplePrompt),
	origin: "native_user",
};
const runtimeResult = runtime.validateContract(example, [exampleSource], [], {
	publicKeyPem: exampleAuthorityPublicKey,
	cwd: repositoryRoot,
	now: 1783960030000,
});
assert(runtimeResult.ok, `published example must pass runtime validation:\n${runtimeResult.errors.join("\n")}`);
assert.equal(example.authorities[0].source_digest, exampleSource.prompt_digest, "published example source digest must bind the exact prompt");
assert.equal(example.authorities[0].receipt.resulting_scope_digest, runtime.sha256(runtime.canonicalJson(runtime.scopeProjection(example))), "published example scope digest must bind the exact scope");
const examplePresentation = runtime.authorityPresentation(example.authorities[0], null, example.authorities[0].receipt.resulting_scope_digest, 0, 1);
assert.equal(example.authorities[0].receipt.presentation_digest, runtime.sha256(runtime.canonicalJson(examplePresentation)), "published example presentation digest must bind the exact authority operation");
for (const mutate of [
	(contract) => { contract.sources[0].obligation_atoms[0].text += " narrowed"; },
	(contract) => { contract.artifacts.evidence[0].digest = "0".repeat(64); },
	(contract) => { contract.authorities[0].receipt.signature = Buffer.from("forged").toString("base64"); },
]) {
	const drifted = JSON.parse(JSON.stringify(example));
	mutate(drifted);
	const prompt = drifted.sources[0].obligation_atoms.map((atom) => atom.text).join("");
	const source = { source_id: drifted.sources[0].id, prompt, prompt_digest: runtime.sha256(prompt), origin: "native_user" };
	assert.equal(runtime.validateContract(drifted, [source], [], { publicKeyPem: exampleAuthorityPublicKey, cwd: repositoryRoot, now: 1783960030000 }).ok, false, "runtime validator must reject drifted published example material");
}
const incomplete = JSON.parse(JSON.stringify(example));
delete incomplete.artifacts;
assert.equal(validate(incomplete), false, "schema must reject a contract without trace artifacts");
const narrowed = JSON.parse(JSON.stringify(example));
narrowed.directives[0].targets = [];
narrowed.directives[0].acceptance_criteria = [];
assert.equal(validate(narrowed), false, "schema must reject a completed directive without targets and criteria");
const openEnvelope = JSON.parse(JSON.stringify(example));
openEnvelope.directives[0].targets[0].unexpected = "leak";
openEnvelope.authorities[0].receipt.path_summary = "/private/path";
assert.equal(validate(openEnvelope), false, "schema must reject unrecognized nested fields");
const sixEdgeChain = JSON.parse(JSON.stringify(example));
sixEdgeChain.edges = sixEdgeChain.edges.filter((edge) => edge.kind !== "directives_to_requirements");
assert.equal(validate(sixEdgeChain), false, "schema must reject a contract missing any of the seven edge kinds");
const sourceLessAuthority = JSON.parse(JSON.stringify(example));
delete sourceLessAuthority.authorities[0].source_id;
assert.equal(validate(sourceLessAuthority), false, "schema must require the exact authorizing source");
const digestLessAuthority = JSON.parse(JSON.stringify(example));
delete digestLessAuthority.authorities[0].source_digest;
assert.equal(validate(digestLessAuthority), false, "schema must require the authorizing source digest");
const missingAuthorityTargets = JSON.parse(JSON.stringify(example));
delete missingAuthorityTargets.authorities[0].target_directive_ids;
assert.equal(validate(missingAuthorityTargets), false, "schema must require authority target arrays even when empty would be legal");
for (const classification of ["directive", "approval", "authority"]) {
	const unmappedActionable = JSON.parse(JSON.stringify(example));
	unmappedActionable.sources[0].classification = classification;
	unmappedActionable.sources[0].obligation_atoms[0].directive_ids = [];
	assert.equal(validate(unmappedActionable), false, `schema must reject unmapped ${classification} obligation atoms`);
}
for (const mutate of [
	(contract) => { delete contract.directives[0].targets[0].obligation_atom_ids; },
	(contract) => { delete contract.directives[0].acceptance_criteria[0].obligation_atom_ids; },
	(contract) => { delete contract.artifacts.requirements[0].obligation_atom_ids; },
	(contract) => { delete contract.artifacts.evidence[0].obligation_atom_ids; },
]) {
	const missingAtomTrace = JSON.parse(JSON.stringify(example));
	mutate(missingAtomTrace);
	assert.equal(validate(missingAtomTrace), false, "schema must carry obligation atoms through scope and trace artifacts");
}

process.stdout.write("request-contract schema+runtime: PASS\n");
