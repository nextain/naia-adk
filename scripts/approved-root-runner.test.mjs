import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { approvalBytes, sha256, validateRequest, runRequest, assertProtectedPath, readProtectedFile, parseRoles } from './approved-root-runner.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const rolesBytes = Buffer.from(JSON.stringify({schema:1,approvers:[{id:'lead',role:'dev-lead',publicKey:publicKey.export({type:'spki',format:'pem'})}]}));
const subjectUid = process.getuid();
const now = 1800000000000;
function signed(payload) {
  return { payload, signature: crypto.sign(null, approvalBytes(payload), privateKey).toString('base64') };
}
function request(command = 'printf approved') {
  const planBytes = Buffer.from(JSON.stringify({ schema: 1, steps: [{ id: 'inspect', command, commandSha256: sha256(command) }] }));
  const planSha256 = sha256(planBytes);
  const common = { schema: 2, approverId: 'lead', rolesSha256: sha256(rolesBytes), planSha256, reviewSha256: sha256('adversarial-review'), subjectUid, issuedAt: now - 1000, expiresAt: now + 60000 };
  return {
    planBase64: planBytes.toString('base64'), planSha256, stepId: 'inspect', command,
    planApproval: signed({ ...common, kind: 'PLAN', code: `PLAN-${crypto.randomBytes(16).toString('hex')}` }),
    stepApproval: signed({ ...common, kind: 'STEP', code: `STEP-${crypto.randomBytes(16).toString('hex')}`, stepId: 'inspect', commandSha256: sha256(command) }),
  };
}
const options = { rolesBytes, subjectUid, now };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'approved-runner-test-'));
  fs.chmodSync(dir, 0o700);
  fs.mkdirSync(path.join(dir, 'used'), { mode: 0o700 });
  fs.mkdirSync(path.join(dir, 'audit'), { mode: 0o700 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ...options, stateDir: dir, trustedUid: subjectUid, testBoundary: dir };
}
function alterApproval(req, kind, values) {
  const key = `${kind}Approval`;
  req[key] = signed({ ...req[key].payload, ...values });
}

test('accepts real independently signed PLAN and STEP approvals', () => {
  const req = request();
  assert.equal(validateRequest(req, options).step.command, req.command);
});

test('rejects commands and step IDs outside the approved plan byte for byte', () => {
  for (const edit of [r => { r.command += ' '; }, r => { r.command = 'printf bypass'; }, r => { r.stepId = '../inspect'; }]) {
    const req = request(); edit(req);
    assert.throws(() => validateRequest(req, options), /Command differs/);
  }
});

test('rejects changed plan bytes and incorrect step digest', () => {
  const req = request();
  req.planBase64 = Buffer.from('{}').toString('base64');
  assert.throws(() => validateRequest(req, options), /Plan hash/);
  const badStep = request();
  const plan = JSON.parse(Buffer.from(badStep.planBase64, 'base64'));
  plan.steps[0].commandSha256 = '0'.repeat(64);
  badStep.planBase64 = Buffer.from(JSON.stringify(plan)).toString('base64');
  badStep.planSha256 = sha256(Buffer.from(badStep.planBase64, 'base64'));
  assert.throws(() => validateRequest(badStep, options), /Invalid plan step/);
});

test('rejects forged signatures, wrong caller, expired, future and excessive lifetime approvals', () => {
  const forged = request();
  forged.stepApproval.signature = Buffer.alloc(64).toString('base64');
  assert.throws(() => validateRequest(forged, options), /signature/);
  assert.throws(() => validateRequest(request(), { ...options, subjectUid: subjectUid + 1 }), /approval/);
  for (const values of [{ expiresAt: now }, { issuedAt: now + 1 }, { expiresAt: now + 900001 }]) {
    for (const kind of ['plan', 'step']) {
      const req = request(); alterApproval(req, kind, values);
      assert.throws(() => validateRequest(req, options), /approval/);
    }
  }
});

test('rejects signed approvals bound to a different step, command or plan', () => {
  for (const values of [{ stepId: 'other' }, { commandSha256: '0'.repeat(64) }, { planSha256: '0'.repeat(64) }]) {
    const req = request(); alterApproval(req, 'step', values);
    assert.throws(() => validateRequest(req, options), /mismatch|approval/);
  }
});

