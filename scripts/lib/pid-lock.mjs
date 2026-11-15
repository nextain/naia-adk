import pidLock from './pid-lock.cjs';

export const {
  MAX_LINUX_PID,
  DEFAULT_ORPHAN_GRACE_MS,
  DEFAULT_UNVERIFIED_MAX_AGE_MS,
  readBootIdSync,
  readProcStatSync,
  parseLockRecord,
  inspectLockOwner,
  acquirePidLockSync,
  withPidLockSync,
  acquirePidLock,
  withPidLock,
} = pidLock;

export default pidLock;
