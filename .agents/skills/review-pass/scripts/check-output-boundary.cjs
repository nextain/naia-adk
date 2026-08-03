#!/usr/bin/env node
/** Deterministic evidence helper for the three mandatory output-boundary lenses. */
const fs = require("node:fs");

function reviewOutputBoundary(bundle) {
	const findings = [];
	const baseline = new Set(bundle?.baseline_surface_ids || []);
	const sources = new Map((bundle?.source_atoms || []).map((atom) => [atom.id, atom]));
	for (const surface of bundle?.current_surfaces || []) {
		const isNew = !baseline.has(surface.id);
		const objectives = (surface.objective_atom_ids || []).map((id) => sources.get(id));
		const contentSources = (surface.content_source_atom_ids || []).map((id) => sources.get(id));
		const objectiveAuthorized = objectives.length > 0 && objectives.every((atom) => atom && (atom.directive_ids || []).length > 0);
		const contentAuthorized = contentSources.length > 0 && contentSources.every((atom) => atom && atom.render_policy !== "deny");
		if (isNew && ["product_ui", "external"].includes(surface.exposure) &&
			(!objectiveAuthorized || !contentAuthorized)) {
			findings.push({ code: "FINDING-UNJUSTIFIED-PRODUCT-SURFACE", surface_id: surface.id });
		}
		if (surface.exposure === "product_ui" && surface.audience !== "end_user") {
			findings.push({ code: "FINDING-AUDIENCE-SURFACE-FIT", surface_id: surface.id });
		}
		if (surface.exposure === "external" && !["end_user", "partner", "public"].includes(surface.audience)) {
			findings.push({ code: "FINDING-AUDIENCE-SURFACE-FIT", surface_id: surface.id });
		}
		for (const atomId of surface.content_source_atom_ids || []) {
			const atom = sources.get(atomId);
			const workflowContext = atom?.subject === "agent_workflow" && ["background", "precondition"].includes(atom?.effect);
			const invalidDeveloperComment = workflowContext && surface.kind === "developer_comment" &&
				(!["developer", "reviewer"].includes(surface.audience) || !["derive", "quote"].includes(atom.render_policy));
			if (!atom || atom.render_policy === "deny" || (workflowContext && surface.kind !== "developer_comment") || invalidDeveloperComment) {
				findings.push({ code: "FINDING-CONTEXT-OUTPUT-SEPARATION", surface_id: surface.id, atom_id: atomId });
			}
		}
	}
	return findings;
}

if (require.main === module) {
	const input = process.argv[2] ? fs.readFileSync(process.argv[2], "utf8") : fs.readFileSync(0, "utf8");
	process.stdout.write(`${JSON.stringify(reviewOutputBoundary(JSON.parse(input)), null, 2)}\n`);
}

module.exports = { reviewOutputBoundary };
