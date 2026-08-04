#!/usr/bin/env node
/** Deterministic fault-injection suite for request-contract integrity. */

"use strict";

require("./request-contract-governance-suite.js");
require("./request-contract-source-trace-suite.js");
require("./request-contract-authority-scope-suite.js");
require("./request-contract-review-completion-suite.js");
require("./request-contract-workspace-resume-suite.js");
require("./request-contract-native-compaction-suite.js");
require("./request-contract-recovery-validation-suite.js");
require("./request-contract-registry-locking-suite.js");
require("./request-contract-preservation-suite.js");
