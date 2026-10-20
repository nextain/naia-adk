import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  VALID_KINDS,
  LEGACY_KIND_ALIASES,
  defaultMountForKind,
  validateAdkManifest,
  validateAdkPath,
  checkAdkInstance,
  parseWorkDocSchedule,
  validateWorkDocSchedule,
} from '../scripts/adk-link.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const naiaAdkRoot = path.resolve(__dirname, '..');
const adkLinkCli = path.join(naiaAdkRoot, 'scripts', 'adk-link.mjs');
const groupSkeletonDir = path.join(naiaAdkRoot, 'templates', 'group-skeleton');

function makeValidGroupManifest(overrides = {}) {
  return {
    schema_version: '1.0',
    adk_version: '2.0.0',
    id: 'example-group',
    name: 'Example Group',
    kind: 'group',
    owner: 'example-group',
    responsible_human: 'group-owner',
    links: [],
    permissions: {
      allowed_roots: ['rules', 'data', 'skills', 'members', 'projects', 'agents', 'calendar'],
      denied_roots: ['keys'],
      actions: ['read', 'write', 'export'],
    },
    group_config: {
      members: [
        { user_id: 'group-owner', display_name: 'Group Owner', access: 'owner' },
        { user_id: 'member-a', display_name: 'Member A', access: 'member' },
        { user_id: 'member-b', display_name: 'Member B', access: 'unset' },
      ],
      projects: [
        {
          id: 'core-app',
          name: 'Core App',
          repo: 'https://example.org/example-group/core-app',
          repo_status: 'canonical',
          milestones: ['M1'],
          services: [
            {
              id: 'api-svc',
              name: 'API Service',
              repo: null,
              repo_status: 'undecided',
              milestones: ['M1'],
            },
          ],
        },
        {
          id: 'docs-hub',
          name: 'Docs Hub',
          repo: null,
          repo_status: 'undecided',
          milestones: ['M2'],
        },
      ],
      agents: [
        {
          id: 'developer-agent',
          role: 'developer',
          description: 'Handles implementation and test verification.',
          bot: { status: 'active', name: 'dev-bot', credential_ref: 'dev-bot-token' },
        },
        {
          id: 'support-agent',
          role: 'support',
          description: 'Handles customer support triage.',
          bot: { status: 'planned', name: null, credential_ref: 'support-bot-token' },
        },
      ],
      calendar: {
        milestones: [
          { id: 'M1', name: 'Alpha Milestone', due: '2026-11-15', done_when: 'Core API verified' },
          { id: 'M2', name: 'Beta Milestone', due: null, done_when: 'Docs hub published' },
        ],
      },
    },
    ...overrides,
  };
}

test('1. Version 2.0.0 baseline, VALID_KINDS, and valid group manifest counts', () => {
  const versionText = fs.readFileSync(path.join(naiaAdkRoot, 'VERSION'), 'utf8').trim();
  assert.equal(versionText, '2.0.0');

  const upstreamSync = fs.readFileSync(path.join(naiaAdkRoot, '.agents', 'upstream-sync.yaml'), 'utf8');
  assert.match(upstreamSync, /adk_version:\s*2\.0\.0/);

  assert.deepEqual(VALID_KINDS, ['user', 'agent', 'project', 'group']);
  assert.deepEqual(LEGACY_KIND_ALIASES, { org: 'group' });
  assert.equal(defaultMountForKind('group', 'example-group'), 'groups/example-group');
  assert.equal(defaultMountForKind('org', 'example-group'), 'groups/example-group');

  const manifest = makeValidGroupManifest();
  const res = validateAdkManifest(manifest);
  assert.equal(res.ok, true, `Expected valid group manifest, got errors: ${res.errors.join('; ')}`);
  assert.equal(res.warnings.length, 0);
  assert.ok(res.groupSummary);
  assert.equal(res.groupSummary.members, 3);
  assert.equal(res.groupSummary.unsetAccessCount, 1);
  assert.equal(res.groupSummary.projects, 2);
  assert.equal(res.groupSummary.services, 1);
  assert.equal(res.groupSummary.agents, 2);
  assert.equal(res.groupSummary.plannedBotsCount, 1);
  assert.equal(res.groupSummary.milestones, 2);
  assert.deepEqual(res.groupSummary.open.unset_access, ['member-b']);
  assert.deepEqual(res.groupSummary.open.undecided_repos, ['core-app/api-svc', 'docs-hub']);
  assert.deepEqual(res.groupSummary.open.planned_bots, ['support-agent']);
});

