#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
// 승인 양식의 문서 주소 검사. 서버(packages/server/src/messenger-store.ts approvalDocPattern)와 같은 규칙:
// 첫 "3. 문서:" 줄만 본다. NAIA_DASHBOARD_PUBLIC_URL 이 있으면 그 원점 아래 /d/ 만, 없으면 아무 https 주소의 /d/.
// 값이 있는데 https 원점(https://호스트[:포트]) 꼴이 아니면 어떤 양식도 받지 않는다.
export function approvalDocOk(content, env = process.env) {
  const raw = String(env.NAIA_DASHBOARD_PUBLIC_URL ?? '').trim();
  const origin = raw.replace(/\/+$/, '');
  if (raw && !/^https:\/\/[^\s/?#@]+$/.test(origin)) return false;
  const base = raw ? origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : 'https:\\/\\/[^\\s/]+';
  const line = content.match(/3\.\s*문서:[^\r\n]*/)?.[0];
  return !!line && new RegExp(`^3\\.\\s*문서:\\s*${base}\\/d\\/[^\\s]+`).test(line);
}
// 승인을 묻는 글은 #업무-요청 에 양식으로만 올린다. 서버도 같은 채널·같은 문서 규칙으로만 승인 카드를 만든다.
export function validateApproval(content, channelName, env = process.env) {
  const asksApproval = /(승인|허락|허가)\s*(해\s*주|부탁|주시면|주세요|여쭙|요청드)|올려\s*라고|"올려"\s*라고|코드\s*(를\s*)?주시면/.test(content);
  if (asksApproval) {
    const formatted = /1\.\s*제목:\s*\[/.test(content) && /2\.\s*요약:/.test(content) && approvalDocOk(content, env) && /4\.\s*승인 코드/.test(content);
    if (channelName !== '업무-요청') throw new Error("승인 묻는 글은 #업무-요청 에 양식으로만 올림: 이 채널에는 '올렸습니다(글 번호)'만");
    if (!formatted) throw new Error('승인 양식 아님: 1. 제목: [분류] 조치 / 2. 요약: / 3. 문서: https://<대시보드 주소>/d/키 (NAIA_DASHBOARD_PUBLIC_URL 이 있으면 그 주소) / 4. 승인 코드 (다음 글)');
  }
}
export function createClient({ url, token, fetchImpl = fetch }) {
  if (!url || !token) throw new Error('NAIA_MESSENGER_URL과 토큰을 설정하세요');
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('HTTP(S) 서버 주소가 필요합니다');
  const prefix = base.href.replace(/\/$/, '') + '/api/portal/messenger';
  async function request(path, options = {}) {
    const response = await fetchImpl(prefix + path, { ...options, redirect: 'error', headers: { 'X-AX-Agent-Token': token, ...options.headers } });
    if (!response.ok) throw new Error(`메신저 요청 실패 (${response.status})`);
    return response;
  }
  const json = async (path, value) => { const response = await request(path, value === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(value) }); const text = await response.text(); return text ? JSON.parse(text) : null; };
  const channels = () => json('/channels');
  async function channel(value) {
    const found = (await channels()).find(item => item.id === value || item.name === value);
    if (!found) throw new Error('채널을 찾지 못했습니다');
    return found;
  }
  return { request, channels,
    async post(value, reply, bodyFile, attachments = []) {
      const ch = await channel(value), body = readFileSync(bodyFile, 'utf8');
      if (!body.trim() || body.length > 64000) throw new Error('본문은 1~64000자입니다');
      validateApproval(body, ch.name);
      const files = attachments.map(path => ({name:basename(path), bytes:readFileSync(path)}));
      for (const file of files) {
        if (file.bytes.length > 25 * 1024 * 1024 || !/^[^.]+\.(png|jpg|webp|gif|pdf|txt|md|csv|json|zip)$/i.test(file.name)) throw new Error('첨부 확장자 또는 25MB 제한을 확인하세요');
      }
      const message = await json(`/channels/${encodeURIComponent(ch.id)}/messages`, { body, ...(reply === '-' ? {} : {reply_to_id:reply}) });
      for (const file of files) {
        const form = new FormData(); form.append('file', new Blob([file.bytes]), file.name);
        try { await request(`/attachments?message_id=${encodeURIComponent(message.id)}`, {method:'POST', body:form}); }
        catch (error) { throw new Error(`글 ${message.id} 전송 완료, 첨부 실패: ${error.message}`); }
      }
      return message;
    },
    async read(value, since) {
      const ch = await channel(value); let before, result = []; const seen = new Set();
      do {
        const query = new URLSearchParams({limit:'50', ...(before ? {before} : {})});
        const page = (await json(`/channels/${encodeURIComponent(ch.id)}/messages?${query}`)).messages;
        if (!Array.isArray(page)) throw new Error('잘못된 글 목록 응답');
        result.push(...page.filter(m => !since || m.id > since));
        if (!since || page.length < 50 || page.some(m => m.id <= since)) break;
        before = page.reduce((a,m) => a < m.id ? a : m.id, page[0].id);
        if (seen.has(before)) throw new Error('글 목록 페이지가 반복됩니다');
        seen.add(before);
      } while (true);
      return result.sort((a,b) => a.id.localeCompare(b.id));
    },
    react: (id,emoji) => { if (!emoji || Buffer.byteLength(emoji) > 32) throw new Error('이모지는 32바이트까지입니다'); return json(`/messages/${encodeURIComponent(id)}/reactions`, {emoji}); },
  };
}
export async function watch(client, { role, signal, output = line => console.log(line), reconnectMs = 1000 } = {}) {
  if (!role || !/^[\p{L}\p{N}_-]+$/u.test(role)) throw new Error('watch에는 --role 또는 NAIA_MESSENGER_ROLE이 필요합니다');
  let lastId = ''; const seen = new Set();
  const mention = new RegExp(`(^|[^\\p{L}\\p{N}_@-])@${role}(?![\\p{L}\\p{N}_-])`, 'u');
  while (!signal?.aborted) {
    try {
      const response = await client.request('/stream', {signal, headers:{Accept:'text/event-stream', ...(lastId ? {'Last-Event-ID':lastId} : {})}});
      let buffer = '';
      const decoder = new TextDecoder();
      const consume = block => {
        let event = 'message', id, data = [];
        for (const line of block.split('\n')) {
          const colon = line.indexOf(':'); const key = colon < 0 ? line : line.slice(0,colon); const value = colon < 0 ? '' : line.slice(colon+1).replace(/^ /,'');
          if (key === 'event') event = value; else if (key === 'id') id = value; else if (key === 'data') data.push(value);
        }
        if (id !== undefined && !id.includes('\0')) lastId = id;
        if (event !== 'message' || !data.length) return;
        const payload = JSON.parse(data.join('\n')), message = payload.message ?? payload;
        if (id && seen.has(id)) return;
        if (id) { seen.add(id); if (seen.size > 1000) seen.delete(seen.values().next().value); }
        if (typeof message.body === 'string' && mention.test(message.body)) output(JSON.stringify(message));
      };
      let pendingCarriage = '';
      const append = (text, final = false) => {
        text = pendingCarriage + text;
        pendingCarriage = !final && text.endsWith('\r') ? '\r' : '';
        if (pendingCarriage) text = text.slice(0,-1);
        buffer += text.replace(/\r\n|\r/g,'\n');
        let end; while ((end = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0,end)); buffer = buffer.slice(end+2); }
      };
      for await (const chunk of response.body) append(decoder.decode(chunk, {stream:true}));
      append(decoder.decode(), true);
    } catch (error) { if (signal?.aborted) return; if (/\((401|403)\)/.test(error.message)) throw error; }
    try { await delay(reconnectMs, undefined, {signal}); } catch { return; }
  }
}
export async function main(args = process.argv.slice(2), env = process.env) {
  function option(name) { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index+1] || args[index+1].startsWith('--')) throw new Error(`${name} 값이 필요합니다`); return args.splice(index,2)[1]; }
  const tokenFile = option('--token-file'), role = option('--role') ?? env.NAIA_MESSENGER_ROLE, since = option('--since');
  const client = createClient({url:env.NAIA_MESSENGER_URL, token:env.NAIA_MESSENGER_TOKEN || (tokenFile ? readFileSync(tokenFile,'utf8').trim() : '')});
  const [command,...rest] = args;
  if (command === 'watch' && !rest.length && !since) { const controller = new AbortController(); const stop = () => controller.abort(); process.once('SIGINT',stop); process.once('SIGTERM',stop); try { await watch(client,{role,signal:controller.signal}); } finally { process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop); } return; }
  let result;
  if (command === 'post' && rest.length >= 3 && !since) result = await client.post(...rest.slice(0,3),rest.slice(3));
  else if (command === 'read' && rest.length === 1) result = await client.read(rest[0],since);
  else if (command === 'react' && rest.length === 2 && !since) result = await client.react(...rest);
  else if (command === 'channels' && !rest.length && !since) result = await client.channels();
  else throw new Error('msg.mjs post <채널> <답글id|-> <본문파일> [첨부] | read <채널> [--since id] | react <글id> <이모지> | channels | watch --role <역할>');
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode=1; });
