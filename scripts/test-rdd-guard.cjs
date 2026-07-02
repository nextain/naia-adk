const fs=require("fs"),path=require("path"),os=require("os"),cp=require("crypto");
const P=require(process.argv[2]); // policy path
let pass=0,fail=0;
function mk(){const d=fs.mkdtempSync(path.join(os.tmpdir(),"rdd-"));return d;}
function sha(s){return cp.createHash("sha256").update(s).digest("hex").slice(0,16);}
function setup(d,{ledger,stampFresh,stampMatch}={}){
  const rd=path.join(d,".agents","research","prog");fs.mkdirSync(rd,{recursive:true});
  if(ledger)fs.writeFileSync(path.join(rd,"hypothesis-ledger.json"),JSON.stringify(ledger));
  if(stampFresh!==undefined){
    const raw=ledger?JSON.stringify(ledger):"";
    fs.writeFileSync(path.join(rd,".align-audit-stamp.json"),JSON.stringify({
      ts: stampFresh?Date.now():Date.now()-99*3600e3,
      ledger_hash: stampMatch?sha(raw):"WRONGHASH"}));
  }
}
const validEntry={id:"H1",hypothesis:"h",charter_subgoal:"SG1",method_contract:"m",gate:"g",
  decision_map:{pass:"x",fail:"y"},tags:["t"],status:"open"};
function check(name,expectBlock,cmd,d){
  const r=P.experiment(cmd,{cwd:d});
  const blocked=!!(r&&r.reason);
  const ok=blocked===expectBlock;
  console.log(`${ok?"PASS":"FAIL"}  ${name}  (blocked=${blocked}, expected=${expectBlock})`);
  ok?pass++:fail++;
}
// A: exp run, research dir, no valid entry -> BLOCK
let d=mk();setup(d,{ledger:{entries:[]}});
check("A no-entry -> block",true,"python packages/x/exp1_foo.py",d);
// B: valid entry, no stamp -> BLOCK
d=mk();setup(d,{ledger:{entries:[validEntry]}});
check("B entry no-stamp -> block",true,"python exp2_bar.py",d);
// B2: valid entry, stale stamp -> BLOCK
d=mk();setup(d,{ledger:{entries:[validEntry]},stampFresh:false,stampMatch:true});
check("B2 stale stamp -> block",true,"python exp2_bar.py",d);
// B3: valid entry, fresh but hash-mismatch (gate lowered) -> BLOCK
d=mk();setup(d,{ledger:{entries:[validEntry]},stampFresh:true,stampMatch:false});
check("B3 hash-mismatch -> block",true,"python exp2_bar.py",d);
// C: valid entry + fresh matching stamp -> ALLOW
d=mk();setup(d,{ledger:{entries:[validEntry]},stampFresh:true,stampMatch:true});
check("C valid+stamp -> allow",false,"python exp3_baz.py",d);
// D: non-experiment command -> ALLOW(null)
d=mk();setup(d,{ledger:{entries:[]}});
check("D non-exp echo -> allow",false,"echo python exp1.py",d);
check("D2 normal python -> allow",false,"python train.py",d);
// E: exp run but NO research dir -> ALLOW (non-RDD project)
d=mk();
check("E no-research-dir -> allow",false,"python exp1_foo.py",d);
// F: incomplete entry (missing gate) -> BLOCK
d=mk();setup(d,{ledger:{entries:[{...validEntry,gate:""}]},stampFresh:true,stampMatch:true});
check("F incomplete entry -> block",true,"python exp1.py",d);
console.log(`\n${pass} passed, ${fail} failed  EXIT=${fail?1:0}`);
process.exit(fail?1:0);
