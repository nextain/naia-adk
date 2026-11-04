#!/usr/bin/node
// Privileged entrypoint: installed with a fixed interpreter and no CLI options.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LIMIT = 1024 * 1024;
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('Unexpected fields');
};
export function parseRoles(bytes) {
  const roles = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  exactKeys(roles, roles.minimumRole === undefined ? ['schema', 'approvers'] : ['schema', 'minimumRole', 'approvers']);
  const ranks = ['developer', 'dev-lead', 'admin', 'owner'];
  const minimum = roles.minimumRole ?? 'dev-lead';
  if (roles.schema !== 1 || !ranks.includes(minimum) || ranks.indexOf(minimum) < 1 || !Array.isArray(roles.approvers) || !roles.approvers.length || roles.approvers.length > 100) fail('Invalid role policy');
  const ids = new Set(), keys = new Set();
  const approvers = roles.approvers.map(entry => {
    exactKeys(entry, ['id', 'role', 'publicKey']);
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(entry.id) || ids.has(entry.id) || !ranks.includes(entry.role) || typeof entry.publicKey !== 'string') fail('Invalid approver');
    const key = crypto.createPublicKey(entry.publicKey);
    const fingerprint = key.export({ type: 'spki', format: 'der' }).toString('hex');
    if (key.asymmetricKeyType !== 'ed25519' || keys.has(fingerprint)) fail('Invalid or duplicate approver key');
    ids.add(entry.id); keys.add(fingerprint);
    return { ...entry, key, allowed: ranks.indexOf(entry.role) >= ranks.indexOf(minimum) };
  });
  if (!approvers.some(entry => entry.allowed)) fail('Policy needs an authorized approver');
  return { approvers, rolesSha256: sha256(bytes) };
}
export function approvalBytes(payload) {
  const keys = ['schema', 'approverId', 'rolesSha256', 'kind', 'code', 'planSha256', 'subjectUid', 'issuedAt', 'expiresAt', 'reviewSha256'];
  if (payload.kind === 'STEP') keys.push('stepId', 'commandSha256');
  exactKeys(payload, keys);
  return Buffer.from(JSON.stringify(Object.fromEntries(keys.map(key => [key, payload[key]]))));
}
export function validateRequest(request, { rolesBytes, subjectUid, now = Date.now() }) {
  const policy = parseRoles(rolesBytes);
  exactKeys(request, ['planBase64', 'planSha256', 'stepId', 'command', 'planApproval', 'stepApproval']);
  if (typeof request.planBase64 !== 'string' || request.planBase64.length > LIMIT || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.planBase64)) fail('Invalid plan encoding');
  const planBytes = Buffer.from(request.planBase64, 'base64');
  if (!digest(request.planSha256) || sha256(planBytes) !== request.planSha256) fail('Plan hash mismatch');
  const plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(planBytes));
  if (![1, 2].includes(plan.schema) || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 100) fail('Invalid plan');
  const ids = new Set();
  for (const item of plan.steps) {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(item.id) || ids.has(item.id) || typeof item.command !== 'string' || !item.command || item.command.includes('\0') || !digest(item.commandSha256) || sha256(Buffer.from(item.command)) !== item.commandSha256) fail('Invalid plan step');
    ids.add(item.id);
  }
  let replacement = null;
  if (plan.schema === 2) {
    exactKeys(plan, ['schema', 'action', 'rolesBase64', 'steps']);
    if (plan.action !== 'replace-roles' || typeof plan.rolesBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(plan.rolesBase64)) fail('Invalid role replacement');
    replacement = Buffer.from(plan.rolesBase64, 'base64');
    parseRoles(replacement);
    if (plan.steps.length !== 1 || plan.steps[0].id !== 'replace-roles' || plan.steps[0].command !== `replace-roles:${sha256(replacement)}`) fail('Invalid role replacement step');
  }
  const step = plan.steps.find(item => item.id === request.stepId);
  if (!step || request.command !== step.command) fail('Command differs from approved step');
  for (const [approval, kind] of [[request.planApproval, 'PLAN'], [request.stepApproval, 'STEP']]) {
    exactKeys(approval, ['payload', 'signature']);
    const p = approval.payload;
    const bytes = approvalBytes(p);
    if (!digest(p.reviewSha256) || p.schema !== 2 || p.rolesSha256 !== policy.rolesSha256 || p.kind !== kind || typeof p.code !== 'string' || !new RegExp(`^${kind}-[a-f0-9]{32}$`).test(p.code) || p.planSha256 !== request.planSha256 || !Number.isSafeInteger(p.subjectUid) || p.subjectUid !== subjectUid || !Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt) || p.issuedAt > now || p.expiresAt <= now || p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > 15 * 60 * 1000) fail('Invalid or expired approval');
    if (kind === 'STEP' && (p.stepId !== step.id || p.commandSha256 !== step.commandSha256)) fail('Approval step mismatch');
    const approver = policy.approvers.find(entry => entry.id === p.approverId);
    if (!approver?.allowed) fail('Unauthorized approver role');
    if (typeof approval.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(approval.signature) || !crypto.verify(null, bytes, approver.key, Buffer.from(approval.signature, 'base64'))) fail('Invalid approval signature');
  }
  if (request.planApproval.payload.approverId !== request.stepApproval.payload.approverId) fail('Approver identity mismatch');
  if (request.planApproval.payload.reviewSha256 !== request.stepApproval.payload.reviewSha256) fail('Review digest mismatch');
  return { replacement, planBytes, step, planSha256: request.planSha256, token: sha256(request.stepApproval.payload.code), planToken: sha256(request.planApproval.payload.code) };
}

