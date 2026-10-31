import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
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
  const sourceLines = original.trimEnd().split('\n').sort();
  const resultLines = [...after.trimEnd().split('\n').slice(0, -1), ...archive.trimEnd().split('\n').slice(1)].sort();
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
  git('add','docs/file.md','other.txt'); git('commit','-m','base');
  fs.writeFileSync(path.join(repo,'other.txt'),'staged\n'); git('add','other.txt');
  const model = path.join(root,'model');
  fs.writeFileSync(model,'#!/usr/bin/env node\nconst fs=require("fs");const a=process.argv;fs.readFileSync(0);fs.writeFileSync(a[a.indexOf("--output-last-message")+1],"{\\"sections\\":[2]}");\n',{mode:0o755});
  const result = spawnSync(process.execPath,[script],{cwd:repo,env:{...env,DOC_SIZE_ROOT:repo,TMPDIR:root,DOC_SIZE_CODEX:model,DOC_SIZE_MAX_LINES:'1'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr + result.stdout);
  assert.equal(git('show','HEAD:other.txt'),'before');
  assert.equal(git('show',':other.txt'),'staged');
  assert.deepEqual(git('diff-tree','--no-commit-id','--name-only','-r','HEAD').split('\n').sort(),['docs/archive/doc-size/'+new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit'}).format(new Date())+'.md','docs/archive/docs/file/'+new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit'}).format(new Date())+'.md','docs/file.md'].sort());
});
