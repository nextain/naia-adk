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
function strings(v) { if(typeof v==='string') return [v]; if(v && typeof v==='object') return Object.values(v).flatMap(strings); return []; }
const {shellClauses}=require('./lib/git-command-parser');
const {normalizedToolName}=require('./tool-names');
function patchPaths(s) {
 return [...String(s).matchAll(/^(?:\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: |\+\+\+ b\/|--- a\/)(.+)$/gm)].map(m=>m[1].trim());
}
// Inspection children receive only fixed policy and validated repository locations.
const SAFE_GIT = ['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','diff.external=','--no-pager'];
function gitEnvironment() {
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('GIT_')));
 return {...env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
}
function gitInvocation(tokens,cwd,c) {
 if(!/^(?:.*\/)?git$/.test(tokens[0] || '')) return null;
 let i=1;const locations=[];
 while(tokens[i]?.startsWith('-')) {
  const option=tokens[i++];
  const key=option.split('=')[0];
  if(!['-C','--git-dir','--work-tree'].includes(key)) return {blocked:true};
  const value=option.includes('=')?option.slice(option.indexOf('=')+1):tokens[i++];
  if(!value || sensitivePath(value,c,cwd)) return {blocked:true};
  const resolved=path.resolve(cwd,expand(value));
  if(key==='-C') cwd=resolved; else locations.push(key+'='+resolved);
 }
 return {cwd,locations,sub:tokens[i++],args:tokens.slice(i)};
}
function gitPayload(s) { return /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(s) || /\bMII[A-Za-z0-9+/=]{60,}/.test(s); }
function gitContentGuard(tokens,cwd,c) {
 const invocation=gitInvocation(tokens,cwd,c);if(!invocation)return false;if(invocation.blocked)return true;
 const {locations,sub,args}=invocation;cwd=invocation.cwd;
 if(!['commit','push'].includes(sub))return false;
 const git=(argv)=>cp.execFileSync('git',[...SAFE_GIT,...locations,...argv],{cwd,env:gitEnvironment(),encoding:'utf8',maxBuffer:256*1024*1024,timeout:30000,stdio:['ignore','pipe','pipe']});
 try {
  for(let j=0;j<args.length;j++) {
   if(sub!=='commit')break;
   const arg=args[j];
   if(['-F','--file'].includes(arg)||arg.startsWith('--file=')) {
    const value=arg.startsWith('--file=')?arg.slice(7):args[++j];
    if(value==='-') {if(gitPayload((tokens.heredocs||[]).join('\n')))return true;continue;}
    const file=path.resolve(cwd,expand(value||''));
    if(sensitivePath(file,c,cwd,{extensions:true})||gitPayload(fs.readFileSync(file,'utf8')))return true;
   }
   let message;
   if(['-m','--message','-am'].includes(arg))message=args[++j];
   else if(arg.startsWith('--message='))message=arg.slice(10);
   else if(/^-m.+/.test(arg))message=arg.slice(2);
   if(message && gitPayload(message))return true;
  }
  let gitArgs;
  if(sub==='commit') {
   const values=new Set(['-m','-am','--message','-F','--file','-C','--reuse-message','-c','--reedit-message','--author','--date','--cleanup','--trailer']);
   let positional=false,all=false;
   for(let j=0;j<args.length;j++){const arg=args[j];if(/^-[^-]*a/.test(arg)||arg==='--all')all=true;if(values.has(arg)){j++;continue;}if(!arg.startsWith('-'))positional=true;}
   // Pending add files include untracked operands; never execute the proposed add.
   if(tokens.pendingAdd) {
    const names=git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
    for(const name of names) {
     if(!tokens.pendingAdd.some(v=>within(path.resolve(cwd,name),path.resolve(cwd,v)) || globRegex(v).test(name)))continue;
     if(/(?:^|\/)(?:\.env(?:\..*)?|auth\.json|\.ssh|\.azure|\.codex|[^/]*-keys)(?:\/|$)/i.test(name))return true;
     if(sensitivePath(name,c,cwd,{extensions:true}))return true;
     const file=path.resolve(cwd,name);
     try {if(fs.statSync(file).isFile() && gitPayload(fs.readFileSync(file,'utf8')))return true;}catch(e){if(e.code!=='ENOENT')throw e;}
    }
   }
   gitArgs=['diff',...(all||positional?['HEAD']:['--cached']),'--no-ext-diff','--no-textconv','--unified=0','--no-renames'];
  } else {
   const positional=[];
   for(let j=0;j<args.length;j++){if(['-o','--push-option','--repo','--receive-pack','--exec'].includes(args[j])){j++;continue;}if(!args[j].startsWith('-'))positional.push(args[j]);}
   const specs=positional.slice(1);
   const refs=args.includes('--all')?['--branches']:args.includes('--tags')?['--tags']:(specs.length?(specs[0]==='tag'?['refs/tags/'+specs[1]]:specs.map(v=>v.replace(/^\+/,'').split(':')[0]).filter(Boolean)):['HEAD']);
   if(!args.includes('--all') && !args.includes('--tags') && refs.some(ref=>ref.startsWith('-') || !ref))return true;
   gitArgs=['log','--format=','--patch','--no-ext-diff','--no-textconv','--unified=0','--no-renames',...refs,'--not','--remotes'];
  }
  let diff;
  try {diff=git(gitArgs);} catch(e) {
   if(sub==='commit' && gitArgs.includes('HEAD') && /(?:bad revision|ambiguous argument).*HEAD/.test(String(e.stderr))) diff=git(gitArgs.map(v=>v==='HEAD'?'--cached':v));
   else throw e;
  }
  for(const line of diff.split('\n')) {
   if(line.startsWith('diff --git ')) {
    const names=[...line.slice(11).matchAll(/"(?:[^"\\]|\\.)*"|[ab]\/.*?(?= [ab]\/|$)/g)].map(m=>{try{return m[0].startsWith('"')?JSON.parse(m[0]):m[0];}catch{return m[0];}});
    if(names.some(n=>sensitivePath(n.slice(2),c,cwd)))return true;
   }
   if(line.startsWith('+++ b/')&&sensitivePath(line.slice(6),c,cwd))return true;
   if(line.startsWith('+')&&!line.startsWith('+++')&&gitPayload(line.slice(1)))return true;
  }
 }catch{return true;}
 return false;
}
function sensitiveFragment(value,c) {
 const names=[...c.directoryNames,...c.fileNames,...c.additionalPaths.map(v=>path.basename(v))];
 return names.some(n=>String(value).toLowerCase().includes(n.toLowerCase())) || /(?:np[?*]|n[?*]ki|signpri|kmpri|signcert)/i.test(value);
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
 if(depth>12) return sensitiveFragment(command,c);
 const vars={}; const pendingAdds=new Map();
 const clauses=shellClauses(command);
 if(clauses.unbalanced || command.length>131072 || /\{[^{}]*,[^{}]*\}/.test(command) && braceVariants(command).length>=16) return sensitiveFragment(command,c);
 for(const clause of clauses) {
  let tokens=clause.map(t=>expand(t,vars));
  for(const t of tokens) {const m=t.match(/^([A-Za-z_]\w*)=(.*)$/s); if(m) vars[m[1]]=expand(m[2],vars);}
  tokens=tokens.map(t=>expand(t,vars));
  while(tokens[0] && /^[A-Za-z_]\w*=/.test(tokens[0])) tokens.shift();
  while(['env','command'].includes(tokens[0]))tokens.shift();
  const cmd=path.basename(tokens[0] || '');
  // Inline interpreter programs are outside this lexical boundary.
  if((['bash','sh','zsh','python','python3'].includes(cmd)&&tokens.some(v=>/^-[a-z]*c$/.test(v))) || (cmd==='node'&&tokens.includes('-e')))continue;
  const recursive=['tar','find','rg'].includes(cmd) || (['cp','rsync','zip','grep','scp'].includes(cmd)&&tokens.some(v=>/^-[^-]*[rRa]/.test(v)||v==='--recursive'));
  if(sensitivePath(cwd,c,cwd) || sensitivePath(tokens[0]||'',c,cwd)) return true;
  for(const [index,token] of tokens.slice(1).entries()) {
   // Upload forms include field=@path, --data=@path, and @~/path.
   const normalized=token.replace(/^-[Ti](?=\/|~)/,'').replace(/;type=.*$/,'');
   const operands=[normalized,...normalized.split(/[=@<]/).slice(1)].flatMap(v=>braceVariants(v));
   for(const operand of operands) {
    if(!operand || operand.startsWith('-')) continue;
    if(sensitivePath(operand,c,cwd,{recursive:recursive && (!['cp','rsync','scp'].includes(cmd)||index<tokens.length-2),extensions:['cp','mv','scp','rsync','install','cat','base64','xxd','curl'].includes(cmd),shell:true})) return true;
   }
   // Unknown expansion alone is ordinary shell syntax; sensitive fragments are not.
   if(/[$`{}]/.test(token) && (/(?:npki|gpki|signpri|kmpri|signcert)/i.test(token) || token.split('/').some(part=>/[a-z]/i.test(part) && [...c.directoryNames,...c.fileNames].some(n=>globRegex(part).test(n))))) return true;
  }
  if(cmd==='apply_patch' && patchPaths(tokens.slice(1).join('\n')).some(p=>sensitivePath(p,c,cwd,{extensions:true}))) return true;
  if(patchPaths((clause.heredocs || []).join('\n')).some(p=>sensitivePath(p,c,cwd,{extensions:true}))) return true;
  if((clause.subs || []).some(s=>shellGuard(s,cwd,c,depth+1))) return true;

  const invocation=gitInvocation(tokens,cwd,c);
  tokens.pendingAdd=invocation && pendingAdds.get(invocation.cwd);tokens.heredocs=clause.heredocs;
  if(gitContentGuard(tokens,cwd,c)) return true;
  if(invocation?.sub==='add') {
   const selected=invocation.args.filter(v=>!v.startsWith('-'));
   pendingAdds.set(invocation.cwd,[...(pendingAdds.get(invocation.cwd)||[]),...(selected.length?selected:['.'])]);
  }
  if(cmd==='cd' || cmd==='pushd') cwd=path.resolve(cwd,tokens[1] || process.env.HOME || cwd);
 }
 return false;
}
async function evaluate(data, config = {}) {
 const c=configWithDefaults(config), name=normalizedToolName(data.tool_name), input=data.tool_input || {}, cwd=data.cwd || process.cwd();
 c.additionalPaths=c.additionalPaths.map(v=>path.resolve(cwd,expand(v)));
 if(name==='shell') {
  const command=input.command || input.cmd || '';
  if(c.signingScript && command===c.signingScript) return null;
  if(c.signingScript && command.includes(c.signingScript))return {reason:REASON};
  if(shellGuard(command,cwd,c)) return {reason:REASON};
 } else if((['read','file-mutation','multiedit','grep','glob','ls'].includes(name)||/^(?:read_file|write_file|edit_file|list_directory|directory_tree|search_files)$/.test(String(data.tool_name).split('__').pop()))) {
  const paths=Object.entries(input).filter(([key])=>/path|file|glob|include/i.test(key)).flatMap(([,v])=>strings(v));
  if(name==='glob' && input.pattern) {
   if(braceVariants(input.pattern).length>=16 && sensitiveFragment(input.pattern,c))return {reason:REASON};
   const root=path.resolve(cwd,expand(input.path || '.'));
   for(const variant of braceVariants(input.pattern)) {
   const fixed=expand(variant).split(/[?*[]/)[0];
   const scanRoot=path.resolve(root,fixed.endsWith('/')?fixed:fixed.slice(0,fixed.lastIndexOf('/')+1));
   if(variant.includes('**') && !within(scanRoot,cwd) && sensitivePath(scanRoot,c,cwd,{recursive:true})) return {reason:REASON};
   paths.push(path.resolve(root,expand(variant)));
   }
  }
  paths.push(...patchPaths(strings(input).join('\n')));
  if(name==='grep') paths.push(input.path || cwd);
  if(paths.some(v=>sensitivePath(v,c,cwd,{recursive:name==='grep' && ((Boolean(input.path) && path.resolve(cwd,expand(v))!==cwd) || path.resolve(cwd,expand(v))===process.env.HOME),extensions:!['grep','glob'].includes(name)}))) return {reason:REASON};
 } else if(/send|mail|discord|message|commit|push/i.test(data.tool_name || '')) {
  if(Object.entries(input).filter(([k])=>/attachment|files?|paths?/i.test(k)).flatMap(([,v])=>strings(v)).some(v=>sensitivePath(v,c,cwd,{extensions:true}))) return {reason:REASON};
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