test('executes without inherited environment and captures output and nonzero status', t => {
  const opts = fixture(t);
  const req = request('printf "%s|%s|%s" "${RUNNER_POISON-unset}" "$PATH" "$PWD"; printf failure >&2; exit 7');
  const previous = process.env.RUNNER_POISON;
  process.env.RUNNER_POISON = 'must-not-leak';
  t.after(() => { if (previous === undefined) delete process.env.RUNNER_POISON; else process.env.RUNNER_POISON = previous; });
  const result = runRequest(req, opts);
  assert.equal(result.exitCode, 7);
  const audit = path.join(opts.stateDir, 'audit', result.auditId);
  assert.equal(fs.readFileSync(path.join(audit, 'stdout'), 'utf8'), 'unset|/usr/sbin:/usr/bin:/sbin:/bin|/');
  assert.equal(fs.readFileSync(path.join(audit, 'stderr'), 'utf8'), 'failure');
  assert.equal(JSON.parse(fs.readFileSync(path.join(audit, 'result.json'))).exitCode, 7);
  assert.equal(sha256(fs.readFileSync(path.join(audit, 'plan.json'))), req.planSha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(audit, 'request.json'))), req);
  assert.equal(fs.statSync(path.join(audit, 'result.json')).mode & 0o777, 0o600);
  assert.throws(() => runRequest(req, opts), /EEXIST/);
});

test('consumes failed launches and preserves failure audit', t => {
  const opts = fixture(t);
  const req = request();
  const result = runRequest(req, { ...opts, execute() { throw new Error('launch failed'); } });
  assert.equal(result.exitCode, null);
  assert.equal(result.error, 'launch failed');
  assert.throws(() => runRequest(req, opts), /EEXIST/);
});

test('rejects symlink directories, writable state, hardlinked keys and traversal', t => {
  const opts = fixture(t);
  const key = path.join(opts.stateDir, 'key');
  fs.writeFileSync(key, 'public-key', { mode: 0o600 });
  assert.equal(readProtectedFile(key, subjectUid, opts.stateDir).toString(), 'public-key');
  const link = path.join(opts.stateDir, 'link');
  fs.symlinkSync(key, link);
  assert.throws(() => readProtectedFile(link, subjectUid, opts.stateDir), /Untrusted/);
  fs.linkSync(key, path.join(opts.stateDir, 'hardlink'));
  assert.throws(() => readProtectedFile(key, subjectUid, opts.stateDir), /Untrusted/);
  assert.throws(() => assertProtectedPath(`${opts.stateDir}/../${path.basename(opts.stateDir)}`, subjectUid, true, opts.stateDir), /canonical/);
  fs.chmodSync(opts.stateDir, 0o777);
  assert.throws(() => runRequest(request(), opts), /Untrusted/);
  fs.chmodSync(opts.stateDir, 0o700);
  const dirLink = path.join(opts.stateDir, 'audit-link');
  fs.symlinkSync(path.join(opts.stateDir, 'audit'), dirLink);
  assert.throws(() => assertProtectedPath(dirLink, subjectUid, true, opts.stateDir), /Untrusted/);
});

test('concurrent processes cannot execute the same approval twice', async t => {
  const opts = fixture(t);
  const req = request('printf once');
  const moduleUrl = new URL('./approved-root-runner.mjs', import.meta.url).href;
  const code = `import { runRequest } from ${JSON.stringify(moduleUrl)}; import crypto from 'node:crypto'; let s=''; for await (const c of process.stdin) s+=c; const {request,options,roles}=JSON.parse(s); try {runRequest(request,{...options,rolesBytes:Buffer.from(roles)});} catch {process.exitCode=2;}`;
  const input = JSON.stringify({ request: req, options: { subjectUid, now, stateDir: opts.stateDir, trustedUid: subjectUid, testBoundary: opts.stateDir }, roles: [...rolesBytes] });
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, error })); child.stdin.end(input);
  });
  const results = await Promise.all([launch(), launch()]);
  assert.deepEqual(results.map(x => x.code).sort(), [0, 2], JSON.stringify(results));
  const audits = fs.readdirSync(path.join(opts.stateDir, 'audit'));
  assert.equal(audits.length, 1);
  assert.equal(fs.readFileSync(path.join(opts.stateDir, 'audit', audits[0], 'stdout'), 'utf8'), 'once');
});


test('rejects changed plans even when caller recomputes their digest', () => {
  const req = request();
  const plan = JSON.parse(Buffer.from(req.planBase64, 'base64'));
  plan.steps[0].command = 'printf substituted';
  plan.steps[0].commandSha256 = sha256(plan.steps[0].command);
  req.command = plan.steps[0].command;
  req.planBase64 = Buffer.from(JSON.stringify(plan)).toString('base64');
  req.planSha256 = sha256(Buffer.from(req.planBase64, 'base64'));
  assert.throws(() => validateRequest(req, options), /approval/);
});

