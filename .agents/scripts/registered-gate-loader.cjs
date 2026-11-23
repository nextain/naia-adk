"use strict";
// Sealed application imports for one canonical guard process. Other projects
// retain their explicit legacy policy context; this is not a host-wide loader.
const Module=require("node:module"),path=require("node:path");
const {pathToFileURL,fileURLToPath}=require("node:url");
const inside=(root,file)=>{const relative=path.relative(root,file);return!relative||relative!==".."&&!relative.startsWith(".."+path.sep)&&!path.isAbsolute(relative);};
function installRegisteredModuleHooks({files,registrationSha,entry,roots,currentContext,register=Module.registerHooks}){
 if(typeof register!=="function")throw new Error("Registered application imports require Node module.registerHooks (Node22.15 or later)");
 const fileOf=url=>{try{return url.startsWith("file:")?fileURLToPath(url):null;}catch{return null;}};
 const legacy=()=>{const root=currentContext()?.legacyPolicyRoot;return typeof root==="string"&&roots.every(registered=>!inside(registered,root));};
 const guarded=(file,parent)=>{
  if(file&&roots.some(root=>inside(root,file)))return true;
  const source=fileOf(parent||"");
  if(source&&files.has(source)&&(source.endsWith(".mjs")||inside(roots[1],source)))return true;
  return!legacy()&&(currentContext()?.executionRegistrationSha256===registrationSha||files.has(source));
 };
 const knownURL=file=>{const url=pathToFileURL(file);if(file.endsWith(".mjs"))url.searchParams.set("adk_registered",registrationSha);return url.href;};
 function resolve(specifier,context,next){
  if(Module.isBuiltin(specifier))return next(specifier,context);
  let candidate;try{candidate=fileOf(new URL(specifier,context.parentURL).href);}catch{}
  if(candidate&&files.has(candidate)){
   if(candidate===entry)throw new Error("Registered bootstrap cannot be imported again by application code");
   return{url:knownURL(candidate),shortCircuit:true};
  }
  const result=next(specifier,context),file=fileOf(result.url);
  if(files.has(file)){
   if(file===entry)throw new Error("Registered bootstrap cannot be imported again by application code");
   return{...result,url:knownURL(file)};
  }
  if(!Module.isBuiltin(result.url)&&guarded(file,context.parentURL))throw new Error("Unregistered executable import: "+specifier);
  return result;
 }
 function load(url,context,next){
  if(Module.isBuiltin(url))return next(url,context);
  const file=fileOf(url),bytes=files.get(file);
  if(bytes){
   if(file===entry)throw new Error("Registered bootstrap cannot be imported again by application code");
   return{format:file.endsWith(".mjs")?"module":file.endsWith(".json")?"json":"commonjs",source:bytes.toString("utf8"),shortCircuit:true};
  }
  if(guarded(file,context.parentURL))throw new Error("Unregistered executable load: "+url);
  return next(url,context);
 }
 return register({resolve,load});
}
module.exports={installRegisteredModuleHooks};
