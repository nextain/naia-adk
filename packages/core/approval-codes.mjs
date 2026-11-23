// Messenger cards also display six-character codes for older deployments.
// The deployment gate verifies the complete scoped code before authorizing work.
export function approvalCodePair(body) {
  const codes = body.match(/(?<![A-Za-z0-9_-])(PLAN-(?:[0-9A-F]{64}|[A-Z0-9]{6}))\s+(STEP-(?:[0-9A-F]{64}|[A-Z0-9]{6}))(?![A-Za-z0-9_-])/);
  return codes && [codes[1], codes[2]];
}
