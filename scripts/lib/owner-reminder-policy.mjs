import fs from 'node:fs';
import path from 'node:path';
// Every observer uses the same gateway ledger when configured. Unreadable state
// fails closed; it never silently enables an independent reminder publisher.
export function isGatewayOwned(config, messageId) {
  if (typeof config.ownerRoutingStateFile !== 'string' || !config.ownerRoutingStateFile || !path.isAbsolute(config.ownerRoutingStateFile)) throw Error('invalid ownerRoutingStateFile');
  const ledger = JSON.parse(fs.readFileSync(config.ownerRoutingStateFile, 'utf8'));
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw Error('invalid owner routing ledger');
  return Object.hasOwn(ledger, messageId);
}