test('2. Legacy "org" kind, org_config alias, and 0.2.x adk_version accepted with warnings', () => {
  const legacyManifest = {
    adk_version: '0.2.0',
    id: 'legacy-group',
    name: 'Legacy Group',
    kind: 'org',
    supported_kinds: ['user', 'agent', 'project', 'org'],
    owner: 'legacy-group',
    responsible_human: 'member-a',
    links: [
      {
        id: 'other-group',
        kind: 'org',
        local_path: '../other-group',
      },
    ],
    permissions: {
      allowed_roots: ['rules'],
      denied_roots: ['keys'],
      actions: ['read'],
    },
    org_config: {
      members: [{ user_id: 'group-owner', access: 'owner' }],
      projects: [],
      agents: [],
      calendar: { milestones: [] },
    },
  };

  const res = validateAdkManifest(legacyManifest);
  assert.equal(res.ok, true, `Legacy org should pass with warnings: ${res.errors.join('; ')}`);
  assert.equal(legacyManifest.kind, 'group');
  assert.equal(legacyManifest.links[0].kind, 'group');
  assert.ok(res.warnings.some((w) => w.includes('kind "org"')));
  assert.ok(res.warnings.some((w) => w.includes('supported_kinds') && w.includes('org')));
  assert.ok(res.warnings.some((w) => w.includes('links[0].kind "org"')));
  assert.ok(res.warnings.some((w) => w.includes('org_config')));
  assert.ok(res.warnings.some((w) => w.includes('responsible_human')));
});

test('3. Duplicate member, project, service, and agent IDs are rejected', () => {
  // Duplicate member user_id
  const dupMember = makeValidGroupManifest();
  dupMember.group_config.members.push({ user_id: 'member-a', access: 'viewer' });
  const rMember = validateAdkManifest(dupMember);
  assert.equal(rMember.ok, false);
  assert.ok(rMember.errors.some((e) => e.includes('duplicate member user_id "member-a"')));

  // Duplicate project id
  const dupProject = makeValidGroupManifest();
  dupProject.group_config.projects.push({
    id: 'core-app',
    name: 'Duplicate Core',
    repo: null,
    repo_status: 'undecided',
  });
  const rProject = validateAdkManifest(dupProject);
  assert.equal(rProject.ok, false);
  assert.ok(rProject.errors.some((e) => e.includes('duplicate project id "core-app"')));

  // Duplicate service id
  const dupService = makeValidGroupManifest();
  dupService.group_config.projects[0].services.push({
    id: 'api-svc',
    name: 'Duplicate API Service',
    repo: null,
    repo_status: 'undecided',
  });
  const rService = validateAdkManifest(dupService);
  assert.equal(rService.ok, false);
  assert.ok(rService.errors.some((e) => e.includes('duplicate service id "api-svc"')));

  // Nested service inside service (more than 1 nesting level) rejected
  const deepService = makeValidGroupManifest();
  deepService.group_config.projects[0].services[0].services = [
    { id: 'nested-svc', name: 'Nested', repo: null, repo_status: 'undecided' },
  ];
  const rDeep = validateAdkManifest(deepService);
  assert.equal(rDeep.ok, false);
  assert.ok(rDeep.errors.some((e) => e.includes('one nesting level only')));

  // Duplicate agent id
  const dupAgent = makeValidGroupManifest();
  dupAgent.group_config.agents.push({
    id: 'developer-agent',
    role: 'developer',
    description: 'Duplicate dev agent',
    bot: { status: 'none', name: null },
  });
  const rAgent = validateAdkManifest(dupAgent);
  assert.equal(rAgent.ok, false);
  assert.ok(rAgent.errors.some((e) => e.includes('duplicate agent id "developer-agent"')));
});

