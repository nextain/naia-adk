#!/usr/bin/node
// Offline primitive only: run on the human's separate host, never the execution server.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { approvalBytes, sha256, parseRoles, readProtectedFile, assertProtectedPath } from './approved-root-runner.mjs';

export function readSigningKey(filename, subjectUid, testBoundary = null) {
  const uid = process.getuid();
  if (uid === subjectUid) throw new Error('Signer UID must differ from caller UID');
  // Ancestors must be root protected; a private directory owned by the signer is allowed.
  assertProtectedPath(filename, uid, false, testBoundary);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || stat.size > 1024 * 1024 || ![0o400, 0o600].includes(stat.mode & 0o7777)) throw new Error('Private key must be owned by signer, single-link, mode 0400 or 0600');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
export function verifyDigest(bytes, expected, name) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? '') || sha256(bytes) !== expected) throw new Error(`${name} digest mismatch`);
}
export function verifyReview(bytes, planSha256) {
  const review = JSON.parse(bytes);
  if (review.verdict !== 'clean' || review.planSha256 !== planSha256) throw new Error('Review must have clean verdict and bind planSha256');
}
export function assertSeparateHost(targetDigest) {
  if (!/^[a-f0-9]{64}$/.test(targetDigest ?? '')) throw new Error('Expected execution machine-id SHA256');
  const local = readProtectedFile('/etc/machine-id');
  if (sha256(local) === targetDigest) throw new Error('Signing on execution host is forbidden');
}
export function main(args) {
  if (args.length !== 15 || args[7] !== '--expected-plan-sha256' || args[9] !== '--expected-review-sha256' || args[11] !== '--expected-roles-sha256' || args[13] !== '--execution-machine-id-sha256') throw new Error('Usage: PRIVATE_KEY PLAN_FILE REVIEW_FILE SUBJECT_UID STEP_ID APPROVER_ID ROLES_FILE --expected-plan-sha256 SHA --expected-review-sha256 SHA --expected-roles-sha256 SHA --execution-machine-id-sha256 SHA');
  const [keyFile, planFile, reviewFile, uidText, stepId, approverId, rolesFile] = args;
  if (!/^[0-9]+$/.test(uidText) || !Number.isSafeInteger(Number(uidText)) || Number(uidText) === 0) throw new Error('Invalid caller uid');
  const subjectUid = Number(uidText);
  assertSeparateHost(args[14]);
  const keyBytes = readSigningKey(keyFile, subjectUid);
  // Only root-protected human-reviewed snapshots; workspace files cannot be signed.
  const planBytes = readProtectedFile(planFile), reviewBytes = readProtectedFile(reviewFile), rolesBytes = readProtectedFile(rolesFile);
  verifyDigest(planBytes, args[8], 'Plan');
  verifyDigest(reviewBytes, args[10], 'Review');
  verifyDigest(rolesBytes, args[12], 'Roles');
  verifyReview(reviewBytes, args[8]);
  const plan = JSON.parse(planBytes);
  const step = plan.steps.find(item => item.id === stepId);
  if (!step || typeof step.command !== 'string' || sha256(Buffer.from(step.command)) !== step.commandSha256) throw new Error('Invalid step');
  const key = crypto.createPrivateKey(keyBytes);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 private key');
  const policy = parseRoles(rolesBytes);
  const approver = policy.approvers.find(entry => entry.id === approverId);
  if (!approver?.allowed || !crypto.createPublicKey(key).export({type:'spki',format:'der'}).equals(approver.key.export({type:'spki',format:'der'}))) throw new Error('Unauthorized signing key');
  const issuedAt = Date.now();
  const base = { schema: 2, executionMachineIdSha256: args[14], approverId, rolesSha256: policy.rolesSha256, planSha256: sha256(planBytes), subjectUid, issuedAt, expiresAt: issuedAt + 5 * 60 * 1000, reviewSha256: sha256(reviewBytes) };
  const approve = (kind, extra = {}) => {
    const payload = { ...base, kind, code: `${kind}-${crypto.randomBytes(16).toString('hex')}`, ...extra };
    return { payload, signature: crypto.sign(null, approvalBytes(payload), key).toString('base64') };
  };
  const request = { planBase64: planBytes.toString('base64'), planSha256: base.planSha256, stepId, command: step.command, planApproval: approve('PLAN'), stepApproval: approve('STEP', { stepId, commandSha256: step.commandSha256 }) };
  process.stderr.write(`${JSON.stringify({ command: step.command, stepId, planApproval: request.planApproval.payload, stepApproval: request.stepApproval.payload }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(request)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
