#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = join(root, ".agents", "context", "agent-registry.json");
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*-agent$/;

function fail(message) {
  process.stderr.write(`agent-registry: ${message}\n`);
  process.exitCode = 1;
}

function safeWorkspacePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
    return undefined;
  }
  const absolute = resolve(root, value);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || rel === "") {
    fail(`${label} must resolve below the workspace root`);
    return undefined;
  }
  return absolute;
}

let registry;
try {
  registry = JSON.parse(await readFile(registryPath, "utf8"));
} catch (error) {
  fail(`cannot read ${registryPath}: ${error.message}`);
  process.exit();
}

if (registry.schema_version !== "1.0") fail("schema_version must be 1.0");
if (!Array.isArray(registry.agents)) fail("agents must be an array");

const seen = new Set();
for (const item of registry.agents ?? []) {
  if (!idPattern.test(item.id ?? "")) {
    fail(`invalid agent id: ${String(item.id)}`);
    continue;
  }
  if (seen.has(item.id)) fail(`duplicate agent id: ${item.id}`);
  seen.add(item.id);

  const expectedPath = `agents/${item.id}`;
  if (item.path !== expectedPath) fail(`${item.id} path must be ${expectedPath}`);
  const agentDir = safeWorkspacePath(item.path, `${item.id}.path`);
  if (!agentDir) continue;

  try {
    await access(join(agentDir, "AGENTS.md"));
    await access(join(agentDir, "agent.json"));
    const config = JSON.parse(await readFile(join(agentDir, "agent.json"), "utf8"));
    if (config.id !== item.id) fail(`${item.id} does not match agent.json id`);
    if (!Array.isArray(config.information_scope?.allowed_roots)) {
      fail(`${item.id} must declare information_scope.allowed_roots`);
    }
    if (!Array.isArray(config.information_scope?.denied_roots)) {
      fail(`${item.id} must declare information_scope.denied_roots`);
    }
    for (const [index, path] of (config.information_scope?.allowed_roots ?? []).entries()) {
      safeWorkspacePath(path, `${item.id}.allowed_roots[${index}]`);
    }
    for (const [index, path] of (config.information_scope?.denied_roots ?? []).entries()) {
      safeWorkspacePath(path, `${item.id}.denied_roots[${index}]`);
    }
  } catch (error) {
    fail(`${item.id} is incomplete: ${error.message}`);
  }
}

if (!process.exitCode) {
  process.stdout.write(`agent-registry: ${seen.size} agent(s) verified\n`);
}
