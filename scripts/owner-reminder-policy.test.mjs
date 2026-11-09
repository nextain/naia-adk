import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isGatewayOwned } from './lib/owner-reminder-policy.mjs';
test('configured observers suppress gateway-owned reminders and fail closed on lost ledger',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owner-policy-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'owners.json'),c={ownerRoutingStateFile:file};
 assert.throws(()=>isGatewayOwned(c,'100'));fs.writeFileSync(file,JSON.stringify({'100':{ownerRole:'builder'}}));
 assert.equal(isGatewayOwned(c,'100'),true);assert.equal(isGatewayOwned(c,'101'),false);assert.throws(()=>isGatewayOwned({},'100'),/ownerRoutingStateFile/);
 fs.writeFileSync(file,'null');assert.throws(()=>isGatewayOwned(c,'100'));
});

test('legacy missing ownership linkage cannot publish independent reminders', async () => {
 const {validateConfig:agent}=await import('./agent-request-watch.mjs');
 const {validateConfig:human}=await import('./response-watch.mjs');
 assert.throws(()=>isGatewayOwned({},'100'),/ownerRoutingStateFile/);
 assert.throws(()=>agent({}),/ownerRoutingStateFile/);
 assert.throws(()=>human({}),/ownerRoutingStateFile/);
});