// Every ancestor must be owned by the trusted uid and unwritable by other users.
export function assertProtectedPath(filename, uid = 0, directory = false, testBoundary = null) {
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) fail('Expected canonical absolute path');
  const parts = filename.split('/').filter(Boolean);
  let current = '/';
  for (let i = -1; i < parts.length; i++) {
    if (i >= 0) current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current);
    if (testBoundary && uid !== 0 && current !== testBoundary && !current.startsWith(`${testBoundary}/`)) continue;
    if (stat.isSymbolicLink() || (stat.uid !== uid && !(i < parts.length - 1 && stat.uid === 0)) || (stat.mode & 0o022) || (i < parts.length - 1 || directory ? !stat.isDirectory() : !stat.isFile())) fail('Untrusted path');
  }
}
export function readProtectedFile(filename, uid = 0, testBoundary = null) {
  assertProtectedPath(filename, uid, false, testBoundary);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) || stat.nlink !== 1 || stat.size > LIMIT) fail('Untrusted file');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function writeNew(filename, bytes) {
  const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(filename));
}
function runLockedRequest(request, { rolesBytes, rolesFile, subjectUid, stateDir, now = Date.now(), trustedUid = 0, testBoundary = null, execute = spawnSync }) {
  assertProtectedPath(stateDir, trustedUid, true, testBoundary);
  for (const name of ['used', 'audit']) assertProtectedPath(path.join(stateDir, name), trustedUid, true, testBoundary);
  const validated = validateRequest(request, { rolesBytes, subjectUid, now });
  // O_EXCL consumes the step before any command can run; crashes fail closed.
  const used = path.join(stateDir, 'used', validated.token);
  writeNew(path.join(stateDir, 'used', validated.planToken), JSON.stringify({ at: now }));
  writeNew(used, JSON.stringify({ planSha256: validated.planSha256, stepId: validated.step.id, at: now }));
  const auditDir = path.join(stateDir, 'audit', validated.token);
  fs.mkdirSync(auditDir, { mode: 0o700 });
  syncDirectory(path.dirname(auditDir));
  writeNew(path.join(auditDir, 'plan.json'), validated.planBytes);
  writeNew(path.join(auditDir, 'request.json'), JSON.stringify(request));
  if (sha256(readProtectedFile(path.join(auditDir, 'plan.json'), trustedUid, testBoundary)) !== validated.planSha256) fail('Snapshot hash mismatch');
  if (validated.replacement) {
    if (!rolesFile || !readProtectedFile(rolesFile, trustedUid, testBoundary).equals(rolesBytes)) fail('Role policy changed');
    writeNew(path.join(auditDir, 'roles-before.json'), rolesBytes);
    writeNew(path.join(auditDir, 'roles-after.json'), validated.replacement);
    const staged = `${rolesFile}.pending`;
    writeNew(staged, validated.replacement);
    fs.renameSync(staged, rolesFile);
    syncDirectory(path.dirname(rolesFile));
    const record = { schema: 1, exitCode: 0, action: 'replace-roles', rolesSha256: sha256(validated.replacement), auditId: validated.token };
    writeNew(path.join(auditDir, 'result.json'), JSON.stringify(record));
    return record;
  }
  const out = fs.openSync(path.join(auditDir, 'stdout'), 'wx', 0o600);
  const err = fs.openSync(path.join(auditDir, 'stderr'), 'wx', 0o600);
  let result;
  try {
    result = execute('/bin/bash', ['--noprofile', '--norc', '-c', validated.step.command], {
      cwd: '/', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', out, err], timeout: 300000, killSignal: 'SIGKILL',
    });
  } catch (error) { result = { status: null, signal: null, error }; }
  finally { fs.closeSync(out); fs.closeSync(err); }
  const record = { schema: 1, planSha256: validated.planSha256, stepId: validated.step.id, startedAt: now, endedAt: Date.now(), exitCode: result.status ?? null, signal: result.signal ?? null, error: result.error?.message ?? null };
  writeNew(path.join(auditDir, 'result.json'), JSON.stringify(record));
  return { ...record, auditId: validated.token };
}
// A fail-closed lock serializes policy reads, updates and command execution.
// A crash leaves the lock for human recovery; never auto-break an active lock.
export function runRequest(request, options) {
  const { stateDir, trustedUid = 0, testBoundary = null, rolesFile } = options;
  assertProtectedPath(stateDir, trustedUid, true, testBoundary);
  const lock = path.join(stateDir, 'request.lock');
  writeNew(lock, JSON.stringify({ pid: process.pid }));
  try {
    const rolesBytes = rolesFile ? readProtectedFile(rolesFile, trustedUid, testBoundary) : options.rolesBytes;
    return runLockedRequest(request, { ...options, rolesBytes });
  } finally { fs.unlinkSync(lock); syncDirectory(stateDir); }
}
async function main() {
  if (process.getuid?.() !== 0 || process.argv.length !== 2) fail('Root execution without arguments required');
  process.umask(0o077);
  const subjectUid = Number(process.env.SUDO_UID);
  if (!/^[0-9]+$/.test(process.env.SUDO_UID ?? '') || !Number.isSafeInteger(subjectUid) || subjectUid === 0) fail('Expected sudo caller');
  let size = 0;
  const chunks = [];
  const timer = setTimeout(() => { process.stderr.write('Request timeout\n'); process.exit(1); }, 10000);
  try {
    for await (const chunk of process.stdin) { size += chunk.length; if (size > LIMIT) fail('Request too large'); chunks.push(chunk); }
  } finally { clearTimeout(timer); }
  const result = runRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), { rolesFile: '/etc/naia-approved-runner/roles.json', subjectUid, stateDir: '/var/lib/naia-approved-runner' });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode === 0 ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Approved runner refused: ${error.message}\n`); process.exitCode = 1; });
}