test('4. Project repo null + canonical rejected, unknown milestone id rejected, bad due date rejected', () => {
  // repo: null + repo_status: "canonical"
  const badRepo = makeValidGroupManifest();
  badRepo.group_config.projects[1].repo = null;
  badRepo.group_config.projects[1].repo_status = 'canonical';
  const rRepo = validateAdkManifest(badRepo);
  assert.equal(rRepo.ok, false);
  assert.ok(rRepo.errors.some((e) => e.includes('repo_status must be "undecided"')));

  // Unknown milestone id
  const badMilestoneRef = makeValidGroupManifest();
  badMilestoneRef.group_config.projects[0].milestones = ['M1', 'M999'];
  const rMs = validateAdkManifest(badMilestoneRef);
  assert.equal(rMs.ok, false);
  assert.ok(rMs.errors.some((e) => e.includes('unknown milestone id "M999"')));

  // Bad calendar due date (impossible calendar date 2026-02-30)
  const badDue = makeValidGroupManifest();
  badDue.group_config.calendar.milestones[0].due = '2026-02-30';
  const rDue = validateAdkManifest(badDue);
  assert.equal(rDue.ok, false);
  assert.ok(rDue.errors.some((e) => e.includes('valid YYYY-MM-DD calendar date')));

  // Missing calendar due property (undefined) must be an error
  const missingDue = makeValidGroupManifest();
  delete missingDue.group_config.calendar.milestones[0].due;
  const rMissingDue = validateAdkManifest(missingDue);
  assert.equal(rMissingDue.ok, false);
  assert.ok(rMissingDue.errors.some((e) => e.includes('.due') && e.includes('valid YYYY-MM-DD calendar date or null')));
});

test('5. Secret-like fields and bad credential_ref (keys/ path or raw secret) rejected', () => {
  for (const forbiddenKey of ['token', 'secret', 'password', 'api_key', 'bot_token']) {
    const withSecret = makeValidGroupManifest();
    withSecret.group_config.agents[0].bot[forbiddenKey] = 'some-value';
    const res = validateAdkManifest(withSecret);
    assert.equal(res.ok, false, `Expected secret key "${forbiddenKey}" to be rejected`);
    assert.ok(res.errors.some((e) => e.includes(`secret-like field "${forbiddenKey}"`)));

    // Empty string value on a forbidden key name is not flagged as a secret leak
    const withEmptySecret = makeValidGroupManifest();
    withEmptySecret.group_config.agents[0].bot[forbiddenKey] = '';
    const resEmpty = validateAdkManifest(withEmptySecret);
    assert.equal(resEmpty.ok, true, `Expected empty "${forbiddenKey}" not to be flagged as a secret`);
  }

  // credential_ref pointing into keys/
  const keysRef = makeValidGroupManifest();
  keysRef.group_config.agents[0].bot.credential_ref = 'keys/dev-bot.token';
  const rKeysRef = validateAdkManifest(keysRef);
  assert.equal(rKeysRef.ok, false);
  assert.ok(rKeysRef.errors.some((e) => e.includes('credential_ref') && e.includes('keys/')));

  // credential_ref looking like a raw secret (> 40 chars without spaces)
  const rawSecretRef = makeValidGroupManifest();
  rawSecretRef.group_config.agents[0].bot.credential_ref = 'x'.repeat(45);
  const rRawSecret = validateAdkManifest(rawSecretRef);
  assert.equal(rRawSecret.ok, false);
  assert.ok(rRawSecret.errors.some((e) => e.includes('looks like a raw secret')));
});

test('6. Missing referenced file rejected in check mode (when adkDir is provided)', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-adk-v200-missing-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmpDir, 'keys'), { recursive: true });
  const manifest = makeValidGroupManifest();
  manifest.group_config.members[0].file = 'members/missing-member.md';
  manifest.group_config.channels = 'channels.yaml';
  fs.writeFileSync(path.join(tmpDir, 'adk.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const checkRes = checkAdkInstance(tmpDir);
  assert.equal(checkRes.ok, false);
  assert.ok(checkRes.errors.some((e) => e.includes('members/missing-member.md')));
  assert.ok(checkRes.errors.some((e) => e.includes('channels.yaml')));
});

