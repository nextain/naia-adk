"use strict";

// The classifier is synchronous. This short-lived helper performs the existing
// asynchronous Discord check only when a configured exception actually matches.
const fs = require("fs");
const path = require("path");
const { statePath } = require("./deploy-human-approval.js");
const { approvedGateConfig } = require("./gate-config-pin.js");
const { loadDiscordToken } = require("./deploy-plan.js");

async function main(root) {
	try {
		const { discordUserId } = require(path.join(root, ".claude/hooks/instance/gate-approver.js"));
		const refFile = path.join(path.dirname(statePath(process.env)), "gate-config-approval.json");
		const ref = JSON.parse(fs.readFileSync(refFile, "utf8"));
		const token = await loadDiscordToken(root);
		const approved = await approvedGateConfig({ root, approverId: discordUserId, refs: [ref], token });
		if (approved) process.stdout.write(approved.hash);
	} catch { /* no approval */ }
}

main(path.resolve(process.argv[2] || "."));
