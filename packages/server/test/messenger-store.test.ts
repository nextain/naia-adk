import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessengerStore, approvalDocPattern, approvalDocWarning, isApprovalForm } from '../src/messenger-store.js';
// Fixture roles; a real install names its own in NAIA_MESSENGER_ROLES (default: naia).
process.env.NAIA_MESSENGER_ROLES = 'coder,planner,reviewer,writer,naia,designer'
// Approval documents must live on this dashboard.
process.env.NAIA_DASHBOARD_PUBLIC_URL = 'https://dashboard.example.com'
const human = { id: 'owner', kind: 'human' as const };
const agent = { id: 'coder', kind: 'agent' as const };
const form = '1. 제목: [배포] 실행\n2. 요약: 확인\n3. 문서: https://dashboard.example.com/d/key\n4. 승인 코드';
const stores: MessengerStore[] = [];
function store(path = ':memory:') { const s = new MessengerStore(path, () => 1_800_000_000_000); stores.push(s); return s; }
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
describe('messenger storage', () => {
  it('writes and reads 64000 characters, replies, reactions and monotonic read cursors', () => {
    const s = store();
    const first = s.createMessage('업무-요청',agent,'가'.repeat(64000));
    expect(s.message(first.id,human)?.body.length).toBe(64000);
    expect(() => s.createMessage('업무-요청',human,'가'.repeat(64001))).toThrow();
    const reply = s.createMessage('업무-요청',human,'답',first.id);
    expect(reply.thread_root_id).toBe(first.id);
    s.react(first.id,human,'👍'); s.react(first.id,human,'👍'); s.react(first.id,agent,'👍');
    expect(s.message(first.id,human)?.reactions).toEqual([{emoji:'👍',count:2,mine:true}]);
    s.react(first.id,human,'👍',true);
    expect(s.message(first.id,human)?.reactions).toEqual([{emoji:'👍',count:1,mine:false}]);
    expect(s.messages('업무-요청',human,reply.id).map(m => m.id)).toEqual([first.id]);
    s.markRead('업무-요청',human,reply.id); s.markRead('업무-요청',human,first.id);
    expect(s.channels(human).find(c => c.id === '업무-요청')?.unread).toBe(0);
    expect(() => s.createMessage('자유',human,'잘못된 답',first.id)).toThrow();
    expect(() => s.markRead('자유',human,first.id)).toThrow();
  });
  it('allows only human approval of a form and posts its exact codes', () => {
    const s = store();
    const request = s.createMessage('업무-요청',agent,`${form}\nPLAN-ABC123 STEP-DEF456`);
    expect(request.approval?.status).toBe('pending');
    expect(() => s.decideApproval(request.id,agent,'approve')).toThrow('Human');
    const approved = s.decideApproval(request.id,human,'approve');
    expect(approved.message.approval?.status).toBe('approved');
    expect(approved.codeMessage).toMatchObject({body:'PLAN-ABC123 STEP-DEF456',author_kind:'human',author_id:'owner'});
    expect(() => s.decideApproval(request.id,human,'approve')).toThrow('already');
    const ordinary = s.createMessage('업무-요청',agent,'PLAN-ABC123 STEP-DEF456');
    expect(() => s.decideApproval(ordinary.id,human,'approve')).toThrow('form');
  });
  it('pairs the next code message with the same author form, and supports rejection', () => {
    const s = store();
    const request = s.createMessage('업무-요청',agent,form);
    s.createMessage('업무-요청',agent,'PLAN-000000 STEP-111111');
    expect(s.message(request.id,human)?.approval?.status).toBe('pending');
    expect(s.decideApproval(request.id,human,'reject').codeMessage).toBeUndefined();
    expect(s.message(request.id,human)?.approval?.status).toBe('rejected');
  });
  it('creates private DMs with isolated membership and validates next-message identity kind', () => {
    const s = store();
    const dm = s.channels(human).find(c => c.id === 'dm:owner:coder')!;
    expect(dm.kind).toBe('dm');
    expect(s.canAccess(String(dm.id),human)).toBe(true);
    expect(s.canAccess(String(dm.id),agent)).toBe(true);
    expect(s.canAccess(String(dm.id),{id:'reviewer',kind:'agent'})).toBe(false);
    expect(s.channels({id:'reviewer',kind:'agent'}).some(c => c.id === dm.id)).toBe(false);
    // Same name, other kind: a human logged in as "coder" is not the coder agent, and an agent named "owner" is not owner.
    expect(s.canAccess(String(dm.id),{id:'coder',kind:'human'})).toBe(false);
    expect(s.canAccess(String(dm.id),{id:'owner',kind:'agent'})).toBe(false);
    expect(s.channels({id:'coder',kind:'human'}).some(c => c.id === dm.id)).toBe(false);
    expect(s.channels({id:'owner',kind:'agent'}).some(c => c.id === dm.id)).toBe(false);
    const request = s.createMessage('업무-요청',agent,form);
    s.createMessage('업무-요청',{id:agent.id,kind:'human'},'PLAN-000000 STEP-111111');
    expect(s.message(request.id,human)?.approval).toBeNull();
    expect(() => s.createMessage('missing',human,'hello')).toThrow('Channel not found');
    try { s.createMessage('missing',human,'hello'); } catch (error) { expect(error).toMatchObject({statusCode:404}); }
  });
  it('pins the approval document to NAIA_DASHBOARD_PUBLIC_URL, or any https host when it is unset', () => {
    const doc = (url: string) => `3. 문서: ${url}`;
    expect(approvalDocPattern({}).test(doc('https://any.example/d/k'))).toBe(true);
    expect(approvalDocPattern({}).test(doc('http://any.example/d/k'))).toBe(false);
    const pinned = approvalDocPattern({ NAIA_DASHBOARD_PUBLIC_URL: 'https://dash.example.org/' });
    expect(pinned.test(doc('https://dash.example.org/d/k'))).toBe(true);
    for (const url of ['https://dashXexample.org/d/k', 'https://dash.example.org.evil/d/k', 'https://evil.example/d/k']) expect(pinned.test(doc(url))).toBe(false);
  });
  it('reads only the first 3. 문서 line, so a later allowed line cannot vouch for an outside one', () => {
    const twoLines = form.replace('3. 문서: https://dashboard.example.com/d/key', '3. 문서: https://evil.test/login\n3. 문서: https://dashboard.example.com/d/a1');
    expect(isApprovalForm(twoLines)).toBe(false);
    expect(isApprovalForm(twoLines, {})).toBe(false);
    expect(store().createMessage('업무-요청',agent,`${twoLines}\nPLAN-ABC123 STEP-DEF456`).approval).toBeNull();
    expect(isApprovalForm(form)).toBe(true);
  });
  it('accepts no approval form when NAIA_DASHBOARD_PUBLIC_URL is set but not an https origin, and says so', () => {
    for (const bad of ['http://localhost:3242', 'https://dashboard.example.com/sub', 'dashboard.example.com', 'https://a@evil.test']) {
      const env = { NAIA_DASHBOARD_PUBLIC_URL: bad };
      expect(isApprovalForm(form.replace('dashboard.example.com', 'evil.test'), env)).toBe(false);
      expect(isApprovalForm(form, env)).toBe(false);
      expect(approvalDocWarning(env)).toMatch(/not an https origin/);
    }
    expect(approvalDocWarning({})).toBeUndefined();
    expect(approvalDocWarning({ NAIA_DASHBOARD_PUBLIC_URL: 'https://dashboard.example.com:8443/' })).toBeUndefined();
  });
  it('creates approval cards only for dashboard.example.com forms in #업무-요청', () => {
    const s = store();
    expect(s.createMessage('업무-요청',agent,`${form.replace('dashboard.example.com','evil.example')}\nPLAN-ABC123 STEP-DEF456`).approval).toBeNull();
    expect(s.createMessage('자유',agent,`${form}\nPLAN-ABC123 STEP-DEF456`).approval).toBeNull();
    const dm = String(s.channels(human).find(c => c.kind === 'dm')!.id);
    expect(s.createMessage(dm,agent,`${form}\nPLAN-ABC123 STEP-DEF456`).approval).toBeNull();
    expect(s.createMessage('업무-요청',agent,`${form}\nPLAN-ABC123 STEP-DEF456`).approval?.status).toBe('pending');
  });
  it('migrates kind-less DM membership from an earlier database', () => {
    const path = join(mkdtempSync(join(tmpdir(),'messenger-store-')),'db.sqlite');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('channel','dm')),created_at INTEGER NOT NULL);
      CREATE TABLE channel_members(channel_id TEXT NOT NULL REFERENCES channels(id),member_id TEXT NOT NULL,PRIMARY KEY(channel_id,member_id));
      INSERT INTO channels VALUES ('dm:owner:coder','owner · coder','dm',1);
      INSERT INTO channel_members VALUES ('dm:owner:coder','owner'),('dm:owner:coder','coder');`);
    old.close();
    const s = store(path);
    expect(s.canAccess('dm:owner:coder',human)).toBe(true);
    expect(s.canAccess('dm:owner:coder',agent)).toBe(true);
    expect(s.canAccess('dm:owner:coder',{id:'coder',kind:'human'})).toBe(false);
  });
  it('keeps reactions, read cursors and unread "mine" apart for a human and an agent with the same name', () => {
    const s = store();
    const person = { id: 'coder', kind: 'human' as const };
    const own = s.createMessage('자유',agent,'에이전트 글');
    expect(s.channels(person).find(c => c.id === '자유')?.unread).toBe(1);
    expect(s.channels(agent).find(c => c.id === '자유')?.unread).toBe(0);
    s.react(own.id,agent,'👍');
    expect(s.message(own.id,agent)?.reactions).toEqual([{emoji:'👍',count:1,mine:true}]);
    expect(s.message(own.id,person)?.reactions).toEqual([{emoji:'👍',count:1,mine:false}]);
    s.react(own.id,person,'👍');
    expect(s.message(own.id,person)?.reactions).toEqual([{emoji:'👍',count:2,mine:true}]);
    s.react(own.id,agent,'👍',true);
    expect(s.message(own.id,person)?.reactions).toEqual([{emoji:'👍',count:1,mine:true}]);
    const later = s.createMessage('자유',human,'사람 글');
    s.markRead('자유',agent,later.id);
    expect(s.channels(agent).find(c => c.id === '자유')?.unread).toBe(0);
    expect(s.channels(person).find(c => c.id === '자유')?.unread).toBe(2);
  });
  it('migrates kind-less reactions and read cursors from an earlier database as human', () => {
    const path = join(mkdtempSync(join(tmpdir(),'messenger-store-')),'db.sqlite');
    const first = store(path); const message = first.createMessage('자유',agent,'옛 글');
    first.close(); stores.splice(stores.indexOf(first),1);
    const old = new DatabaseSync(path);
    old.exec(`DROP TABLE reactions; DROP TABLE read_cursors;
      CREATE TABLE reactions(message_id TEXT NOT NULL REFERENCES messages(id),author_id TEXT NOT NULL,emoji TEXT NOT NULL,PRIMARY KEY(message_id,author_id,emoji));
      CREATE TABLE read_cursors(channel_id TEXT NOT NULL REFERENCES channels(id),reader_id TEXT NOT NULL,last_message_id TEXT NOT NULL REFERENCES messages(id),updated_at INTEGER NOT NULL,PRIMARY KEY(channel_id,reader_id));`);
    old.prepare('INSERT INTO reactions VALUES (?,?,?)').run(message.id,'owner','👍');
    old.prepare('INSERT INTO read_cursors VALUES (?,?,?,?)').run('자유','owner',message.id,1);
    old.close();
    const s = store(path);
    expect(s.message(message.id,human)?.reactions).toEqual([{emoji:'👍',count:1,mine:true}]);
    expect(s.message(message.id,{id:'owner',kind:'agent'})?.reactions).toEqual([{emoji:'👍',count:1,mine:false}]);
    expect(s.channels(human).find(c => c.id === '자유')?.unread).toBe(0);
  });
  it('persists messages and ordered replay events across restart', () => {
    const path = join(mkdtempSync(join(tmpdir(),'messenger-store-')),'db.sqlite');
    const s = store(path); const message = s.createMessage('자유',human,'saved');
    const first = s.addEvent('message',message); s.addEvent('read',{reader_id:'owner'});
    s.close(); stores.splice(stores.indexOf(s),1);
    const reopened = store(path);
    expect(reopened.message(message.id,human)?.body).toBe('saved');
    expect(reopened.eventsAfter(first.id)).toEqual([{id:first.id+1,type:'read',data:{reader_id:'owner'}}]);
  });
});
describe('messenger file permissions', () => {
  const mode = (path: string) => statSync(path).mode & 0o777;
  const withUmask = <T>(run: () => T): T => { const previous = process.umask(0o022); try { return run(); } finally { process.umask(previous); } };
  it('creates the folder 0700 and the DB, WAL and SHM files 0600 under umask 022', () => {
    withUmask(() => {
      const dir = join(mkdtempSync(join(tmpdir(), 'messenger-perm-')), 'parent', 'messenger');
      const path = join(dir, 'messenger.db');
      const s = store(path);
      s.createMessage('자유', human, '글');
      expect(mode(dir)).toBe(0o700);
      expect(mode(join(dir, '..'))).toBe(0o755);
      for (const file of [path, `${path}-wal`, `${path}-shm`]) { expect(existsSync(file)).toBe(true); expect(mode(file)).toBe(0o600); }
      expect(s.permissionWarning).toBeUndefined();
    });
  });
  it('tightens files that already exist', () => {
    withUmask(() => {
      const dir = mkdtempSync(join(tmpdir(), 'messenger-perm-'));
      const path = join(dir, 'messenger.db');
      store(path).createMessage('자유', human, '글');
      stores.splice(0).forEach(s => s.close());
      chmodSync(path, 0o644);
      const s = store(path);
      s.createMessage('자유', human, '둘째');
      for (const file of [path, `${path}-wal`, `${path}-shm`]) expect(mode(file)).toBe(0o600);
    });
  });
  it('warns about an open folder and leaves it as it is', () => {
    withUmask(() => {
      const dir = join(mkdtempSync(join(tmpdir(), 'messenger-perm-')), 'open');
      mkdirSync(dir, { mode: 0o755 });
      const s = store(join(dir, 'messenger.db'));
      expect(mode(dir)).toBe(0o755);
      expect(s.permissionWarning).toContain('755');
    });
  });
  it('does not touch the file a linked DB path points at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'messenger-perm-'));
    const target = join(dir, 'other'); writeFileSync(target, ''); chmodSync(target, 0o644);
    symlinkSync(target, join(dir, 'messenger.db'));
    expect(() => new MessengerStore(join(dir, 'messenger.db'))).toThrow();
    expect(mode(target)).toBe(0o644);
  });
  it('remembers the latest display name of a person', () => {
    const s = store();
    const id = s.createMessage('자유', human, '글').id;
    expect(s.message(id, human)?.author_name).toBeNull();
    s.rememberHumanName('owner', '운영자');
    expect(s.message(id, human)?.author_name).toBe('운영자');
    s.rememberHumanName('owner', '운영자 대리');
    expect(s.message(id, agent)?.author_name).toBe('운영자 대리');
    const byAgent = s.createMessage('자유', { id: 'owner', kind: 'agent' }, '에이전트');
    expect(s.message(byAgent.id, human)?.author_name).toBeNull();
  });
});
