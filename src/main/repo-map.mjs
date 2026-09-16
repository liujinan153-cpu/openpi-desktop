/**
 * P62：repo map——会话启动注入工作区地图（Aider 取经）。
 * 目录树（≤3 层、≤220 条、忽略垃圾目录）+ 项目元信息（package.json name/scripts、语言探测）。
 * 给弱模型导航用：AI 不再靠反复 ls 猜结构。带缓存：目录 mtime 未变直接复用。
 * 注入方式与 memory/checkpoint 同构：systemPrompt 扩展，非工具。
 */
import fs from "node:fs";
import path from "node:path";

const IGNORE = new Set([
	"node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage", "__pycache__",
	".venv", "venv", ".idea", ".vscode", ".openpi", "vendor", "target", "bin", "obj", ".cache",
	"tmp", "temp", ".pytest_cache", ".mypy_cache", "eggs", ".tox", "site-packages",
]);
const MAX_ENTRIES = 220;
const MAX_DEPTH = 3;

const g = globalThis;
g.__repoMapCache = g.__repoMapCache || new Map(); // cwd -> { stamp, text }

/** 递归收集目录树条目 */
function walk(dir, depth, prefix, out) {
	if (out.count >= MAX_ENTRIES || depth > MAX_DEPTH) return;
	let items = [];
	try {
		items = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !IGNORE.has(e.name));
	} catch {
		return;
	}
	items.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
	for (const e of items) {
		if (out.count >= MAX_ENTRIES) {
			out.truncated = true;
			return;
		}
		const full = path.join(dir, e.name);
		out.lines.push(`${prefix}${e.isDirectory() ? e.name + "/" : e.name}`);
		out.count++;
		if (e.isDirectory()) walk(full, depth + 1, prefix + "  ", out);
	}
}

/** 项目元信息一行流 */
function meta(cwd) {
	const bits = [];
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
		const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 8).join(", ");
		bits.push(`npm 项目「${pkg.name ?? "?"}」${pkg.description ? `：${String(pkg.description).slice(0, 80)}` : ""}`);
		if (scripts) bits.push(`scripts: ${scripts}`);
	} catch { /* 非 npm 项目 */ }
	const markers = [
		["pyproject.toml", "Python(pyproject)"], ["requirements.txt", "Python"],
		["go.mod", "Go"], ["Cargo.toml", "Rust"], ["pom.xml", "Java(Maven)"], ["*.csproj", null],
	];
	for (const [f, label] of markers) {
		if (f.includes("*")) {
			if (fs.readdirSync(cwd).some((n) => n.endsWith(".csproj"))) bits.push(".NET/C#");
		} else if (fs.existsSync(path.join(cwd, f))) bits.push(label);
	}
	return bits.join("；");
}

/** 生成 repo map 文本（空仓库返回 ""） */
export function repoMapSystemPrompt(cwd) {
	if (!cwd || !fs.existsSync(cwd)) return "";
	// 缓存：目录树 mtime 粗粒度（cwd 本身 + 5s 节流），粒度足够
	const cache = g.__repoMapCache;
	const hit = cache.get(cwd);
	const now = Date.now();
	if (hit && now - hit.stamp < 5000) return hit.text;
	let dirMtime = 0;
	try {
		dirMtime = fs.statSync(cwd).mtimeMs;
	} catch { /* ignore */ }
	if (hit && hit.dirMtime === dirMtime) {
		hit.stamp = now;
		return hit.text;
	}
	const out = { lines: [], count: 0, truncated: false };
	walk(cwd, 1, "", out);
	if (!out.lines.length) return "";
	const tree = out.lines.join("\n") + (out.truncated ? `\n…（超过 ${MAX_ENTRIES} 条已截断，用 ls/grep 深挖）` : "");
	const m = meta(cwd);
	const text =
		`\n\n## 工作区地图（自动生成，改动后可能过期）\n${m ? m + "\n" : ""}` +
		"```\n" + tree + "\n```\n" +
		"探索细节用 ls/grep/code_symbols；改代码后用 run_tests 自证（P62）。\n";
	cache.set(cwd, { stamp: now, dirMtime, text });
	return text;
}
