import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(input, home = os.homedir()) {
	return String(input ?? "").replace(/^~(?=[\\/]|$)/, home);
}

export function isWithin(root, target) {
	const base = path.resolve(root);
	const full = path.resolve(target);
	return full === base || full.startsWith(base + path.sep);
}

/** 阻止符号链接把表面上的工作区路径导向工作区外。目标可不存在（写新文件场景）。 */
export function isWithinReal(root, target) {
	try {
		const base = fs.realpathSync(path.resolve(root));
		let probe = path.resolve(target);
		const tail = [];
		while (!fs.existsSync(probe)) {
			const parent = path.dirname(probe);
			if (parent === probe) return false;
			tail.unshift(path.basename(probe));
			probe = parent;
		}
		const real = path.resolve(fs.realpathSync(probe), ...tail);
		return real === base || real.startsWith(base + path.sep);
	} catch {
		return false;
	}
}

export function resolveAllowedPath(roots, input, { mustExist = false, base = null } = {}) {
	const allowed = (roots ?? []).filter(Boolean).map((r) => path.resolve(r));
	if (!allowed.length) throw new Error("当前会话没有可访问目录");
	const raw = String(input ?? "");
	if (!raw) throw new Error("路径为空");
	const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base || allowed[0], raw);
	if (!allowed.some((root) => isWithin(root, abs) && isWithinReal(root, abs))) throw new Error("路径不在允许目录内");
	if (mustExist && !fs.existsSync(abs)) throw new Error("路径不存在");
	return abs;
}

export function resolveWorkspacePath(workspace, input, opts = {}) {
	if (!workspace) throw new Error("当前会话无工作区");
	return resolveAllowedPath([workspace], input, { ...opts, base: workspace });
}
