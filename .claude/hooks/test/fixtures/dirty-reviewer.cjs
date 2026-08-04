#!/usr/bin/env node
"use strict";

const fs = require("fs");
const input = JSON.parse(fs.readFileSync(process.env.REQUEST_CONTRACT_BUNDLE, "utf8"));
const coverage = input.review_coverage;
process.stdout.write(JSON.stringify({
	verdict: "DIRTY",
	review_stage: process.env.REQUEST_CONTRACT_REVIEW_STAGE || "planning",
	role: process.env.REQUEST_CONTRACT_REVIEW_ROLE || "general",
	delivery_state: "REVIEW_ONLY",
	preservation_vetoes: ["adversarial-drift"],
	invocation_nonce: process.env.REQUEST_CONTRACT_CHALLENGE,
	covered_source_ids: coverage.sourceIds,
	covered_source_mappings: coverage.sourceMappings,
	covered_directive_ids: coverage.directiveIds,
	covered_target_ids: coverage.targetIds,
	covered_criterion_ids: coverage.criterionIds,
	covered_authority_ids: coverage.authorityIds,
	covered_authority_mappings: coverage.authorityMappings,
	covered_tombstone_ids: coverage.tombstoneIds,
	covered_tombstone_mappings: coverage.tombstoneMappings,
	covered_scope_version_ids: coverage.scopeVersionIds,
	covered_scope_version_mappings: coverage.scopeVersionMappings,
	covered_artifact_ids: coverage.artifactIds,
	covered_edge_ids: coverage.edgeIds,
	covered_change_ids: coverage.occurrenceIds,
	covered_change_mappings: coverage.changeMappings,
	covered_preservation_surface_mappings: coverage.preservationSurfaceMappings || [],
	finding_codes: ["FINDING-OTHER"],
}));
