import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./doc-size-refactor.mjs', import.meta.url));
test('candidate selection, path guard and preservation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-size-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  const source = path.join(root, 'docs', 'sample.md');
  const original = '# Header\n' + Array.from({length: 15}, (_, i) => `## ${i === 1 ? 'Old 2020-01-01' : i === 2 ? 'Current 2020-01-01' : `Part ${i} 2020-01-01`}\nline ${i}\n`).join('');
  fs.writeFileSync(source, original);
  const model = path.join(root, 'fake-model');
  fs.writeFileSync(model, '#!/usr/bin/env node\nconst fs=require("fs");const a=process.argv;fs.readFileSync(0);fs.writeFileSync(a[a.indexOf("--output-last-message")+1],process.env.ANSWER);\n', {mode: 0o755});
  const env = {...process.env, DOC_SIZE_ROOT: root, TMPDIR: root, DOC_SIZE_CODEX: model, DOC_SIZE_TEST_NO_GIT:'1', DOC_SIZE_MAX_LINES:'1'};
  const run = (answer, args = []) => spawnSync(process.execPath, [script, ...args], {env:{...env, ANSWER:answer}, encoding:'utf8'});
  for (const answer of ['{"sections":[1]}','{"sections":[3]}','{"sections":[6]}','{"sections":[2,3]}','{"sections":[2,2]}','invalid']) {
    assert.notEqual(run(answer).status, 0, answer);
    assert.equal(fs.readFileSync(source, 'utf8'), original);
  }
  assert.notEqual(run('{"sections":[2]}', ['--path','docs/*.md']).status, 0);
  assert.equal(fs.readFileSync(source, 'utf8'), original);
  assert.equal(run('{"sections":[2]}').status, 0);
  const after = fs.readFileSync(source, 'utf8');
  assert.ok(!after.includes('## Old 2020-01-01'));
  assert.ok(after.includes('## Current 2020-01-01'));
  const archiveDir = path.join(root, 'docs/archive/docs/sample');
  const archive = fs.readFileSync(path.join(archiveDir, fs.readdirSync(archiveDir)[0]), 'utf8');
  assert.ok(archive.includes('## Old 2020-01-01\nline 1\n'));
  const sourceLines = original.slice(0, -1).split('\n').sort();
  const resultLines = [...after.slice(0, -1).split('\n').slice(0, -1), ...archive.slice(0, -1).split('\n').slice(1)].sort();
  assert.deepEqual(resultLines, sourceLines);
  fs.writeFileSync(source, '# Header\n' + Array.from({length: 15}, (_, i) => `## Part ${i}\nNo date\n`).join(''));
  const noCall = spawnSync(process.execPath, [script], {env:{...env,DOC_SIZE_CODEX:'/nonexistent'},encoding:'utf8'});
  assert.equal(noCall.status, 0, noCall.stderr);
  assert.ok(noCall.stdout.includes('옮길 것 없음'));
});

test('temporary index commits only generated files and preserves staged changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-size-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), remote = path.join(root, 'remote.git');
  fs.mkdirSync(repo);
  const env = {...process.env, GIT_AUTHOR_NAME:'Test', GIT_AUTHOR_EMAIL:'test@example.test', GIT_COMMITTER_NAME:'Test', GIT_COMMITTER_EMAIL:'test@example.test'};
  const git = (...args) => { const r = spawnSync('git', args, {cwd:repo, env, encoding:'utf8'}); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); };
  assert.equal(spawnSync('git',['init','--bare',remote],{stdio:'ignore'}).status,0);
  git('init','-b','test'); git('remote','add','origin',remote);
  fs.mkdirSync(path.join(repo,'docs'));
  fs.writeFileSync(path.join(repo,'docs','file.md'), '# Header\n' + Array.from({length:15},(_,i)=>`## Part ${i} 2020-01-01\nline ${i}\n`).join(''));
  fs.writeFileSync(path.join(repo,'other.txt'),'before\n');
  fs.writeFileSync(path.join(repo,'unstaged.txt'),'before\n');
  git('add','docs/file.md','other.txt','unstaged.txt'); git('commit','-m','base');
  fs.writeFileSync(path.join(repo,'other.txt'),'staged\n'); git('add','other.txt');
  fs.writeFileSync(path.join(repo,'unstaged.txt'),'unstaged\n');
  fs.writeFileSync(path.join(repo,'untracked.txt'),'untracked\n');
  const index = path.join(repo,'.git','index');
  const digest = () => crypto.createHash('sha256').update(fs.readFileSync(index)).digest('hex');
  const indexBefore = digest();
  const model = path.join(root,'model');
  fs.writeFileSync(model,'#!/usr/bin/env node\nconst fs=require("fs");const a=process.argv;fs.readFileSync(0);fs.writeFileSync(a[a.indexOf("--output-last-message")+1],"{\\"sections\\":[2]}");\n',{mode:0o755});
  const result = spawnSync(process.execPath,[script],{cwd:repo,env:{...env,DOC_SIZE_ROOT:repo,TMPDIR:root,DOC_SIZE_CODEX:model,DOC_SIZE_MAX_LINES:'1'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr + result.stdout);
  assert.equal(digest(),indexBefore);
  assert.equal(fs.readFileSync(path.join(repo,'unstaged.txt'),'utf8'),'unstaged\n');
  assert.equal(fs.readFileSync(path.join(repo,'untracked.txt'),'utf8'),'untracked\n');
  assert.equal(git('show','HEAD:unstaged.txt'),'before');
  assert.equal(git('show','HEAD:other.txt'),'before');
  assert.equal(git('show',':other.txt'),'staged');
  assert.deepEqual(git('diff-tree','--no-commit-id','--name-only','-r','HEAD').split('\n').sort(),['docs/archive/doc-size/'+new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit'}).format(new Date())+'.md','docs/archive/docs/file/'+new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit'}).format(new Date())+'.md','docs/file.md'].sort());
});