test('7. User user_config.groups[] and Agent agent_config.groups[] validation', () => {
  const validUser = {
    adk_version: '2.0.0',
    id: 'member-a-adk',
    kind: 'user',
    owner: 'member-a',
    responsible_human: 'member-a',
    links: [],
    permissions: {
      allowed_roots: ['rules'],
      denied_roots: ['keys'],
      actions: ['read', 'write'],
    },
    user_config: {
      groups: [
        { group_id: 'example-group', local_path: '../example-group', access: 'member' },
        { group_id: 'second-group', access: 'unset' },
      ],
    },
  };
  assert.equal(validateAdkManifest(validUser).ok, true);

  // Duplicate group_id, absolute local_path, and keys/ in local_path rejected
  const badUser = structuredClone(validUser);
  badUser.user_config.groups = [
    { group_id: 'example-group', local_path: '/abs/path/example-group', access: 'owner' },
    { group_id: 'example-group', local_path: '../keys/secret-group', access: 'invalid-role' },
  ];
  const rBadUser = validateAdkManifest(badUser);
  assert.equal(rBadUser.ok, false);
  assert.ok(rBadUser.errors.some((e) => e.includes('duplicate group_id "example-group"')));
  assert.ok(rBadUser.errors.some((e) => e.includes('must be a relative path')));
  assert.ok(rBadUser.errors.some((e) => e.includes('NEVER reference keys/')));
  assert.ok(rBadUser.errors.some((e) => e.includes('access must be one of')));

  // Agent groups[] validation
  const validAgent = {
    adk_version: '2.0.0',
    id: 'developer-agent',
    kind: 'agent',
    owner: 'member-a',
    responsible_human: 'member-a',
    links: [],
    permissions: {
      allowed_roots: ['rules'],
      denied_roots: ['keys'],
      actions: ['read'],
    },
    agent_config: {
      groups: ['example-group', 'second-group'],
      organizations: ['legacy-org'],
    },
  };
  const rValidAgent = validateAdkManifest(validAgent);
  assert.equal(rValidAgent.ok, true);
  assert.ok(rValidAgent.warnings.some((w) => w.includes('agent_config.organizations')));

  const badAgent = structuredClone(validAgent);
  badAgent.agent_config.groups = ['../path-not-allowed'];
  const rBadAgent = validateAdkManifest(badAgent);
  assert.equal(rBadAgent.ok, false);
  assert.ok(rBadAgent.errors.some((e) => e.includes('agent_config.groups')));
});

