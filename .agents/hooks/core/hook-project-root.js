const fs = require("fs");
const path = require("path");

module.exports = function createHookProjectRoot({ findProjectRoot }) {
	return function resolveHookProjectRoot(start, env = process.env) {
		const payloadRoot = findProjectRoot(start);
		let installedRoot = findProjectRoot(path.resolve(__dirname, "..", "..", ".."));
		try { installedRoot = installedRoot ? fs.realpathSync(installedRoot) : null; } catch { installedRoot = null; }
		if (!installedRoot) {
			throw Object.assign(new Error("installed Codex ADK root is unavailable"), { code: "installed_project_root_invalid" });
		}
		const inherited = env?.ADK_PROJECT_ROOT;
		if (inherited === undefined || inherited === "") {
			if (!payloadRoot) return null;
			let canonicalPayloadRoot = payloadRoot;
			try { canonicalPayloadRoot = fs.realpathSync(payloadRoot); } catch {}
			if (canonicalPayloadRoot !== installedRoot) {
				throw Object.assign(new Error("hook payload root does not match the installed ADK harness"), { code: "installed_project_root_mismatch" });
			}
			return installedRoot;
		}
		if (typeof inherited !== "string" || !path.isAbsolute(inherited)) {
			throw Object.assign(new Error("ADK_PROJECT_ROOT must be absolute"), { code: "inherited_project_root_invalid" });
		}
		let projectRoot;
		try {
			projectRoot = fs.realpathSync(inherited);
			if (!fs.statSync(projectRoot).isDirectory()) throw new Error("not a directory");
		} catch {
			throw Object.assign(new Error("ADK_PROJECT_ROOT must name an existing directory"), { code: "inherited_project_root_invalid" });
		}
		if (findProjectRoot(projectRoot) !== projectRoot || !fs.existsSync(path.join(projectRoot, ".codex", "hooks.json"))) {
			throw Object.assign(new Error("ADK_PROJECT_ROOT is not a Codex ADK root"), { code: "inherited_project_root_invalid" });
		}
		if (projectRoot !== installedRoot) {
			throw Object.assign(new Error("ADK_PROJECT_ROOT does not match the installed ADK harness"), { code: "inherited_project_root_mismatch" });
		}
		if (payloadRoot) {
			let canonicalPayloadRoot = payloadRoot;
			try { canonicalPayloadRoot = fs.realpathSync(payloadRoot); } catch {}
			if (canonicalPayloadRoot !== projectRoot) {
				throw Object.assign(new Error("hook payload root does not match ADK_PROJECT_ROOT"), { code: "inherited_project_root_mismatch" });
			}
		}
		return projectRoot;
	};
};
