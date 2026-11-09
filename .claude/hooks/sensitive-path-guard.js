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
// Resolve lexically: never enumerate or open protected targets (including symlink targets).
function bases(c, cwd) {
 return [...c.directoryNames.map(n=>path.resolve(process.env.HOME || cwd,n)), ...c.additionalPaths.map(n=>path.resolve(cwd,expand(n)))];
}
function within(p,b) { p=p.toLowerCase(); b=b.toLowerCase(); return p===b || p.startsWith(b+path.sep); }
function sensitivePath(value, config = {}, cwd = process.cwd(), options = {}) {
 const c=configWithDefaults(config), s=expand(value).replace(/^@/,'');
 const resolved=path.resolve(cwd,s), parts=s.split(/[\\/]/);
 if(parts.some(p=>c.fileNames.some(n=>n.toLowerCase()===p.toLowerCase() || (/[a-z]/i.test(p.replace(/\.(?:key|der|pfx|p12)$/i,'')) && /[?*[]/.test(p) && globRegex(p).test(n))))) return true;
 for(const base of bases(c,cwd)) {
  if(within(resolved,base) || (options.recursive && within(base,resolved))) return true;
  if(/[?*[]/.test(s)) {
   // Only paths whose fixed prefix reaches a protected root, or hinted name patterns.
   const prefix=resolved.split(/[?*[]/)[0].replace(/\/$/,'');
   if(within(prefix,base)) return true;
   const segments=resolved.split(path.sep);
   if(segments.some((segment,i)=>/[a-z0-9]/i.test(segment) && /[?*[]/.test(segment) && globRegex(segment).test(path.basename(base)) && within(base,segments.slice(0,i).join(path.sep) || path.sep))) return true;
   if(parts.some(p=>/[a-z0-9]/i.test(p) && /[?*[]/.test(p) && [...c.directoryNames,...c.fileNames].some(n=>globRegex(p).test(n)))) {
    if(within(base,path.dirname(resolved)) || globRegex(resolved).test(base)) return true;
   }
  }
 }
 // Extension rules concern existing file operands only; stat never reads file contents.
 if(options.extensions && c.extensions.includes(path.extname(s).toLowerCase())) {
  try { if(fs.statSync(resolved).isFile()) return true; } catch {}
 }
 return false;
}
function containsSensitiveContent(v, names=true) {
 const s=typeof v==='string'?v:JSON.stringify(v);
 return /BEGIN (?:ENCRYPTED )?PRIVATE KEY/i.test(s) || /\bMII[A-Za-z0-9+/=]{60,}/.test(s) || (names && /\b(?:signPri\.key|kmPri\.key|signCert\.der)\b/i.test(s));
}
function gitPayload(s) { return /^\s*-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----\s*$/m.test(s) || /^\s*MII[A-Za-z0-9+/=]{60,}/m.test(s); }
function strings(v) { if(typeof v==='string') return [v]; if(v && typeof v==='object') return Object.values(v).flatMap(strings); return []; }
const {shellClauses}=require('./lib/git-command-parser');
const {normalizedToolName}=require('./tool-names');
function patchPaths(s) {
 return [...String(s).matchAll(/^(?:\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: |\+\+\+ b\/|--- a\/)(.+)$/gm)].map(m=>m[1].trim());
}
function gitContentGuard(tokens,cwd,c) {
 if(!/^(?:.*\/)?git$/.test(tokens[0] || '')) return false;
 let i=1; const globals=[];
 while(tokens[i]?.startsWith('-')) {
  const t=tokens[i++];
  if(t==='-C') {cwd=path.resolve(cwd,expand(tokens[i++] || '')); continue;}
  globals.push(t);
  if(['-c','--git-dir','--work-tree','--namespace','--config-env'].includes(t)) globals.push(tokens[i++]);
 }
 const sub=tokens[i++]; if(!['commit','push'].includes(sub)) return false;
 const args=tokens.slice(i);
 for(let j=0;j<args.length;j++) {
  if(sub==='commit' && (['-F','--file'].includes(args[j]) || args[j].startsWith('--file='))) {
   const file=path.resolve(cwd,expand(args[j].startsWith('--file=')?args[j].slice(7):(args[++j] || '')));
   if(sensitivePath(file,c,cwd,{extensions:true})) return true;
   try {if(containsSensitiveContent(fs.readFileSync(file,'utf8'),false)) return true;} catch {return true;}
  }
  if(sub==='commit' && ['-m','--message'].includes(args[j]) && containsSensitiveContent(args[++j] || '',false)) return true;
 }
 try {
  let gitArgs;
  if(sub==='commit') {
   // One process, independent of file count. -a/paths and preceding git add need worktree diff.
   const values=new Set(['-m','--message','-F','--file','-C','--reuse-message','-c','--reedit-message','--author','--date','--cleanup','--trailer']);
   let positional=false, all=false;
   for(let j=0;j<args.length;j++) {if(values.has(args[j])) {j++;continue;} if(!args[j].startsWith('-')) positional=true; if(/^-[^-]*a/.test(args[j]) || args[j]==='--all') all=true;}
   const implicit=all || positional || tokens.pendingAdd;
   gitArgs=['diff',...(implicit?['HEAD']:['--cached']),'--no-ext-diff','--no-textconv','--unified=0','--no-renames'];
  } else {
   const positional=args.filter(a=>!a.startsWith('-'));
   const specs=positional.slice(1);
   const refs=args.includes('--all')?['--branches']:args.includes('--tags')?['--tags']:(specs.length?specs.map(s=>s.replace(/^\+/,'').split(':')[0]).filter(Boolean):['HEAD']);
   gitArgs=['log','--format=','--patch','--no-ext-diff','--no-textconv','--unified=0','--no-renames',...refs,'--not','--remotes'];
  }
  const diff=cp.execFileSync('git',[...globals,...gitArgs],{cwd,encoding:'utf8',maxBuffer:256*1024*1024,timeout:30000,stdio:['ignore','pipe','pipe']});
  for(const line of diff.split('\n')) {
   if(line.startsWith('diff --git ')) {
    const header=line.slice(11);
    const names=[...header.matchAll(/"(?:[^"\\]|\\.)*"|[ab]\/.*?(?= [ab]\/|$)/g)].map(m=>{try{return m[0].startsWith('"')?JSON.parse(m[0]):m[0];}catch{return m[0];}});
    if(names.some(n=>sensitivePath(n.slice(2),c,cwd))) return true;
   }
   if(line.startsWith('+++ b/') && sensitivePath(line.slice(6),c,cwd)) return true;
   if(line.startsWith('+') && !line.startsWith('+++') && gitPayload(line.slice(1))) return true;
  }
 } catch { return true; }
 return false;
}
function braceVariants(s) {
 let variants=[s];
 for(let depth=0;depth<6;depth++) {
  let changed=false; const next=[];
  for(const value of variants) {
   const m=value.match(/\{([^{}]*,[^{}]*)\}/);
   if(!m) next.push(value);
   else { changed=true; for(const v of m[1].split(',').slice(0,16)) next.push(value.slice(0,m.index)+v+value.slice(m.index+m[0].length)); }
   if(next.length>=64) break;
  }
  variants=next.slice(0,64); if(!changed) break;
 }
 return variants;
}
function shellGuard(command,cwd,c,depth=0) {
 if(depth>12) return false;
 const vars={}; let pendingAdd=false;
 for(const clause of shellClauses(command)) {
  let tokens=clause.map(t=>expand(t,vars));
  for(const t of tokens) {const m=t.match(/^([A-Za-z_]\w*)=(.*)$/s); if(m) vars[m[1]]=expand(m[2],vars);}
  tokens=tokens.map(t=>expand(t,vars));
  while(tokens[0] && /^[A-Za-z_]\w*=/.test(tokens[0])) tokens.shift();
  const cmd=path.basename(tokens[0] || '');
  const recursive=['cp','mv','rsync','tar','zip','scp','find','grep','rg','cd','pushd'].includes(cmd);
  if(sensitivePath(cwd,c,cwd)) return true;
  for(const token of tokens.slice(1)) {
   // Upload forms include field=@path, --data=@path, and @~/path.
   const operands=[token,...token.split(/[=@]/).slice(1)].flatMap(v=>braceVariants(v));
   for(const operand of operands) {
    if(!operand || operand.startsWith('-')) continue;
    if(sensitivePath(operand,c,cwd,{recursive,extensions:['cp','mv','scp','rsync','install'].includes(cmd),shell:true})) return true;
   }
   // Unknown expansion alone is ordinary shell syntax; sensitive fragments are not.
   if(/[$`{}]/.test(token) && (/(?:npki|gpki|signpri|kmpri|signcert)/i.test(token) || token.split('/').some(part=>/[a-z]/i.test(part) && [...c.directoryNames,...c.fileNames].some(n=>globRegex(part).test(n))))) return true;
  }
  if(cmd==='apply_patch' && patchPaths(tokens.slice(1).join('\n')).some(p=>sensitivePath(p,c,cwd,{extensions:true}))) return true;
  if(patchPaths((clause.heredocs || []).join('\n')).some(p=>sensitivePath(p,c,cwd,{extensions:true}))) return true;
  if((clause.subs || []).some(s=>shellGuard(s,cwd,c,depth+1))) return true;
  if(['bash','sh','zsh'].includes(cmd) && tokens.includes('-c') && shellGuard(tokens[tokens.indexOf('-c')+1] || '',cwd,c,depth+1)) return true;
  tokens.pendingAdd=pendingAdd;
  if(gitContentGuard(tokens,cwd,c)) return true;
  if(cmd==='git' && tokens[1]==='add') pendingAdd=true;
  if(cmd==='cd' || cmd==='pushd') cwd=path.resolve(cwd,tokens[1] || process.env.HOME || cwd);
 }
 return false;
}
async function evaluate(data, config = {}) {
 const c=configWithDefaults(config), name=normalizedToolName(data.tool_name), input=data.tool_input || {}, cwd=data.cwd || process.cwd();
 if(name==='shell') {
  const command=input.command || input.cmd || '';
  if(c.signingScript && command===c.signingScript) return null;
  if(shellGuard(command,cwd,c)) return {reason:REASON};
 } else if(['read','file-mutation','multiedit','grep','glob'].includes(name)) {
  const paths=Object.entries(input).filter(([key])=>/path|file|glob|include/i.test(key)).flatMap(([,v])=>strings(v));
  if(name==='glob' && input.pattern) {
   const root=path.resolve(cwd,expand(input.path || '.'));
   const fixed=expand(input.pattern).split(/[?*[]/)[0];
   const scanRoot=path.resolve(root,fixed.endsWith('/')?fixed:fixed.slice(0,fixed.lastIndexOf('/')+1));
   if(/[?*[]/.test(input.pattern) && sensitivePath(scanRoot,c,cwd,{recursive:true})) return {reason:REASON};
   paths.push(path.resolve(root,expand(input.pattern)));
  }
  paths.push(...patchPaths(strings(input).join('\n')));
  if(name==='grep') paths.push(input.path || cwd);
  if(paths.some(v=>sensitivePath(v,c,cwd,{recursive:name==='grep',extensions:!['grep','glob'].includes(name)}))) return {reason:REASON};
 } else if(/send|mail|discord|message|commit|push/i.test(data.tool_name || '')) {
  if(strings(input).some(v=>containsSensitiveContent(v))) return {reason:REASON};
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
