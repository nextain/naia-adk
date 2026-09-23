const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const gate = require("./session-contract-gate.cjs");
const contractCore = require("../../.agents/hooks/core/session-contract.js");

const repositoryRoot = contractCore.findProjectRoot(__dirname);

function writeJson(filePath, value) {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function runRoutinePolicyTests() {
	{
	  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-routine-"));
	  try {
	    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	    writeJson(path.join(root, ".agents", "context", "agents-rules.json"), {
	      ai_workflow: {
	        routine_action_authorization: {
	          unbound_routine_commands: {
	            default: "allow",
	            contract_required_heads: {
	              destructive_filesystem: ["rm"],
	            },
	            contract_required_subcommands: {
	              git: ["reset"],
	            },
	            contract_required_patterns: {
	              patterns: ["(?:^|\\s)git\\s[^\\n]*--force\\b"],
	            },
	          },
	        },
	      },
	    });
	    writeJson(path.join(root, ".codex", "hooks.json"), {});
	    for (const marker of [".codex/no-harness", ".claude/no-harness", ".pi/no-harness"]) {
	      assert.equal(fs.existsSync(path.join(root, marker)), false, `marker-free fixture: ${marker}`);
	    }

	    const run = (toolName, toolInput) => gate.decide(
	      { cwd: root, session_id: "ROUTINE-1", tool_name: toolName, tool_input: toolInput },
	      { ...process.env, ADK_PROJECT_ROOT: "", AI_HARNESS: "", CLAUDE_HARNESS: "", CODEX_HARNESS: "" },
	      { resolveHookProjectRoot: () => root, processCwd: root },
	    );
	    const assertAllowed = (command) => {
	      assert.equal(gate.routineCommandAllowed("Bash", { command }, root), true, command);
	      assert.equal(run("Bash", { command }), null, `routine command should be allowed: ${command}`);
	    };
	    const assertBlocked = (command) => {
	      assert.equal(gate.routineCommandAllowed("Bash", { command }, root), false, command);
	      const decision = run("Bash", { command });
	      assert.equal(decision?.decision, "block", `governance command should be blocked: ${command}`);
	    };

	    assert.equal(gate.normalizedToolName("run_terminal_command"), "shell");
	    assert.equal(gate.normalizedToolName("search_replace"), "file-mutation");
	    assertAllowed("npm test");
	    assertAllowed("mkdir -p tmp/ordinary");
	    assertAllowed("git add ordinary.txt && git commit -m fixture");
	    assert.equal(run("search_replace", {
	      file_path: path.join(root, "ordinary.txt"),
	      old_string: "before",
	      new_string: "after",
	    }), null, "ordinary search_replace should be allowed");

	    assertBlocked("touch .agents/context/blocked.txt");
	    assertBlocked("rm -rf tmp/ordinary");
	    // An inline program is judged like any other command: an ordinary one
	    // stays routine, a contract-required one is refused wherever it hides.
	    assertAllowed("bash -c \\\"touch ordinary.txt\\\"");
	    assertAllowed("FOO=1 timeout 60 npm test");
	    assertAllowed("claude -p hi");
	    assertBlocked("bash -c \\\"rm -rf tmp/ordinary\\\"");
	    assertBlocked("FOO=1 rm -rf tmp/ordinary");
	    assertBlocked("echo $(rm -rf tmp/ordinary)");
	    assertBlocked("git reset --hard");
	    assertBlocked("git push --force");
	    assert.equal(run("search_replace", {
	      file_path: path.join(root, ".agents", "context", "blocked.txt"),
	      old_string: "before",
	      new_string: "after",
	    })?.decision, "block", "governance search_replace should be blocked");
	    for (const command of [
	      "echo 'hi'>.agents/context/file",
	      "echo hi > localfile > .agents/context/file",
				"echo hi >|.agents/context/file",
	    ]) {
	      assertBlocked(command);
	    }
	    assertAllowed("printf safe > localfile");
	    assertAllowed('rg "foo > bar" src');
	  } finally {
	    fs.rmSync(root, { recursive: true, force: true });
	  }
	  console.log("routine gate: PASS");
	}

	{
	  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gate-routine-nested-"));
	  const child = path.join(parent, "child");
	  try {
	    fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
	    fs.mkdirSync(path.join(child, ".git"), { recursive: true });
	    const routineRules = (overrides = {}) => ({
	      ai_workflow: {
	        routine_action_authorization: {
	          unbound_routine_commands: {
	            default: "allow",
	            ...overrides,
	          },
	        },
	      },
	    });
	    writeJson(path.join(parent, ".agents", "context", "agents-rules.json"), routineRules({
	      contract_required_heads: {
	        destructive_filesystem: ["rm"],
	      },
	      contract_required_subcommands: {
	        git: ["reset"],
	        npm: ["publish"],
	      },
	      contract_required_patterns: {
	        patterns: ["(?:^|\\s)git\\s[^\\n]*--force\\b"],
	      },
	      git_refused_subcommands: ["push"],
	    }));
	    writeJson(path.join(child, ".agents", "context", "agents-rules.json"), routineRules({
	      contract_required_heads: {
	        privileged: ["sudo"],
	      },
	      contract_required_subcommands: {
	        git: ["clean"],
	      },
	      contract_required_patterns: {
	        patterns: ["(?:^|\\s)curl\\s"],
	      },
	    }));
	    writeJson(path.join(parent, ".codex", "hooks.json"), {});
	    writeJson(path.join(child, ".codex", "hooks.json"), {});

		const allowance = gate.routineAllowance(child);
	    assert.equal(allowance.default, "allow", "an allow child retains the enclosing allow default");
	    assert.deepEqual(allowance.contract_required_heads.destructive_filesystem, ["rm"]);
	    assert.deepEqual(allowance.contract_required_heads.privileged, ["sudo"]);
	    assert.deepEqual(allowance.contract_required_subcommands.git, ["clean", "reset"]);
	    assert.deepEqual(allowance.contract_required_subcommands.npm, ["publish"]);
	    assert.deepEqual(allowance.git_refused_subcommands, ["push"]);
	    assert.equal(allowance.contract_required_patterns.patterns.length, 2);
	    assert.ok(allowance.contract_required_patterns.patterns.some((pattern) => /curl/.test(pattern)));
	    assert.ok(allowance.contract_required_patterns.patterns.some((pattern) => /--force/.test(pattern)));

	    const runChild = (command) => gate.decide(
	      { cwd: child, session_id: "NESTED-ROUTINE-1", tool_name: "Bash", tool_input: { command } },
	      { ...process.env, ADK_PROJECT_ROOT: "", AI_HARNESS: "", CLAUDE_HARNESS: "", CODEX_HARNESS: "" },
	      { resolveHookProjectRoot: () => child, processCwd: child },
	    );
	    assert.equal(gate.routineCommandAllowed("Bash", { command: "npm test" }, child), true);
	    assert.equal(runChild("npm test"), null, "a child may keep ordinary npm test work unbound");
	    for (const command of ["rm -rf tmp/ordinary", "git reset --hard", "npm publish", "git push"]) {
	      assert.equal(
	        gate.routineCommandAllowed("Bash", { command }, child),
	        false,
	        `parent refusal must survive child policy omission: ${command}`,
	      );
	      assert.equal(runChild(command)?.decision, "block", `nested refusal must be blocked: ${command}`);
	    }

	    writeJson(path.join(parent, ".agents", "context", "agents-rules.json"), routineRules({
	      default: "deny",
	      contract_required_heads: { destructive_filesystem: ["rm"] },
	      contract_required_subcommands: { npm: ["publish"] },
	    }));
	    const conservative = gate.routineAllowance(child);
	    assert.equal(conservative.default, "deny", "a parent deny must conservatively override a child allow");
	    assert.equal(gate.routineCommandAllowed("Bash", { command: "npm test" }, child), false);
		assert.equal(runChild("npm test")?.decision, "block", "parent deny must block ordinary child commands");
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
		}
		  console.log("nested routine policy: PASS");
	}

	{
		const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gate-routine-malformed-"));
		const child = path.join(parent, "child");
		try {
			fs.mkdirSync(path.join(parent, ".git"), { recursive: true });
			fs.mkdirSync(path.join(child, ".git"), { recursive: true });
			fs.mkdirSync(path.join(parent, ".agents", "context"), { recursive: true });
			fs.writeFileSync(path.join(parent, ".agents", "context", "agents-rules.json"), "{\"ai_workflow\":");
			writeJson(path.join(child, ".agents", "context", "agents-rules.json"), {
				ai_workflow: {
					routine_action_authorization: {
						unbound_routine_commands: { default: "allow" },
					},
				},
			});
			writeJson(path.join(child, ".codex", "hooks.json"), {});

			const allowance = gate.routineAllowance(child);
			assert.equal(allowance.default, "deny", "a malformed existing ancestor policy must fail closed");
			assert.equal(
				gate.routineCommandAllowed("Bash", { command: "npm test" }, child),
				false,
				"malformed ancestor policy must not preserve a child routine allowance",
			);
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
		}
		console.log("malformed ancestor policy: PASS");
	}

	{
		// agents-rules.json names a detail file; a missing or malformed one is an
		// incomplete policy and must fail closed, not fall back to the default.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-routine-missing-detail-"));
		try {
			fs.mkdirSync(path.join(root, ".git"), { recursive: true });
			writeJson(path.join(root, ".agents", "context", "agents-rules.json"), {
				detail: { file: ".agents/context/agents-rules-detail.json" },
			});
			writeJson(path.join(root, ".codex", "hooks.json"), {});
			assert.equal(gate.routineAllowance(root).default, "deny", "a missing detail file must fail closed");
			assert.equal(gate.routineCommandAllowed("Bash", { command: "npm test" }, root), false, "missing detail file must refuse routine commands");
			fs.writeFileSync(path.join(root, ".agents", "context", "agents-rules-detail.json"), "{\"ai_workflow\":");
			assert.equal(gate.routineAllowance(root).default, "deny", "a malformed detail file must fail closed");
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
		console.log("missing or malformed detail file: PASS");
	}

	{
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-routine-malformed-patterns-"));
		try {
			fs.mkdirSync(path.join(root, ".git"), { recursive: true });
			writeJson(path.join(root, ".agents", "context", "agents-rules.json"), {
				ai_workflow: {
					routine_action_authorization: {
						unbound_routine_commands: {
							default: "allow",
							contract_required_patterns: { patterns: { malformed: true } },
						},
					},
				},
			});
			writeJson(path.join(root, ".codex", "hooks.json"), {});

			const allowance = gate.routineAllowance(root);
			assert.equal(allowance.default, "deny", "a malformed pattern list must fail closed");
			assert.equal(
				gate.routineCommandAllowed("Bash", { command: "npm test" }, root),
				false,
				"a malformed pattern list must not throw or allow a routine command",
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
		console.log("malformed pattern policy: PASS");
	}

	{
	  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-public-routine-"));
	  try {
	    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	    writeJson(path.join(root, ".agents", "context", "agents-rules.json"), {
	      ai_workflow: {
	        routine_action_authorization: {
	          unbound_routine_commands: {
	            default: "allow",
	            contract_required_heads: { destructive_filesystem: ["rm"] },
	            contract_required_subcommands: { git: ["reset"], gh: ["create"] },
	            git_refused_subcommands: ["push"],
	          },
	        },
	      },
	    });
	    writeJson(path.join(root, ".codex", "hooks.json"), {});
	    fs.mkdirSync(path.join(root, ".agents", "skills", "review-pass", "scripts"), { recursive: true });
	    fs.writeFileSync(path.join(root, ".agents", "skills", "review-pass", "scripts", "invoke-reviewer.mjs"), "#!/usr/bin/env node\n");
	    const allowed = (command) => gate.routineCommandAllowed("Bash", { command }, root);
	    assert.equal(allowed("npm test"), true, "ordinary local test remains routine");
	    assert.equal(allowed("git status --short"), true, "read-only Git remains routine");
	    assert.equal(allowed("git -c core.pager=cat status --short"), true, "Git config option does not hide a read-only subcommand");
	    assert.equal(allowed("git --work-tree . log -1 --oneline"), true, "Git work-tree option does not hide a read-only subcommand");
	    assert.equal(allowed("git log -1 --oneline"), true, "read-only Git history remains routine");
	    assert.equal(allowed("gh pr view 1"), true, "read-only GitHub inspection remains routine");
	    assert.equal(allowed("kubectl get pods"), true, "read-only cluster inspection remains routine");
	    assert.equal(allowed("helm list"), true, "read-only Helm inspection remains routine");
	    assert.equal(allowed('rg "handleRequest\\(" src'), true, "quoted rg regex remains routine");
	    assert.equal(allowed('grep -E "a{2,}" file'), true, "quoted grep regex remains routine");

	    for (const command of [
	      "bash --login -c 'rm -rf tmp/x'",
	      '"sh" -c "rm -rf tmp/x"',
	      '"/bin/sh" --command "rm -rf tmp/x"',
	      "env FOO=bar bash --execute='rm -rf tmp/x'",
	    ]) {
	      assert.equal(allowed(command), false, `inline shell execution must require a contract: ${command}`);
	    }

	    assert.equal(allowed("node .codex/hooks/test-session-contract-gate.cjs"), true, "governance test script path is an executable read source");
    for (const command of [
	      "cp policy.json ../.codex/hooks.json",
	      "cp --target-directory=.agents/context source",
	      "echo hi>.agents/context/file",
	      "sed -i 's/a/b/' ../.agents/context/agents-rules.json",
	      "sed -i 's/a/b/' ../other-project/src/app.ts",
	      "sed -i x ../outside/a localfile",
	      "sed -i x .agents/context/source localfile",
	      "tee .agents/context/source localfile",
	      "touch ../sibling/OUTSIDE",
	    ]) {
	      assert.equal(allowed(command), false, `external mutation target must require a contract: ${command}`);
	    }

	    const trustedReview = "node .agents/skills/review-pass/scripts/invoke-reviewer.mjs --tool codex";
	    assert.equal(gate.reviewInvokerCommand(trustedReview, root), true, "the exact reviewer invocation is trusted");
    assert.equal(allowed(trustedReview), true, "the exact reviewer invocation remains routine");
    assert.equal(gate.reviewInvokerCommand(`${trustedReview} > review.json`, root), false, "review redirect is not trusted");
    assert.equal(gate.reviewInvokerCommand(`${trustedReview}\nrm -rf ordinary-fixture`, root), false, "review newline is not trusted");
    // Without the exemption the redirect is judged on its own: an ordinary
    // in-project write, which is routine anyway. Only the destructive tail below
    // needs a contract.
    assert.equal(allowed(`${trustedReview} > review.json`), true, "review redirect is an ordinary in-project write");
    assert.equal(allowed(`${trustedReview}\nrm -rf ordinary-fixture`), false, "review newline cannot bypass the routine gate");

    assert.equal(allowed("env rm -rf ordinary-fixture"), false, "env wrapper cannot hide destructive head");
    assert.equal(allowed("printf ok\nrm -rf ordinary-fixture"), false, "newline-separated destructive command is refused");
    assert.equal(allowed("gh issue create --title fixture --body fixture"), false, "public issue creation remains contract-required");
    assert.equal(allowed("git push origin unrelated-branch"), false, "public push remains contract-required");

	    for (const command of [
	      "if true; then rm -f ordinary-fixture; fi",
      "for x in ordinary-fixture; do rm -f \"$x\"; done",
      "(rm -f ordinary-fixture)",
      "{ rm -f ordinary-fixture; }",
      "time rm -f ordinary-fixture",
      "exec rm -f ordinary-fixture",
      "\\rm -f ordinary-fixture",
	      "git restore ordinary-fixture",
	      "git restore -- .",
	      "git -c core.pager=cat restore .",
	      "git -ccore.pager=cat restore .",
	      "git checkout -- ordinary-fixture",
	      "git checkout -f",
	      "git --work-tree . checkout -- .",
	      "git --work-tree=. checkout -- .",
	      "git config --global user.name fixture",
	      "git --git-dir=.git config --global user.name fixture",
	      "git remote add origin https://example.invalid/repo.git",
	      "git remote set-url origin https://example.invalid/repo.git",
	      "git -c core.pager=cat remote add origin https://example.invalid/repo.git",
	      "git --work-tree . remote set-url origin https://example.invalid/repo.git",
	      "git stash drop",
	      "git stash clear",
	      "git -c core.pager=cat stash drop",
	      "git --work-tree . stash clear",
      "gh pr create --title fixture",
      "gh pr merge 1",
	"gh pr comment 1 --body fixture",
	"gh pr close 1",
	"gh pr review 1 --approve",
	"gh pr edit 1 --title fixture",
	"gh pr reopen 1",
	"gh pr lock 1",
	"gh issue comment 1 --body fixture",
      "glab mr create",
      "glab mr merge 1",
      "glab mr close 1",
      "glab mr comment 1 --body fixture",
      "az group delete --name fixture",
      "az vm create --name fixture",
      "gcloud compute instances create fixture",
      "kubectl create namespace fixture",
      "kubectl edit deployment fixture",
      "kubectl set image deployment/fixture image=example.invalid/fixture:latest",
      "kubectl drain fixture",
      "helm install fixture chart",
      "helm uninstall fixture",
      "cp policy.json .agents",
    ]) {
      assert.equal(allowed(command), false, `mutation must require a contract: ${command}`);
    }
  } finally {
	    fs.rmSync(root, { recursive: true, force: true });
	  }
	  const publicDefaults = [
	    ["npm test", true],
	    ["env rm -rf ordinary-fixture", false],
	    ["printf ok\nrm -rf ordinary-fixture", false],
	    ["gh issue create --title fixture --body fixture", false],
	    ["git push origin unrelated-branch", false],
	  ];
	  for (const [command, expected] of publicDefaults) {
	    assert.equal(
	      gate.routineCommandAllowed("Bash", { command }, repositoryRoot),
	      expected,
	      `public default classification: ${command}`,
	    );
	  }
	  console.log("public routine refusals: PASS");
	}
}

// The built-in policy (used when a rules file has no routine section) must
// stay identical to the repository rules file, minus its documentation keys.
function runBuiltinPolicyTests() {
	const policy = require("./routine-policy.cjs");
	const rules = require("../../.agents/hooks/core/agents-rules-load.js").readAgentsRules(repositoryRoot);
	const declared = rules.ai_workflow.routine_action_authorization.unbound_routine_commands;
	const strip = (value) => {
		if (Array.isArray(value)) return value;
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "_doc" && key !== "hidden_forms_are_resolved" && key !== "still_requires_contract").map(([key, inner]) => [key, strip(inner)]));
		return value;
	};
	assert.deepEqual(strip(policy.BUILTIN_UNBOUND_ROUTINE_COMMANDS), strip(declared), "built-in routine policy must mirror agents-rules.json");
	const bare = fs.mkdtempSync(path.join(os.tmpdir(), "gate-routine-builtin-"));
	try {
		fs.mkdirSync(path.join(bare, ".git"), { recursive: true });
		writeJson(path.join(bare, ".codex", "hooks.json"), {});
		writeJson(path.join(bare, ".agents", "context", "agents-rules.json"), {});
		const allowed = (command) => gate.routineCommandAllowed("Bash", { command }, bare);
		assert.equal(allowed("npm test"), true, "a rules file without the section allows ordinary work");
		assert.equal(allowed("rm -rf build"), false, "…and still refuses what cannot be undone");
	} finally {
		fs.rmSync(bare, { recursive: true, force: true });
	}
	console.log("built-in routine policy: PASS");
}

module.exports = { runRoutinePolicyTests, runBuiltinPolicyTests };

if (require.main === module) {
	runRoutinePolicyTests();
	runBuiltinPolicyTests();
}