test('8. parseWorkDocSchedule counts done rows and validateWorkDocSchedule checks milestone, 기한, and 할 일 table', () => {
  const docText = [
    '---',
    '마일스톤: M1',
    '기한: 2026-11-15',
    '---',
    '',
    '# P-01 Example Work Document',
    '',
    '## 할 일',
    '',
    '| 할 일 | 담당 | 상태 |',
    '|---|---|---|',
    '| 스키마 정의 | developer-agent | 완료 |',
    '| 검증기 구현 | developer-agent | 완료 |',
    '| 문서 정리 | member-a | 진행중 |',
  ].join('\n');

  const parsed = parseWorkDocSchedule(docText);
  assert.equal(parsed.milestone, 'M1');
  assert.equal(parsed.due, '2026-11-15');
  assert.deepEqual(parsed.todo.header, ['할 일', '담당', '상태']);
  assert.equal(parsed.todo.total, 3);
  assert.equal(parsed.todo.done, 2);

  const vOk = validateWorkDocSchedule(docText, {
    milestoneIds: ['M1', 'M2'],
    milestoneNames: ['Alpha Milestone', 'Beta Milestone'],
  });
  assert.equal(vOk.ok, true);
  assert.equal(vOk.errors.length, 0);

  // Matching by milestone name also succeeds
  const docByName = docText.replace('마일스톤: M1', '마일스톤: Alpha Milestone');
  assert.equal(
    validateWorkDocSchedule(docByName, {
      milestoneIds: ['M1'],
      milestoneNames: ['Alpha Milestone'],
    }).ok,
    true,
  );

  // Undefined milestone and bad 기한 rejected
  const badDoc = [
    '---',
    '마일스톤: UNKNOWN_MS',
    '기한: 2026-02-30',
    '---',
    '',
    '## 할 일',
    '',
    '| 작업 | 상태 |',
    '|---|---|',
    '| 항목 | 완료 |',
  ].join('\n');

  const vBad = validateWorkDocSchedule(badDoc, {
    milestoneIds: ['M1'],
    milestoneNames: ['Alpha Milestone'],
  });
  assert.equal(vBad.ok, false);
  assert.ok(vBad.errors.some((e) => e.includes('마일스톤')));
  assert.ok(vBad.errors.some((e) => e.includes('기한')));
  assert.ok(vBad.errors.some((e) => e.includes('할 일, 담당, 상태')));

  // Missing front matter produces warning, not error
  const noFrontMatterDoc = '# General Note\n\nJust text without front matter.\n';
  const vWarn = validateWorkDocSchedule(noFrontMatterDoc, { milestoneIds: ['M1'] });
  assert.equal(vWarn.ok, true);
  assert.equal(vWarn.errors.length, 0);
  assert.ok(vWarn.warnings.length > 0);

  // Generic --- front matter block without 마일스톤: or 기한: is not a schedule doc -> warning only, not errors
  const genericYamlDoc = '---\ntitle: General Meeting Memo\nauthor: member-a\n---\n\n# Memo\n\nBody text.\n';
  const vGenericWarn = validateWorkDocSchedule(genericYamlDoc, { milestoneIds: ['M1'] });
  assert.equal(vGenericWarn.ok, true);
  assert.equal(vGenericWarn.errors.length, 0);
  assert.ok(vGenericWarn.warnings.length > 0);
});

test('9. CLI --check on templates/group-skeleton exits 0, prints summary & open lines, supports --json and work_docs_dir', (t) => {
  const out = execFileSync(process.execPath, [adkLinkCli, '--check', groupSkeletonDir], {
    encoding: 'utf8',
  });
  assert.match(
    out,
    /group example-group: members 3 \(unset access 3\), projects 5 \(\+services 3\), agents 4 \(bots planned 4, seats ready 0\/4\), milestones 2/,
  );
  assert.match(out, /^open: unset access/m);
  assert.match(out, /^open: undecided repos/m);
  assert.match(out, /^open: planned bots/m);
  assert.match(out, /^open: seats not created \(3\):/m);
  assert.match(out, /^open: seats without manifest \(1\): developer-agent/m);
  assert.doesNotMatch(out, /entry AGENTS\.md missing/);
  assert.doesNotMatch(out, /missing context/);
  assert.doesNotMatch(out, /agent doc should live in its seat/);

  // --json flag output
  const jsonOut = execFileSync(
    process.execPath,
    [adkLinkCli, '--check', groupSkeletonDir, '--json'],
    { encoding: 'utf8' },
  );
  const parsedJson = JSON.parse(jsonOut);
  assert.equal(parsedJson.ok, true);
  assert.equal(parsedJson.groupSummary.members, 3);
  assert.equal(parsedJson.groupSummary.projects, 5);
  assert.equal(parsedJson.groupSummary.services, 3);
  assert.equal(parsedJson.groupSummary.agents, 4);
  assert.equal(parsedJson.groupSummary.milestones, 2);
  assert.deepEqual(parsedJson.groupSummary.open.missing_entry, []);
  assert.deepEqual(parsedJson.groupSummary.open.missing_context, []);
  assert.ok(!parsedJson.warnings.some((w) => w.includes('entry AGENTS.md missing')));
  assert.ok(!parsedJson.warnings.some((w) => w.includes('agent doc should live in its seat')));

  // Check work_docs_dir integration in --check mode
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-adk-v200-workdocs-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmpDir, 'keys'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'work'), { recursive: true });
  const manifest = makeValidGroupManifest();
  manifest.group_config.calendar.work_docs_dir = 'work';
  fs.writeFileSync(path.join(tmpDir, 'adk.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(tmpDir, 'work', 'P-01.md'),
    '---\n마일스톤: M1\n기한: 2026-11-15\n---\n\n## 할 일\n\n| 할 일 | 담당 | 상태 |\n|---|---|---|\n| Task 1 | member-a | 완료 |\n',
    'utf8',
  );

  const workCheckOut = execFileSync(process.execPath, [adkLinkCli, '--check', tmpDir], {
    encoding: 'utf8',
  });
  assert.match(workCheckOut, /work docs: 1 checked, 0 errors/);

  // Add an invalid work doc and verify --check exits 1
  fs.writeFileSync(
    path.join(tmpDir, 'work', 'P-02-bad.md'),
    '---\n마일스톤: INVALID_MS\n기한: 2026-99-99\n---\n',
    'utf8',
  );
  const failedRun = spawnSync(process.execPath, [adkLinkCli, '--check', tmpDir], {
    encoding: 'utf8',
  });
  assert.equal(failedRun.status, 1);
  assert.match(failedRun.stdout, /work docs: 2 checked, 2 errors/);
});