test('refuses extra request fields and malformed approval envelopes', () => {
  assert.throws(() => validateRequest({ ...request(), extra: true }, options), /Unexpected fields/);
  const req = request(); req.stepApproval.payload.extra = true;
  assert.throws(() => validateRequest(req, options), /Unexpected fields/);
  const malformed = request(); malformed.planBase64 = '?';
  assert.throws(() => validateRequest(malformed, options), /encoding/);
});

test('re-signing a used code with a new expiry cannot bypass the used-code ledger', t => {
  for (const reused of ['plan', 'step']) {
    const opts = fixture(t);
    const first = request();
    runRequest(first, opts);
    const second = request();
    alterApproval(second, reused, { code: first[`${reused}Approval`].payload.code, expiresAt: now + 120000 });
    assert.throws(() => runRequest(second, opts), /EEXIST/);
    assert.equal(fs.readdirSync(path.join(opts.stateDir, 'audit')).length, 1);
  }
});

test('rejects a symlink replacing the used directory before command execution', t => {
  const opts = fixture(t);
  fs.renameSync(path.join(opts.stateDir, 'used'), path.join(opts.stateDir, 'real-used'));
  fs.symlinkSync(path.join(opts.stateDir, 'real-used'), path.join(opts.stateDir, 'used'));
  let executed = false;
  assert.throws(() => runRequest(request(), { ...opts, execute() { executed = true; } }), /Untrusted/);
  assert.equal(executed, false);
  assert.equal(fs.readdirSync(path.join(opts.stateDir, 'audit')).length, 0);
});


