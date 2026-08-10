const fs = require("fs");
const path = require("path");

/**
 * A payload root is acceptable when it is the installed harness itself or a
 * project nested inside it.
 *
 * The check exists to reject a payload pointing at some other harness
 * installation, and containment still rejects that. Requiring exact equality
 * additionally rejected every nested project — once a submodule became its own
 * boundary, working inside one failed with installed_project_root_mismatch
 * before the gate ever ran, which is stricter than the collapse it replaced.
 */
function withinInstalledRoot(candidate, installedRoot) {
	if (candidate === installedRoot) return true;
	const relative = path.relative(installedRoot, candidate);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

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
			if (!withinInstalledRoot(canonicalPayloadRoot, installedRoot)) {
				throw Object.assign(new Error("hook payload root does not match the installed ADK harness"), { code: "installed_project_root_mismatch" });
			}
			// Policy and runtime state stay at the installed root even when the
			// session works inside a nested project.
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
			// Same containment rule as the uninherited branch: a nested project is
			// a legitimate payload root, anything outside the harness is not.
			if (!withinInstalledRoot(canonicalPayloadRoot, projectRoot)) {
				throw Object.assign(new Error("hook payload root does not match ADK_PROJECT_ROOT"), { code: "inherited_project_root_mismatch" });
			}
		}
		return projectRoot;
	};
};