function injectionFixture(t, transform = text => text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-size-injection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'repo'); fs.mkdirSync(path.join(root, 'docs'), {recursive:true});
  const source = path.join(root, 'docs', 'sample.md');
  const original = Buffer.from('# Header  \n' + Array.from({length:15}, (_, i) => `## Part ${i} 2020-01-01\n${i === 1 ? 'MOVE_SENTINEL  ' : `line ${i}  `}\n`).join(''));
  fs.writeFileSync(source, original);
  const runner = path.join(dir, 'runner.mjs'); fs.writeFileSync(runner, transform(fs.readFileSync(script, 'utf8')));
  const model = path.join(dir, 'model');
  fs.writeFileSync(model, `#!/usr/bin/env node
const fs=require('fs'); const args=process.argv; fs.readFileSync(0);
if(process.env.MODE==='exit') process.exit(9);
if(process.env.MODE==='sleep') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000);
if(process.env.MODE==='mutate') fs.appendFileSync(process.env.SOURCE,'EXTERNAL_EDIT\\n');
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'{"sections":[2]}');
`, {mode:0o755});
  const env = {...process.env, DOC_SIZE_ROOT:root, TMPDIR:dir, DOC_SIZE_CODEX:model, DOC_SIZE_TEST_NO_GIT:'1', DOC_SIZE_MAX_LINES:'1', SOURCE:source};
  const run = (extra = {}) => spawnSync(process.execPath,[runner],{env:{...env,...extra},encoding:'utf8',timeout:10000});
  const archive = path.join(root,'docs','archive','docs','sample',new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit'}).format(new Date())+'.md');
  return {root,source,original,run,archive};
}
function replaceOnce(text, needle, replacement) {
  assert.ok(text.includes(needle), 'injection point missing');
  return text.replace(needle, replacement);
}

test('line preservation rejects omissions, rewrites and duplicates', async t => {
  const needle = 'compare([item.snap.data], [newSource, addition], [link, header]);';
  for (const [name, mutation] of Object.entries({
    omission: "addition.toString().replace('MOVE_SENTINEL  \\n','')",
    rewrite: "addition.toString().replace('MOVE_SENTINEL','REWRITTEN')",
    duplicate: "addition.toString()+'MOVE_SENTINEL  \\n'",
    heading: "addition.toString()+'## Part 1 2020-01-01\\n'",
    link: "addition.toString()+link+'\\n'",
  })) await t.test(name, t => {
    const f = injectionFixture(t, text => replaceOnce(text, needle, `compare([item.snap.data], [newSource, Buffer.from(${mutation})], [link, header]);`));
    const r = f.run(); assert.equal(r.status,1,r.stderr); assert.match(r.stdout,/line preservation check failed/);
    assert.deepEqual(fs.readFileSync(f.source),f.original); assert.equal(fs.existsSync(f.archive),false);
  });
});

test('model failure and timeout preserve source bytes', async t => {
  for (const mode of ['exit','sleep']) await t.test(mode,t => {
    const f = injectionFixture(t, text => mode === 'sleep' ? replaceOnce(text,'timeout: 15 * 60 * 1000','timeout: 250') : text);
    const r = f.run({MODE:mode}); assert.equal(r.status,1,r.stderr); assert.match(r.stdout,mode === 'sleep' ? /ETIMEDOUT|timed out/i : /exit 9/);
    assert.deepEqual(fs.readFileSync(f.source),f.original); assert.equal(fs.existsSync(f.archive),false);
  });
});

