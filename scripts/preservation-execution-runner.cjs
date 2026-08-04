#!/usr/bin/env node
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");

const SOCKET_PATH = "/run/naia-preservation/attestor.sock";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;

function fail(code, message = code) { throw Object.assign(new Error(message), { code }); }

function readRequest(argv) {
	if (argv.length !== 2 || !new Set(["--request", "--seal"]).has(argv[0])) fail("preservation_request_usage", "usage: preservation-execution-runner.cjs (--request|--seal) <json>");
	const file = path.resolve(argv[1]);
	const stat = fs.lstatSync(file);
	if (!stat.isFile() || stat.isSymbolicLink()) fail("preservation_request_invalid");
	const input = JSON.parse(fs.readFileSync(file, "utf8"));
	const seal = argv[0] === "--seal";
	const keys = seal ? ["repository", "unit_id"] : ["phase", "repository", "stage", "surface_id", "unit_id"];
	if (!input || typeof input !== "object" || Array.isArray(input) || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(keys.sort()) || !ID.test(input.unit_id || "") || (!seal && !ID.test(input.surface_id || "")) || !path.isAbsolute(input.repository || "")) fail("preservation_request_invalid");
	const repository = fs.realpathSync(input.repository);
	if (!fs.lstatSync(repository).isDirectory()) fail("preservation_request_invalid");
	return { operation: seal ? "seal" : "probe", ...input, repository };
}

function requestAttestation(request, socketPath = SOCKET_PATH) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let response = "";
		socket.setEncoding("utf8");
		socket.setTimeout(180_000, () => socket.destroy(Object.assign(new Error("attestor timeout"), { code: "preservation_attestor_timeout" })));
		socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
		socket.on("data", (chunk) => { response += chunk; if (Buffer.byteLength(response) > 2 * 1024 * 1024) socket.destroy(Object.assign(new Error("attestor response too large"), { code: "preservation_attestor_response_invalid" })); });
		socket.on("error", reject);
		socket.on("close", () => {
			try {
				const parsed = JSON.parse(response);
				const evidence = request.operation === "seal" ? parsed && parsed.decision : parsed && parsed.receipt;
				if (!parsed || parsed.ok !== true || !evidence) fail(parsed && parsed.code || "preservation_attestor_unavailable");
				resolve(evidence);
			} catch (error) { reject(error); }
		});
	});
}

function appendReceipt(request, receipt) {
	const unitRoot = path.join(request.repository, ".agents", "harness", "units", request.unit_id);
	const root = path.join(unitRoot, "preservation");
	const resolvedUnit = path.resolve(unitRoot);
	if (path.resolve(root) !== resolvedUnit && !path.resolve(root).startsWith(`${resolvedUnit}${path.sep}`)) fail("preservation_receipt_path_invalid");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const file = path.join(root, "receipts.jsonl");
	const fd = fs.openSync(file, "a", 0o600);
	try { fs.writeSync(fd, `${JSON.stringify(receipt)}\n`); fs.fsyncSync(fd); }
	finally { fs.closeSync(fd); }
	const directory = fs.openSync(root, "r");
	try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function writeDecision(request, decision) {
	const root = path.join(request.repository, ".agents", "harness", "units", request.unit_id, "preservation");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	const file = path.join(root, "decision.json");
	const temp = path.join(root, `.decision-${process.pid}-${Date.now()}.tmp`);
	let fd;
	try {
		fd = fs.openSync(temp, "wx", 0o600);
		fs.writeFileSync(fd, `${JSON.stringify(decision)}\n`);
		fs.fsyncSync(fd);
		fs.closeSync(fd); fd = null;
		fs.renameSync(temp, file);
		const directory = fs.openSync(root, "r");
		try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
	} finally {
		if (fd != null) try { fs.closeSync(fd); } catch {}
		try { fs.unlinkSync(temp); } catch {}
	}
}

async function main() {
	const request = readRequest(process.argv.slice(2));
	const evidence = await requestAttestation(request);
	if (request.operation === "seal") writeDecision(request, evidence);
	else appendReceipt(request, evidence);
	process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.code || "preservation_attestor_unavailable"}: ${error.message}\n`); process.exit(2); });
module.exports = { appendReceipt, readRequest, requestAttestation, writeDecision };
