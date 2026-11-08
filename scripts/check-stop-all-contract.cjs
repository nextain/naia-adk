"use strict";
// Explicit fixture paths keep the public test independent of ignored instance configuration.
const fs=require('node:fs'),assert=require('node:assert/strict');
const [contractFile,configFile]=process.argv.slice(2);
if(!contractFile||!configFile)throw Error('usage: check-stop-all-contract.cjs <contract.json> <instance-config.json>');
const contract=JSON.parse(fs.readFileSync(contractFile,'utf8'));
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
assert.equal(config.stopAllLockFile,contract.lockFile,'instance lock must match canonical runtime contract');
console.log('PASS canonical runtime lock contract');