test('date boundary excludes six and seven days and accepts eight', t => {
  const f = injectionFixture(t);
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const date = days => new Date(Date.parse(today+'T00:00:00Z')-days*86400000).toISOString().slice(0,10);
  for (const days of [6,7,8]) {
    fs.writeFileSync(f.source, f.original.toString().replace('## Part 1 2020-01-01',`## Part 1 ${date(days)}`));
    const before=fs.readFileSync(f.source), r=f.run();
    assert.equal(r.status,days===8?0:1,r.stdout+r.stderr);
    if(days!==8) assert.deepEqual(fs.readFileSync(f.source),before);
  }
});

test('unsafe and symlink targets are rejected before model invocation', t => {
  const f = injectionFixture(t); const marker=path.join(f.root,'called');
  const invalid = ['/absolute.md','docs/../sample.md','docs\\sample.md','docs/link.md','linked/sample.md'];
  fs.symlinkSync(f.source,path.join(f.root,'docs','link.md'));
  fs.symlinkSync(path.join(f.root,'docs'),path.join(f.root,'linked'));
  for (const target of invalid) {
    const r=f.run({DOC_SIZE_TARGETS:JSON.stringify([target]),DOC_SIZE_CODEX:marker});
    assert.notEqual(r.status,0,target); assert.deepEqual(fs.readFileSync(f.source),f.original);
    assert.equal(fs.existsSync(marker),false); assert.equal(fs.existsSync(f.archive),false);
  }
});

test('concurrent edits are preserved and first rename is rolled back', async t => {
  await t.test('during model',t => {
    const f=injectionFixture(t),r=f.run({MODE:'mutate'});
    assert.equal(r.status,1,r.stderr); assert.match(r.stdout,/changed during model/);
    assert.deepEqual(fs.readFileSync(f.source),Buffer.concat([f.original,Buffer.from('EXTERNAL_EDIT\n')]));
    assert.equal(fs.existsSync(f.archive),false);
  });
  await t.test('after archive rename',t => {
    const needle='fs.renameSync(temp, path.join(root, rel)); applied.push([rel, snap, read(rel)]);';
    const f=injectionFixture(t,text=>replaceOnce(text,needle,needle+" if (rel === archiveRel) fs.appendFileSync(path.join(root,item.rel),'EXTERNAL_AFTER_RENAME\\n');"));
    const r=f.run(); assert.equal(r.status,1,r.stderr); assert.match(r.stdout,/changed immediately before rename/);
    assert.deepEqual(fs.readFileSync(f.source),Buffer.concat([f.original,Buffer.from('EXTERNAL_AFTER_RENAME\n')]));
    assert.equal(fs.existsSync(f.archive),false);
  });
});

test('real Codex denies reading outside its workspace', {timeout:90000}, t => {
  const found = spawnSync('which',['codex'],{encoding:'utf8'});
  if (found.status !== 0) return t.skip('codex executable is not available');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'doc-size-codex-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const work=path.join(dir,'work'), outside=path.join(dir,'outside.txt'), output=path.join(dir,'answer');
  fs.mkdirSync(work); fs.writeFileSync(outside,'synthetic access probe\n');
  const filesystem={':root':'deny',':minimal':'read',':workspace_roots':'read'};
  if(process.env.DOC_SIZE_CODEX_RUNTIME) filesystem[path.resolve(process.env.DOC_SIZE_CODEX_RUNTIME)]='read';
  const config=`permissions.doc-only.filesystem={${Object.entries(filesystem).map(([k,v])=>`${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}}`;
  const args=['exec','--ignore-user-config','--ephemeral','-m',process.env.DOC_SIZE_MODEL || 'gpt-6-luna','-c','model_reasoning_effort="low"','-c','approval_policy="never"','-c','default_permissions="doc-only"','-c',config,'--skip-git-repo-check','-C',work,'--output-last-message',output,'-'];
  const prompt=`Run only the shell check test -r ${JSON.stringify(outside)}. Do not open or print the file. Return exactly READ_EXIT=0 if readable or READ_EXIT=1 if not readable.`;
  const r=spawnSync(found.stdout.trim(),args,{cwd:work,input:prompt,encoding:'utf8',timeout:80000,maxBuffer:1024*1024});
  assert.equal(r.status,0,`Codex failed: ${r.error?.message || r.stderr}`);
  assert.match(fs.readFileSync(output,'utf8'),/READ_EXIT=1\b/);
});
