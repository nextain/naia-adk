#!/usr/bin/node
// Run only in the separate human-controlled approval service. Never grant sudo access.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { approvalBytes, sha256 } from './approved-root-runner.mjs';

if (process.argv.length !== 7) {
  process.stderr.write('Usage: node sign-approved-runner.mjs PRIVATE_KEY PLAN_FILE REVIEW_FILE SUBJECT_UID STEP_ID\n');
  process.exit(1);
}
const [keyFile, planFile, reviewFile, uidText, stepId] = process.argv.slice(2);
const planBytes = fs.readFileSync(planFile);
const plan = JSON.parse(planBytes);
const step = plan.steps.find(item => item.id === stepId);
if (!step || sha256(Buffer.from(step.command)) !== step.commandSha256) throw new Error('Invalid step');
if (!/^[0-9]+$/.test(uidText) || !Number.isSafeInteger(Number(uidText)) || Number(uidText) === 0) throw new Error('Invalid caller uid');
const key = crypto.createPrivateKey(fs.readFileSync(keyFile));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 private key');
const issuedAt = Date.now();
const base = { schema: 1, planSha256: sha256(planBytes), subjectUid: Number(uidText), issuedAt, expiresAt: issuedAt + 5 * 60 * 1000, reviewSha256: sha256(fs.readFileSync(reviewFile)) };
const approve = (kind, extra = {}) => {
  const payload = { ...base, kind, code: `${kind}-${crypto.randomBytes(16).toString('hex')}`, ...extra };
  return { payload, signature: crypto.sign(null, approvalBytes(payload), key).toString('base64') };
};
process.stdout.write(`${JSON.stringify({ planBase64: planBytes.toString('base64'), planSha256: base.planSha256, stepId, command: step.command, planApproval: approve('PLAN'), stepApproval: approve('STEP', { stepId, commandSha256: step.commandSha256 }) })}\n`);
