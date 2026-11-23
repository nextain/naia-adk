"use strict";
// Disposable CLI stand-ins shared by rotation behavior tests.
const fs=require("node:fs"),path=require("node:path");
const deployPlan=require("../lib/deploy-plan.js");

function writeFakeBins(tmp, { argonBody, argonStderr = "", argonStatus = 0, codexBody, codexStatus = 0, withMarker = false }) {
	const binDir = path.join(tmp, "bin");
	const fakeHome = path.join(tmp, "home");
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
	fs.mkdirSync(path.join(fakeHome, ".gemini"), { recursive: true });
	const bwrap = path.join(binDir, "bwrap");
	fs.writeFileSync(bwrap, '#!/bin/sh\nwhile [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
	const marker = path.join(tmp, "codex-ran");
	const passBody = ["판정: PASS", ...deployPlan.CRITERIA.map(([id]) => `${id}: PASS`), "참고 지적: 0", "남은 지적: 0"].join("\n");
	const argon = path.join(binDir, "fake-agy");
	fs.writeFileSync(argon, `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' "${argonBody}"\nprintf '%s\\n' "${argonStderr}" >&2\nexit ${argonStatus}\n`, { mode: 0o755 });
	const codex = path.join(binDir, "fake-codex");
	fs.writeFileSync(codex, `#!/bin/sh\n${withMarker ? `: > "${marker}"\n` : ""}[ "$1" = exec ] || exit 19\nfor arg do last="$arg"; done\n[ "$last" = - ] || exit 20\ncat >/dev/null\nprintf 'codex\\n'\ncat <<'REVIEW_EOF'\n${codexBody ?? passBody}\nREVIEW_EOF\nprintf 'tokens used\\n'\nexit ${codexStatus}\n`, { mode: 0o755 });
	return { binDir, fakeHome, marker };
}

module.exports={writeFakeBins};