test('privileged CLI rejects an unprivileged caller and all command-line options', () => {
  assert.notEqual(subjectUid, 0, 'this suite must run without root');
  const runner = fileURLToPath(new URL('./approved-root-runner.mjs', import.meta.url));
  for (const args of [[], ['--state-dir', '/'], ['--help']]) {
    const result = spawnSync(process.execPath, [runner, ...args], { input: '{}', encoding: 'utf8', timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Root execution without arguments required/);
    assert.equal(result.stdout, '');
  }
});

test('offline signer produces verifiable approvals over exact plan and review bytes', t => {
  const opts = fixture(t);
  const initial = request();
  const planBytes = Buffer.from(initial.planBase64, 'base64');
  const reviewBytes = Buffer.from('Adversarial review: command and rollback checked.\n');
  const keyFile = path.join(opts.stateDir, 'private.pem');
  const planFile = path.join(opts.stateDir, 'plan.json');
  const reviewFile = path.join(opts.stateDir, 'review.txt');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(planFile, planBytes);
  fs.writeFileSync(reviewFile, reviewBytes);
  const rolesFile = path.join(opts.stateDir, 'roles.json');
  fs.writeFileSync(rolesFile, rolesBytes);
  const signer = fileURLToPath(new URL('./sign-approved-runner.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [signer, keyFile, planFile, reviewFile, String(subjectUid), 'inspect', 'lead', rolesFile], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const signedRequest = JSON.parse(result.stdout);
  const validated = validateRequest(signedRequest, { rolesBytes, subjectUid });
  assert.deepEqual(validated.planBytes, planBytes);
  assert.equal(signedRequest.planApproval.payload.reviewSha256, sha256(reviewBytes));
  assert.equal(signedRequest.stepApproval.payload.reviewSha256, sha256(reviewBytes));
  assert.notEqual(signedRequest.planApproval.payload.code, signedRequest.stepApproval.payload.code);
  assert.equal(signedRequest.planApproval.payload.expiresAt - signedRequest.planApproval.payload.issuedAt, 300000);
});

test('rejects separately signed approvals referring to different reviews', () => {
  const req = request();
  alterApproval(req, 'step', { reviewSha256: sha256('different review') });
  assert.throws(() => validateRequest(req, options), /Review digest mismatch/);
});

test('rejects malformed UTF8 in otherwise hash-matched and signed plan bytes', () => {
  const req = request();
  const valid = Buffer.from(req.planBase64, 'base64');
  const malformed = Buffer.concat([valid.subarray(0, valid.length - 1), Buffer.from(',"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  // JSON.parse would accept replacement-character decoding; fatal UTF8 validation must reject first.
  assert.doesNotThrow(() => JSON.parse(malformed.toString('utf8')));
  req.planBase64 = malformed.toString('base64'); req.planSha256 = sha256(malformed);
  for (const kind of ['plan', 'step']) alterApproval(req, kind, { planSha256: req.planSha256 });
  assert.throws(() => validateRequest(req, options), /encoded data|UTF-8|encoding/i);
});


test('rejects outsiders, lower roles, identity substitution and substituted role tables', () => {
  const outsider = crypto.generateKeyPairSync('ed25519');
  const table = JSON.parse(rolesBytes);
  table.approvers.push({id:'developer',role:'developer',publicKey:outsider.publicKey.export({type:'spki',format:'pem'})});
  const bytes = Buffer.from(JSON.stringify(table));
  for (const id of ['developer', 'unknown', 'lead']) {
    const req = request();
    for (const kind of ['plan','step']) {
      const payload = {...req[`${kind}Approval`].payload, approverId:id,rolesSha256:sha256(bytes)};
      req[`${kind}Approval`] = {payload, signature:crypto.sign(null,approvalBytes(payload),outsider.privateKey).toString('base64')};
    }
    assert.throws(() => validateRequest(req,{...options,rolesBytes:bytes}), /Unauthorized|signature/);
  }
  assert.throws(() => validateRequest(request(),{...options,rolesBytes:bytes}), /approval/);
  const req = request(); req.stepApproval.payload.approverId='unknown';
  assert.throws(() => validateRequest(req,options), /Unauthorized/);
});

function replacementRequest(nextBytes, currentBytes = rolesBytes) {
  const req = request();
  const command = `replace-roles:${sha256(nextBytes)}`;
  const plan = Buffer.from(JSON.stringify({schema:2,action:'replace-roles',rolesBase64:nextBytes.toString('base64'),steps:[{id:'replace-roles',command,commandSha256:sha256(command)}]}));
  req.planBase64=plan.toString('base64'); req.planSha256=sha256(plan); req.command=command; req.stepId='replace-roles';
  for (const kind of ['plan','step']) alterApproval(req,kind,{planSha256:req.planSha256,rolesSha256:sha256(currentBytes),...(kind==='step'?{stepId:req.stepId,commandSha256:sha256(command)}:{})});
  return req;
}

test('role replacement needs current signatures, preserves original and revokes stale policy approvals', t => {
  const opts=fixture(t);
  const rolesFile=path.join(opts.stateDir,'roles.json');
  fs.writeFileSync(rolesFile,rolesBytes,{mode:0o600});
  opts.rolesFile=rolesFile;
  const next=Buffer.from(JSON.stringify({...JSON.parse(rolesBytes),minimumRole:'dev-lead'}));
  const bad=replacementRequest(next); bad.stepApproval.signature=Buffer.alloc(64).toString('base64');
  assert.throws(()=>runRequest(bad,opts),/signature/);
  assert.deepEqual(fs.readFileSync(rolesFile),rolesBytes);
  const stale=request();
  const result=runRequest(replacementRequest(next),{...opts,execute(){assert.fail('role update must not execute shell');}});
  assert.equal(result.exitCode,0);
  assert.deepEqual(fs.readFileSync(rolesFile),next);
  assert.deepEqual(fs.readFileSync(path.join(opts.stateDir,'audit',result.auditId,'roles-before.json')),rolesBytes);
  assert.throws(()=>runRequest(stale,opts),/approval/);
  const replay=replacementRequest(next);
  assert.throws(()=>runRequest(replay,opts),/approval/);
});

test('rejects role file symlink, writable table, duplicate identities and lockout policies', t => {
  const opts=fixture(t), filename=path.join(opts.stateDir,'roles.json');
  fs.writeFileSync(filename,rolesBytes,{mode:0o600});
  fs.symlinkSync(filename,path.join(opts.stateDir,'alias'));
  assert.throws(()=>runRequest(request(),{...opts,rolesFile:path.join(opts.stateDir,'alias')}),/Untrusted/);
  fs.chmodSync(filename,0o666);
  assert.throws(()=>runRequest(request(),{...opts,rolesFile:filename}),/Untrusted/);
  const table=JSON.parse(rolesBytes);
  for(const approvers of [[],[{...table.approvers[0],role:'developer'}],[table.approvers[0],table.approvers[0]],[table.approvers[0],{...table.approvers[0],id:'other'}]]) {
    assert.throws(()=>parseRoles(Buffer.from(JSON.stringify({schema:1,approvers}))));
  }
});

function resignFor(req, key, approverId, currentBytes) {
  for (const kind of ['plan', 'step']) {
    const payload = { ...req[`${kind}Approval`].payload, approverId, rolesSha256: sha256(currentBytes) };
    req[`${kind}Approval`] = { payload, signature: crypto.sign(null, approvalBytes(payload), key).toString('base64') };
  }
  return req;
}

test('rejects PLAN and STEP from different independently authorized approvers', () => {
  const other = crypto.generateKeyPairSync('ed25519');
  const table = JSON.parse(rolesBytes);
  table.approvers.push({ id: 'other', role: 'owner', publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }) });
  const current = Buffer.from(JSON.stringify(table));
  const req = resignFor(request(), privateKey, 'lead', current);
  const otherRequest = resignFor(structuredClone(req), other.privateKey, 'other', current);
  assert.doesNotThrow(() => validateRequest(req, { ...options, rolesBytes: current }));
  assert.doesNotThrow(() => validateRequest(otherRequest, { ...options, rolesBytes: current }));
  req.stepApproval = otherRequest.stepApproval;
  assert.throws(() => validateRequest(req, { ...options, rolesBytes: current }), /Approver identity mismatch/);
});

test('new key cannot approve its own insertion into the current role table', t => {
  const opts = fixture(t);
  const nextKey = crypto.generateKeyPairSync('ed25519');
  const next = Buffer.from(JSON.stringify({ schema: 1, approvers: [{ id: 'next', role: 'owner', publicKey: nextKey.publicKey.export({ type: 'spki', format: 'pem' }) }] }));
  const rolesFile = path.join(opts.stateDir, 'roles.json');
  fs.writeFileSync(rolesFile, rolesBytes, { mode: 0o600 });
  // Attacker knows the genuine current digest but is absent from its membership.
  const req = resignFor(replacementRequest(next), nextKey.privateKey, 'next', rolesBytes);
  assert.throws(() => runRequest(req, { ...opts, rolesFile }), /Unauthorized approver role/);
  assert.deepEqual(fs.readFileSync(rolesFile), rolesBytes);
  assert.equal(fs.readdirSync(path.join(opts.stateDir, 'used')).length, 0);
});

test('replacement bytes cannot change after current approver signs the plan', t => {
  const opts = fixture(t);
  const rolesFile = path.join(opts.stateDir, 'roles.json');
  fs.writeFileSync(rolesFile, rolesBytes, { mode: 0o600 });
  const next = Buffer.from(JSON.stringify({ ...JSON.parse(rolesBytes), minimumRole: 'dev-lead' }));
  const req = replacementRequest(next);
  const plan = JSON.parse(Buffer.from(req.planBase64, 'base64'));
  const changed = Buffer.concat([next, Buffer.from('\n')]);
  plan.rolesBase64 = changed.toString('base64');
  // Recompute all attacker-controlled hashes, preserving valid plan structure.
  plan.steps[0].command = `replace-roles:${sha256(changed)}`;
  plan.steps[0].commandSha256 = sha256(plan.steps[0].command);
  const bytes = Buffer.from(JSON.stringify(plan));
  req.planBase64 = bytes.toString('base64'); req.planSha256 = sha256(bytes); req.command = plan.steps[0].command;
  assert.throws(() => runRequest(req, { ...opts, rolesFile }), /Invalid or expired approval/);
  assert.deepEqual(fs.readFileSync(rolesFile), rolesBytes);
});

test('approved key rotation accepts the new key and rejects the removed key', t => {
  const opts = fixture(t);
  const rolesFile = path.join(opts.stateDir, 'roles.json');
  fs.writeFileSync(rolesFile, rolesBytes, { mode: 0o600 });
  const nextKey = crypto.generateKeyPairSync('ed25519');
  const next = Buffer.from(JSON.stringify({ schema: 1, approvers: [{ id: 'next', role: 'owner', publicKey: nextKey.publicKey.export({ type: 'spki', format: 'pem' }) }] }));
  assert.equal(runRequest(replacementRequest(next), { ...opts, rolesFile }).exitCode, 0);
  // Even a fresh old-key signature over the new table digest has no authority.
  const removed = resignFor(request(), privateKey, 'lead', next);
  assert.throws(() => runRequest(removed, { ...opts, rolesFile }), /Unauthorized approver role/);
  const authorized = resignFor(request('printf rotated'), nextKey.privateKey, 'next', next);
  const result = runRequest(authorized, { ...opts, rolesFile });
  assert.equal(result.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(opts.stateDir, 'audit', result.auditId, 'stdout'), 'utf8'), 'rotated');
  assert.deepEqual(fs.readFileSync(rolesFile), next);
});