test('10. Agent seat validation: default seat, outside agents/ rejected, ".." rejected, missing seat dir warning, valid agent adk.json passes, project adk.json in seat rejected', (t) => {
  // 1) Seat outside agents/ rejected
  const outsideManifest = makeValidGroupManifest();
  outsideManifest.group_config.agents[0].seat = 'other/developer-agent-adk';
  const rOutside = validateAdkManifest(outsideManifest);
  assert.equal(rOutside.ok, false);
  assert.ok(rOutside.errors.some((e) => e.includes('.seat') && e.includes('agents/')));

  // 2) Seat with ".." or "keys" segment rejected; "./agents/...", "agents//...", "agents/./..." normalized with warning; schema regex matches
  const dotDotManifest = makeValidGroupManifest();
  dotDotManifest.group_config.agents[0].seat = 'agents/../secret-dir';
  const rDotDot = validateAdkManifest(dotDotManifest);
  assert.equal(rDotDot.ok, false);
  assert.ok(rDotDot.errors.some((e) => e.includes('.seat') && e.includes('..')));

  for (const badSeat of ['agents/keys', 'agents/keys/dev-adk', 'agents/.keys/dev-adk', 'agents/sub/../dev-adk', '../agents/dev-adk']) {
    const mBad = makeValidGroupManifest();
    mBad.group_config.agents[0].seat = badSeat;
    const rBad = validateAdkManifest(mBad);
    assert.equal(rBad.ok, false, `Expected bad seat "${badSeat}" to be rejected`);
  }

  for (const normInput of ['./agents/developer-agent-adk', 'agents//developer-agent-adk', 'agents/./developer-agent-adk']) {
    const mNorm = makeValidGroupManifest();
    mNorm.group_config.agents[0].seat = normInput;
    const rNorm = validateAdkManifest(mNorm);
    assert.equal(rNorm.ok, true, `Expected "${normInput}" to normalize and pass: ${rNorm.errors.join('; ')}`);
    assert.ok(
      rNorm.warnings.some((w) => w.includes('seat normalized to agents/developer-agent-adk')),
      `Expected normalization warning for "${normInput}", got: ${rNorm.warnings.join('; ')}`,
    );
  }

  const schemaJson = JSON.parse(fs.readFileSync(path.join(naiaAdkRoot, 'schemas', 'adk-manifest.schema.json'), 'utf8'));
  const seatRegex = new RegExp(schemaJson.properties.group_config.properties.agents.items.properties.seat.pattern);
  assert.equal(seatRegex.test('agents/developer-agent-adk'), true);
  assert.equal(seatRegex.test('agents/sub/developer-agent-adk'), true);
  assert.equal(seatRegex.test('agents/keys-allowed-adk'), true);
  for (const invalidPatternSeat of ['agents/', 'agents//x-adk', 'agents/./x-adk', 'agents/../x-adk', 'agents/x-adk/..', 'agents/keys', 'agents/keys/x-adk', 'agents/.keys/x-adk', 'other/x-adk']) {
    assert.equal(seatRegex.test(invalidPatternSeat), false, `Schema seat pattern should reject "${invalidPatternSeat}"`);
  }

  // 3) Check mode: default seat (absent), missing seat dir = warning not error, valid agent adk.json passes
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-adk-v200-seats-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmpDir, 'keys'), { recursive: true });
  const manifest = makeValidGroupManifest();
  // agent[0] ('developer-agent') omits seat -> defaults to agents/developer-agent-adk
  delete manifest.group_config.agents[0].seat;
  // agent[1] ('support-agent') has explicit seat agents/support-agent-adk (missing on disk)
  manifest.group_config.agents[1].seat = 'agents/support-agent-adk';
  fs.writeFileSync(path.join(tmpDir, 'adk.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // Both seats missing -> ok: true, warnings for seat not created, seatsReadyCount: 0
  const checkMissing = checkAdkInstance(tmpDir);
  assert.equal(checkMissing.ok, true, `Missing seat dirs must be warnings, not errors: ${checkMissing.errors.join('; ')}`);
  assert.deepEqual(checkMissing.groupSummary.open.seats_not_created, ['developer-agent', 'support-agent']);
  assert.equal(checkMissing.groupSummary.seatsReadyCount, 0);
  assert.ok(checkMissing.warnings.some((w) => w.includes('agents/developer-agent-adk') && w.includes('seat not created')));

  // Create default seat dir agents/developer-agent-adk with valid kind="agent" adk.json
  const devSeatDir = path.join(tmpDir, 'agents', 'developer-agent-adk');
  fs.mkdirSync(path.join(devSeatDir, 'keys'), { recursive: true });
  const devAgentManifest = {
    schema_version: '1.0',
    adk_version: '2.0.0',
    id: 'developer-agent-adk',
    name: 'Developer Agent',
    kind: 'agent',
    owner: 'example-group',
    responsible_human: 'group-owner',
    links: [],
    permissions: {
      allowed_roots: ['rules'],
      denied_roots: ['keys'],
      actions: ['read', 'write'],
    },
  };
  fs.writeFileSync(path.join(devSeatDir, 'adk.json'), JSON.stringify(devAgentManifest, null, 2), 'utf8');

  const checkReady = checkAdkInstance(tmpDir);
  assert.equal(checkReady.ok, true, `Valid agent seat should pass: ${checkReady.errors.join('; ')}`);
  assert.equal(checkReady.groupSummary.seatsReadyCount, 1);
  assert.deepEqual(checkReady.groupSummary.open.seats_not_created, ['support-agent']);
  assert.deepEqual(checkReady.groupSummary.open.seats_without_manifest, []);

  // 4) Seat with adk.json of kind "project" -> error
  const badSeatManifest = {
    ...devAgentManifest,
    kind: 'project',
  };
  fs.writeFileSync(path.join(devSeatDir, 'adk.json'), JSON.stringify(badSeatManifest, null, 2), 'utf8');

  const checkWrongKind = checkAdkInstance(tmpDir);
  assert.equal(checkWrongKind.ok, false);
  assert.ok(checkWrongKind.errors.some((e) => e.includes('kind "agent"') && e.includes('project')));
});

