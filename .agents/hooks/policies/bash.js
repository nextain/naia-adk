/**
 * Tool-agnostic Bash-guard policies (G-OC01 part2 — policy neutralization).
 *
 * Pure: (command, data, opts?) → { reason } | null  ({ reason } = BLOCK).
 * No host I/O envelope, no process.exit. Shared by every host adapter —
 * .claude/hooks/_claude-bash-guard.js and .pi/extensions/naia-harness.ts
 * call the SAME policy here. Behavior byte-identical to the part1 adapters
 * (golden 8/42/19 + E2E 64 must stay green).
 *
 * Path notes: deploy DEPLOY_DIR is __dirname-dependent → its adapter must
 * pass it via opts (handled in the deploy policy when extracted). git-push
 * is stateless: routine non-force, non-deleting pushes pass; force variants
 * and remote-ref deletion block.
 * pr/commit use data.cwd + execSync (host-neutral node) → move-safe.
 */
// Stable public policy facade; implementation modules keep this same directory.
module.exports={
 ...require("./bash-git.cjs"),
 ...require("./bash-external.cjs"),
 ...require("./bash-deploy.cjs"),
 ...require("./bash-artifact.cjs"),
};
