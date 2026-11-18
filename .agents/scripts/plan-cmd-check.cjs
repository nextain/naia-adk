#!/usr/bin/env node
'use strict';
// Offline preflight only: the execution gate still requires review and approval.
const fs = require('node:fs');
const path = require('node:path');
const { formProblems } = require('../../.claude/hooks/lib/deploy-plan.js');
const { classifyProdMutations } = require('../../.claude/hooks/lib/deploy-command-classifier.js');
const { verifiedPlanBinding } = require('../../.claude/hooks/lib/deploy-readiness.js');
const [planPath, stepId, command, kind, candidate = ''] = process.argv.slice(2);
if (!planPath || !stepId || !command || !['feature','ops','rollback'].includes(kind)) {
  console.error('Usage: plan-cmd-check.cjs PLAN STEP COMMAND feature|ops|rollback [CANDIDATE]'); process.exit(2);
}
try {
  const root = process.cwd();
  const plan = JSON.parse(fs.readFileSync(path.resolve(planPath), 'utf8'));
  const problems = formProblems(plan);
  const entries = [...(plan.scenario || []), ...(plan.incident?.actions || [])].filter(e => e.id === stepId);
  if (problems.length || entries.length !== 1) throw new Error('Invalid plan or step');
  const services = [...new Set(classifyProdMutations(command, root).map(hit => hit.service))];
  const result = verifiedPlanBinding({plan, entry:entries[0], command, cwd:root}, candidate, kind, services, root);
  if (!result.ok) throw new Error(result.why);
  console.log('Plan command binding OK');
} catch (err) { console.error(`Plan command binding rejected: ${err.message}`); process.exit(1); }