test('11. Seat entry doc warning ("agent doc should live in its seat") and group AGENTS.md / .agents/context/ warnings', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naia-adk-v200-round3-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(tmpDir, 'keys'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'agents', 'developer-agent-adk'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'agents', 'README.md'), '# Agents\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'agents', 'developer-agent-adk', 'index.md'), '# Dev Agent Seat\n', 'utf8');

  const manifest = makeValidGroupManifest();
  // developer-agent seat folder exists, but file points outside seat folder -> warning "agent doc should live in its seat"
  manifest.group_config.agents[0].seat = 'agents/developer-agent-adk';
  manifest.group_config.agents[0].file = 'agents/README.md';
  // support-agent seat folder does not exist, file points to agents/README.md -> no "agent doc should live in its seat" warning
  manifest.group_config.agents[1].seat = 'agents/support-agent-adk';
  manifest.group_config.agents[1].file = 'agents/README.md';
  fs.writeFileSync(path.join(tmpDir, 'adk.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // Group dir without AGENTS.md and .agents/context/* still exits 0 in CLI --check, with warnings and open: lines
  const cliRun = spawnSync(process.execPath, [adkLinkCli, '--check', tmpDir], {
    encoding: 'utf8',
  });
  assert.equal(cliRun.status, 0, `Expected exit 0 for group without AGENTS.md, got stderr: ${cliRun.stderr}`);
  assert.match(cliRun.stderr, /entry AGENTS\.md missing/);
  assert.match(cliRun.stderr, /context \.agents\/context\/agents-rules\.json missing/);
  assert.match(cliRun.stderr, /context \.agents\/context\/project-index\.yaml missing/);
  assert.match(cliRun.stderr, /agent doc should live in its seat/);
  assert.match(cliRun.stdout, /^open: entry AGENTS\.md missing$/m);
  assert.match(
    cliRun.stdout,
    /^open: missing context \(2\): \.agents\/context\/agents-rules\.json, \.agents\/context\/project-index\.yaml$/m,
  );

  const checkBefore = checkAdkInstance(tmpDir);
  assert.equal(checkBefore.ok, true);
  assert.ok(
    checkBefore.warnings.some((w) => w.includes('developer-agent') && w.includes('agent doc should live in its seat')),
  );
  assert.ok(
    !checkBefore.warnings.some((w) => w.includes('support-agent') && w.includes('agent doc should live in its seat')),
  );

  // Move developer-agent file into its seat (agents/developer-agent-adk/index.md) and add AGENTS.md + .agents/context/*
  manifest.group_config.agents[0].file = 'agents/developer-agent-adk/index.md';
  fs.writeFileSync(path.join(tmpDir, 'adk.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Group Entry\n', 'utf8');
  fs.mkdirSync(path.join(tmpDir, '.agents', 'context'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.agents', 'context', 'agents-rules.json'), '{"status":"minimal draft"}\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, '.agents', 'context', 'project-index.yaml'), 'version: "2.0"\n', 'utf8');

  const checkAfter = checkAdkInstance(tmpDir);
  assert.equal(checkAfter.ok, true);
  assert.ok(!checkAfter.warnings.some((w) => w.includes('agent doc should live in its seat')));
  assert.ok(!checkAfter.warnings.some((w) => w.includes('entry AGENTS.md missing')));
  assert.ok(!checkAfter.warnings.some((w) => w.includes('context .agents/context/')));
  assert.deepEqual(checkAfter.groupSummary.open.missing_entry, []);
  assert.deepEqual(checkAfter.groupSummary.open.missing_context, []);
});

test('12. Explicit checker list verification: VALID_KINDS includes "group", minimal valid group manifest passes, and "org" is alias-only with warning', () => {
  assert.ok(VALID_KINDS.includes('group'), 'VALID_KINDS must include "group"');
  assert.ok(!VALID_KINDS.includes('org'), '"org" must not be in VALID_KINDS; it is an alias only');
  assert.equal(LEGACY_KIND_ALIASES.org, 'group');

  const minimalGroup = {
    adk_version: '2.0.0',
    id: 'minimal-group',
    kind: 'group',
    owner: 'minimal-group',
    responsible_human: 'group-owner',
    links: [],
    permissions: {
      allowed_roots: ['members'],
      denied_roots: ['keys'],
      actions: ['read'],
    },
    group_config: {
      members: [{ user_id: 'group-owner', access: 'owner' }],
    },
  };
  const rGroup = validateAdkManifest(structuredClone(minimalGroup));
  assert.equal(rGroup.ok, true);
  assert.equal(rGroup.warnings.length, 0);

  const minimalOrgAlias = {
    ...structuredClone(minimalGroup),
    kind: 'org',
  };
  const rOrg = validateAdkManifest(minimalOrgAlias);
  assert.equal(rOrg.ok, true);
  assert.equal(minimalOrgAlias.kind, 'group');
  assert.ok(rOrg.warnings.some((w) => w.includes('kind "org" is deprecated')));
});


