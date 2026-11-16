"use strict";
// Instance-owned constants. Replace the unset ID in the fork's reviewed code.
const APPROVER_DISCORD_ID = null;
// Set a unique, stable identifier for this instance in reviewed code.
const GATE_INSTANCE_ID = null;
// Non-removable restrictions belong in reviewed hook code, never in state files.
const GATE_FLOOR = Object.freeze({ prodPatterns: Object.freeze([]), services: Object.freeze({}), sshAlwaysGated: Object.freeze([]) });
const GATE_CONFIG_FILES = Object.freeze([".claude/deploy/config.json", "config/deploy-gate.json"]);
const DISCORD_INSTANCES = Object.freeze([]);
const GATE_PLUGINS = Object.freeze({});
module.exports = Object.freeze({ instanceId: GATE_INSTANCE_ID, approverId: APPROVER_DISCORD_ID, floor: GATE_FLOOR, files: GATE_CONFIG_FILES, discordInstances: DISCORD_INSTANCES, plugins: GATE_PLUGINS });
