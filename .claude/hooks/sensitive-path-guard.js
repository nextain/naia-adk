#!/usr/bin/env node
/** Claude Code PreToolUse: lexical sensitive-path boundary, never opens target files. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const REASON = '인증서·열쇠 파일은 에이전트 도구로 다루지 않습니다. 사람이 직접 하거나 서명용 크롬을 쓰십시오.';
const DEFAULTS = { directoryNames: ['NPKI', 'GPKI'], extensions: ['.pfx', '.p12', '.der', '.key'], fileNames: ['signPri.key', 'signCert.der', 'kmPri.key'], additionalPaths: [], signingScript: null };
function configWithDefaults(c = {}) {
 const out = { ...DEFAULTS, ...c };
 for (const k of ['directoryNames', 'extensions', 'fileNames', 'additionalPaths']) {
  if (c[k] !== undefined && (!Array.isArray(c[k]) || c[k].some(x => typeof x !== 'string'))) throw Error('Invalid configuration');
  out[k] = [...new Set([...DEFAULTS[k], ...(c[k] || [])])];
 }
 if (out.signingScript !== null && (typeof out.signingScript !== 'string' || !path.isAbsolute(out.signingScript) || /[\s'"`$;&|<>\\]/.test(out.signingScript))) throw Error('Invalid signingScript');
 return out;
}
function expand(s, vars = {}) {
 return String(s).replace(/\\\r?\n/g, '').replace(/\\(.)/gs, '$1').replace(/['"]/g, '')
  .replace(/\$\{([A-Za-z_][\w]*)\}|\$([A-Za-z_][\w]*)/g, (m,a,b) => vars[a || b] ?? (['HOME','USERPROFILE'].includes(a || b) ? (process.env.HOME || '') : m))
  .replace(/^~(?=\/|$)/, process.env.HOME || '~');
}
function globRegex(s) {
 let out = '';
 for (let i=0;i<s.length;i++) { const ch=s[i]; if(ch==='*') out+='.*'; else if(ch==='?') out+='.'; else if(ch==='[') { const end=s.indexOf(']',i+1); if(end>i) { out+=s.slice(i,end+1).replace(/^\[!/, '[^'); i=end; } else out+='\\['; } else out+=ch.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
 try { return new RegExp('^'+out+'$', 'i'); } catch { return /$a/; }
}
function sensitivePath(value, config = {}, cwd = process.cwd()) {
 const c=configWithDefaults(config), s=expand(value).replace(/\\/g,'/');
 for(const extra of c.additionalPaths) { const base=path.resolve(cwd,expand(extra)); const whole=path.resolve(cwd,s); if(whole===base || whole.startsWith(base+path.sep)) return true; }
 const pieces=s.split(/[\s:;,=<>|&(){}]+/).filter(Boolean);
 for (const piece of pieces) {
  const parts=[...piece.split('/'), ...path.resolve(cwd,expand(piece)).split(path.sep)].filter(Boolean);
  for (const segment of parts) {
   if(c.directoryNames.some(x => globRegex(segment).test(x))) return true;
   if(c.fileNames.some(x => globRegex(segment).test(x))) return true;
   if(c.extensions.some(ext => new RegExp(ext.replace('.', '\\.')+'$', 'i').test(segment))) return true;
   // Wildcards are denied when they could select a protected filename, including **/*.key.
   if (/[?*[]/.test(segment)) {
    const sample=segment.replace(/\[[^\]]*\]/g,'a').replace(/\?/g,'a').replace(/\*/g,'');
    if(c.extensions.some(ext => Array.from({length:sample.length+1},(_,i)=>sample.slice(0,i)+ext).some(candidate=>globRegex(segment).test(candidate)))) return true;
   }
  }
  const resolved=path.resolve(cwd, expand(piece));
  for(const extra of c.additionalPaths) {
   const base=path.resolve(cwd,expand(extra));
   if(resolved===base || resolved.startsWith(base+path.sep)) return true;
   // Compare glob segments against configured paths without touching the filesystem.
   if (/[?*[]/.test(piece) && (globRegex(path.resolve(cwd,piece)).test(base) || globRegex(path.resolve(cwd,piece)).test(base+'/guard-probe'))) return true;
  }
 }
 return false;
}
function containsSensitiveContent(v) {
 const s=typeof v==='string'?v:JSON.stringify(v);
 return /BEGIN (?:ENCRYPTED )?PRIVATE KEY|signPri\.key/i.test(s) || /\bMII/.test(s);
}
function strings(v) { if(typeof v==='string') return [v]; if(v && typeof v==='object') return Object.values(v).flatMap(strings); return []; }
function git(args,cwd) { return cp.execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:32*1024*1024,timeout:10000,stdio:['ignore','pipe','pipe']}); }
function gitContentGuard(command,cwd,c,original=command) {
 if(!/\bgit\b[^\n;&|]*\b(?:commit|push)\b/.test(command)) return false;
 if(/[;&|\n\r]/.test(command) || /\bGIT_[A-Za-z_]+\s*=/.test(command)) return true;
 const tokens=(original.match(/(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g)||[]).map(token=>expand(token));
 if(tokens[0]!=='git' || !['commit','push'].includes(tokens[1])) return true;
 if(tokens[1]==='commit') {
  // Only stage-preserving commit forms: no implicit staging, message files, hooks options, or pathspecs.
  for(let i=2;i<tokens.length;i++) {
   if(tokens[i]==='-m' || tokens[i]==='--message') { if(++i>=tokens.length) return true; }
   else if(!tokens[i].startsWith('--message=')) return true;
  }
 }
 if(/\bcd\b|\bpushd\b/.test(command)) return true;
 if(/\bgit\s+(?:(?:-C|--git-dir|--work-tree|--namespace|-c)(?:\s|=)|[^\n;&|]*\s(?:-C|--git-dir|--work-tree|--namespace)(?:\s|=))/.test(command)) return true;
 try {
  // Check names before requesting any content. Never read a protected working-tree file.
  const names=git(['diff','--cached','--name-only','-z'],cwd).split('\0').filter(Boolean);
  if(names.some(n=>sensitivePath(n,c,cwd))) return true;
  if(containsSensitiveContent(git(['diff','--cached','--no-ext-diff','--no-textconv','--unified=0'],cwd))) return true;
  const staged=git(['diff','--cached','--name-only','--diff-filter=ACMR','-z'],cwd).split('\0').filter(Boolean);
  if(staged.length>256) return true;
  for(const name of staged) if(containsSensitiveContent(git(['show',':'+name],cwd))) return true;
  if(/\bpush\b/.test(command)) {
   // Include committed payloads awaiting publication, even if staging is empty.
   const history=['HEAD','--branches','--tags','--not','--remotes'];
   const changed=git(['log','--format=','--name-only','-z',...history],cwd).split(/[\0\n]/).filter(Boolean);
   if(changed.some(n=>sensitivePath(n,c,cwd))) return true;
   if(containsSensitiveContent(git(['log','--format=%B','--patch','--no-ext-diff','--no-textconv',...history],cwd))) return true;
   const objects=git(['rev-list','--objects',...history],cwd).trim().split('\n').filter(Boolean);
   if(objects.length>1024) return true;
   if(objects.some(line=>sensitivePath(line.slice(line.indexOf(' ')+1),c,cwd))) return true;
   if(objects.length && containsSensitiveContent(cp.execFileSync('git',['cat-file','--batch'],{cwd,input:objects.map(line=>line.split(' ')[0]).join('\n')+'\n',encoding:'utf8',maxBuffer:32*1024*1024,timeout:10000,stdio:['pipe','pipe','pipe']}))) return true;
  }
 } catch { return true; } // Uninspectable publication is denied, with no target contents emitted.
 return false;
}
async function evaluate(data, config = {}) {
 const c=configWithDefaults(config), name=data.tool_name || '', input=data.tool_input || {}, cwd=data.cwd || process.cwd();
 if(name==='Bash' || name==='shell_command') {
  const command=input.command || '';
  if(c.signingScript && command===c.signingScript) return null;
  if(sensitivePath(cwd,c,cwd)) return {reason:REASON};
  const vars={};
  for(const m of command.matchAll(/\b([A-Za-z_][\w]*)=("[^"\n]*"|'[^'\n]*'|[^\s;]+)/g)) vars[m[1]]=expand(m[2],vars);
  const expanded=expand(command,vars);
  if(/\$|`|[{}]/.test(expanded) || sensitivePath(expanded,c,cwd) || containsSensitiveContent(expanded) || gitContentGuard(expanded,cwd,c,command)) return {reason:REASON};
 } else if(/^(Read|Edit|Write|NotebookEdit|MultiEdit|Grep|Glob|apply_patch)$/.test(name)) {
  const paths=Object.entries(input).filter(([key])=>/path|file|glob|pattern|include/i.test(key)).flatMap(([,v])=>strings(v));
  if(paths.some(v=>sensitivePath(v,c,cwd))) return {reason:REASON};
 } else if(/send|mail|discord|message|commit|push/i.test(name)) {
  if(strings(input).some(v=>sensitivePath(v,c,cwd) || containsSensitiveContent(v))) return {reason:REASON};
 }
 return null;
}
async function main() {
 try {
  let raw=''; for await(const chunk of process.stdin) raw+=chunk;
  const data=JSON.parse(raw);
  const filename=process.env.SENSITIVE_PATH_GUARD_CONFIG || path.join(__dirname,'sensitive-path-guard.config.json');
  let c={}; try { c=JSON.parse(fs.readFileSync(filename,'utf8')); } catch(e) { if(e.code!=='ENOENT' || process.env.SENSITIVE_PATH_GUARD_CONFIG) throw e; }
  const decision=await evaluate(data,c);
  if(decision) process.stdout.write(JSON.stringify({decision:'block',reason:decision.reason}));
 } catch { process.stdout.write(JSON.stringify({decision:'block',reason:REASON})); }
}
if(require.main===module) main();
module.exports={evaluate,sensitivePath,containsSensitiveContent,REASON,DEFAULTS};
