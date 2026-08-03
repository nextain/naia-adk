#!/usr/bin/env node
const assert = require("node:assert/strict");
const { reviewOutputBoundary } = require("./scripts/check-output-boundary.cjs");

const sourceAtoms = [
	{ id: "WORKFLOW", subject: "agent_workflow", effect: "precondition", render_policy: "derive" },
	{ id: "REFERENCE", subject: "artifact_content", effect: "presentation", render_policy: "derive" },
	{ id: "OBJECTIVE", subject: "artifact_runtime", effect: "outcome", render_policy: "require", directive_ids: ["DIR-1"] },
];

assert.deepEqual(reviewOutputBoundary({
	baseline_surface_ids: ["legacy-copy"],
	source_atoms: sourceAtoms,
	current_surfaces: [{ id: "legacy-copy", kind: "ui_string", audience: "end_user", exposure: "product_ui", objective_atom_ids: [], content_source_atom_ids: [] }],
}), [], "unchanged baseline surface must not be treated as a newly unjustified surface");

const unjustified = reviewOutputBoundary({
	baseline_surface_ids: [],
	source_atoms: sourceAtoms,
	current_surfaces: [{ id: "new-copy", kind: "ui_string", audience: "end_user", exposure: "product_ui", objective_atom_ids: [], content_source_atom_ids: [] }],
});
assert(unjustified.some((finding) => finding.code === "FINDING-UNJUSTIFIED-PRODUCT-SURFACE"));
assert(reviewOutputBoundary({
	baseline_surface_ids: [], source_atoms: sourceAtoms,
	current_surfaces: [{ id: "unknown-authority", kind: "ui_string", audience: "end_user", exposure: "product_ui", objective_atom_ids: ["MISSING"], content_source_atom_ids: ["REFERENCE"] }],
}).some((finding) => finding.code === "FINDING-UNJUSTIFIED-PRODUCT-SURFACE"));

for (const kind of ["code_symbol", "ui_string", "document_paragraph"]) {
	const findings = reviewOutputBoundary({
		baseline_surface_ids: [],
		source_atoms: sourceAtoms,
		current_surfaces: [{ id: `leak-${kind}`, kind, audience: kind === "ui_string" ? "end_user" : "public", exposure: kind === "ui_string" ? "product_ui" : "external", objective_atom_ids: ["OBJECTIVE"], content_source_atom_ids: ["WORKFLOW"] }],
	});
	assert(findings.some((finding) => finding.code === "FINDING-CONTEXT-OUTPUT-SEPARATION"), `${kind} workflow leak`);
}

assert.deepEqual(reviewOutputBoundary({
	baseline_surface_ids: [],
	source_atoms: sourceAtoms,
	current_surfaces: [{ id: "reference-summary", kind: "document_paragraph", audience: "public", exposure: "external", objective_atom_ids: ["OBJECTIVE"], content_source_atom_ids: ["REFERENCE"] }],
}), [], "explicit reference derive authority is legitimate");

assert(reviewOutputBoundary({
	baseline_surface_ids: [], source_atoms: sourceAtoms,
	current_surfaces: [{ id: "wrong-audience", kind: "ui_string", audience: "developer", exposure: "product_ui", objective_atom_ids: ["OBJECTIVE"], content_source_atom_ids: ["REFERENCE"] }],
}).some((finding) => finding.code === "FINDING-AUDIENCE-SURFACE-FIT"));

assert(reviewOutputBoundary({
	baseline_surface_ids: [], source_atoms: sourceAtoms,
	current_surfaces: [{ id: "public-comment", kind: "developer_comment", audience: "public", exposure: "external", objective_atom_ids: ["OBJECTIVE"], content_source_atom_ids: ["WORKFLOW"] }],
}).some((finding) => finding.code === "FINDING-CONTEXT-OUTPUT-SEPARATION"));

console.log("review-pass output boundary fixtures: PASS");
