import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const routing = require("../../.claude/hooks/lib/role-routing.js");

export const {
	selectSingleOwnerRole,
	resolveSingleRoleOwner,
	pickOwnerRole,
	shouldWakeUnclaimedOwner,
	extractCalledRoles,
} = routing;
export default routing;
