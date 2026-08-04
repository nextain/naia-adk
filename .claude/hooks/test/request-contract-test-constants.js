"use strict";

const EXPECTED_SANDBOX_ENGINE = process.platform === "win32" ? "codex-windows-elevated" : "bubblewrap";
const CLIENT_VERSIONS = { claude: "2.1.207", codex: "0.144.1" };

module.exports = { CLIENT_VERSIONS, EXPECTED_SANDBOX_ENGINE };
