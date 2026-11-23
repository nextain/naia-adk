"use strict";
const fs=require("node:fs"),path=require("node:path");
function findApprovalGateRoot(cwd, deployDir) {
	if (process.env.DEPLOY_READINESS_ROOT) return path.resolve(process.env.DEPLOY_READINESS_ROOT);
	const candidates = [];
	if (cwd) {
		candidates.push(path.resolve(cwd));
		let cur = path.resolve(cwd);
		for (;;) {
			if (fs.existsSync(path.join(cur, ".agents", "progress")) || fs.existsSync(path.join(cur, "config", "deploy-gate.json")) || fs.existsSync(path.join(cur, ".git"))) {
				if (!candidates.includes(cur)) candidates.push(cur);
			}
			const parent = path.dirname(cur);
			if (parent === cur) break;
			cur = parent;
		}
	}
	if (deployDir) candidates.push(path.resolve(deployDir, "..", ".."));
	for (const c of candidates) {
		if (fs.existsSync(path.join(c, "config", "deploy-gate.json")) || hasAnyDeployPlan(c)) return c;
	}
	return candidates[0] || path.resolve(__dirname, "..", "..", "..");
}

function hasAnyDeployPlan(root) {
	const hooksLibDir = path.resolve(__dirname, "..", "..", "..", ".claude", "hooks", "lib");
	const { hasDeployPlanMarker } = require(path.join(hooksLibDir, "deploy-readiness.js"));
	const res = hasDeployPlanMarker(root);
	return Boolean(res.present || res.error);
}

function hasApprovalPlanGate(root) {
	if (!root) return false;
	return (
		fs.existsSync(path.join(root, "config", "deploy-gate.json")) ||
		fs.existsSync(path.join(root, ".agents", "scripts", "approval-plan.mjs")) ||
		hasAnyDeployPlan(root)
	);
}

module.exports={findApprovalGateRoot,hasApprovalPlanGate};
