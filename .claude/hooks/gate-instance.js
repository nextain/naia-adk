"use strict";
// Instance-owned constants. Replace the unset ID in the fork's reviewed code.
const APPROVER_DISCORD_ID = null;
const GATE_CONFIG_FILES = Object.freeze([".claude/deploy/config.json", "config/deploy-gate.json"]);
const DISCORD_INSTANCES = Object.freeze([]);
const GATE_PLUGINS = Object.freeze({});
module.exports = Object.freeze({ approverId: APPROVER_DISCORD_ID, files: GATE_CONFIG_FILES, discordInstances: DISCORD_INSTANCES, plugins: GATE_PLUGINS });
