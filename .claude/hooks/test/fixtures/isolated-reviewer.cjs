#!/usr/bin/env node
"use strict";

const fs = require("fs");
const net = require("net");
const canRead = (file) => {
  try { fs.accessSync(file, fs.constants.R_OK); return true; } catch { return false; }
};
const canWrite = (file) => {
  try { fs.writeFileSync(file, "probe", { flag: "wx" }); fs.unlinkSync(file); return true; } catch { return false; }
};
const finish = (networkBlocked) => process.stdout.write(JSON.stringify({
  secret_absent: !process.env.LEAK_SECRET,
  home_blind: !canRead(process.env.REQUEST_CONTRACT_HOME_PROBE),
  repository_blind: !canRead(process.env.REQUEST_CONTRACT_REPOSITORY_PROBE),
  home_read_only: !canWrite(process.env.REQUEST_CONTRACT_HOME_WRITE_PROBE),
  review_read_only: !canWrite(process.env.REQUEST_CONTRACT_REVIEW_WRITE_PROBE),
  network_blocked: networkBlocked,
  scratch_writable: canWrite(process.env.REQUEST_CONTRACT_SCRATCH_PROBE),
  bundle_readable: canRead(process.env.REQUEST_CONTRACT_BUNDLE),
  cwd: process.cwd(),
}));
const port = Number(process.env.REQUEST_CONTRACT_NETWORK_PROBE || 0);
if (!port) finish(true);
else {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  let done = false;
  const settle = (blocked) => { if (done) return; done = true; socket.destroy(); finish(blocked); };
  socket.once("connect", () => settle(false));
  socket.once("error", () => settle(true));
  socket.setTimeout(1000, () => settle(true));
}
