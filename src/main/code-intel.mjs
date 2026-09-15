// P58：轻量代码智能（诊断 + 符号导航）+ 验证门槛项目化引导（verify_init）
// 设计立场：不做全量 LSP（每语言一个 server 进程，成本高收益边际）——
// 用 node --check / tsc --noEmit / py_compile 覆盖 90% 场景，配 hooks 验证门槛形成硬闭环
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

let wsDir = null; // 工作目录（agent-host 注入；ctx.cwd 是进程 cwd 不可靠，见 #105）
let agentDir = null; // 沙箱 agentDir（hooks checker 脚本落盘处）
export function setCodeIntelWorkspace(ws, ad = null) {
	wsDir = ws || null;
	agentDir = ad || null;
}

/** P58：验证门槛检查器（node --check 不支持 ESM，需按 .mjs / package.json type 判模块类型）——写入 agentDir 供 hooks 命令调用 */
const CHECKER_JS = `const fs=require("fs"),path=require("path"),cp=require("child_process");
const p=process.argv[2];
if(!p||!fs.existsSync(p)){process.stderr.write("file not found: "+p);process.exit(1);}
const src=fs.readFileSync(p,"utf8");
const pj=(()=>{try{return JSON.parse(fs.readFileSync(path.join(path.dirname(p),"package.json"),"utf8"))||{}}catch{return{}}})();
const esm=/\\.mjs$/.test(p)||(/\\.js$/.test(p)&&pj.type==="module")||/\\.mts$/.test(p);
const r=cp.spawnSync(process.execPath,esm?["--input-type=module","--check"]:["--check"],{input:src});
if(r.status===0)process.exit(0);
process.stderr.write(String(r.stderr||"syntax error"));
process.exit(1);
`;
export function ensureChecker() {
	if (!agentDir) return null;
	const p = path.join(agentDir, "verify-check.cjs");
	try { fs.writeFileSync(p, CHECKER_JS); return p; } catch { return null; }
}
/** hooks 命令模板（调 checker，支持 js/mjs/cjs/ts 型项目统一用） */
export function checkerCommand() {
	const p = ensureChecker();
	return p ? `node "${p.split(path.sep).join("/")}" "{{input.path}}"` : null;
}

const resolveInWs = (p) => (path.isAbsolute(p) ? p : path.join(wsDir || process.cwd(), p));

/** 向上找项目根（含 package.json 的目录） */
function findProjectRoot(startFile) {
	let dir = path.dirname(path.resolve(startFile));
	for (let i = 0; i < 12; i++) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const up = path.dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
	return null;
}

const out = (text, ok = true) => ({ content: [{ type: "text", text }], details: { ok } });

/** 单文件诊断：按扩展名分发到最轻量的编译器/检查器 */
function diagFile(absFile) {
	if (!fs.existsSync(absFile)) return { ok: false, text: `文件不存在：${absFile}` };
	const ext = path.extname(absFile).toLowerCase();
	try {
		if ([".js", ".mjs", ".cjs"].includes(ext)) {
			const checker = ensureChecker();
			if (checker) execFileSync("node", [checker, absFile], { timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
			else execFileSync("node", ["--check", absFile], { timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });
			return { ok: true, text: `语法检查通过：${absFile}` };
		}
		if ([".ts", ".tsx"].includes(ext)) {
			const root = findProjectRoot(absFile);
			const tsc = root && fs.existsSync(path.join(root, "node_modules", "typescript", "bin", "tsc"));
			if (!root || !tsc) return { ok: false, text: `项目未安装 typescript（需 ${path.join(root ?? "", "node_modules/typescript")}），无法做类型诊断。可先 npm i -D typescript` };
			const r = execFileSync("node", [path.join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--pretty", "false"], { cwd: root, timeout: 90000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			return { ok: true, text: `tsc --noEmit 通过（全项目）\n${(r || "").slice(0, 500)}` };
		}
		if (ext === ".py") {
			execFileSync("python", ["-m", "py_compile", absFile], { timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
			return { ok: true, text: `py_compile 通过：${absFile}` };
		}
		return { ok: false, text: `暂不支持该类型（${ext}）的自动诊断；js/mjs/cjs → node --check，ts/tsx → tsc --noEmit，py → py_compile` };
	} catch (e) {
		const detail = String(e.stderr || e.stdout || e.message || "").slice(0, 2000);
		return { ok: false, text: `诊断未通过：\n${detail}` };
	}
}

/** 符号导航：正则提取函数/类定义（行号），大仓库快速定位用 */
function symbolScan(absFile) {
	if (!fs.existsSync(absFile)) return null;
	const ext = path.extname(absFile).toLowerCase();
	const lines = fs.readFileSync(absFile, "utf8").split("\n");
	const hits = [];
	const pyLike = ext === ".py";
	const re = pyLike
		? /^\s*(?:async\s+)?def\s+(\w+)|^\s*class\s+(\w+)/
		: /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)|(?:export\s+)?class\s+(\w+)|(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(|^\s*(?:get|set)\s+(\w+)\s*\(/;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(re);
		if (m) hits.push(`${i + 1}: ${m.slice(1).find(Boolean)}`);
	}
	return hits;
}

export const codeIntelTools = [
	{
		name: "code_diag",
		label: "代码诊断",
		description: "对单个代码文件跑轻量诊断：js/mjs/cjs 用 node --check，ts/tsx 用项目内 tsc --noEmit，py 用 py_compile。改完代码后建议调用它自证，输出可直接作为证据引用。",
		promptSnippet: "- code_diag: 代码文件轻量诊断（node --check / tsc / py_compile），改码后自证",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "要诊断的文件路径（相对工作区或绝对）" } },
			required: ["path"],
		},
		execute(_id, params = {}) {
			if (!params.path) return out("缺少参数 path（要诊断的文件路径）", false);
			const r = diagFile(resolveInWs(String(params.path)));
			return out(r.text, r.ok);
		},
	},
	{
		name: "code_symbols",
		label: "符号导航",
		description: "列出代码文件里的函数/类定义及行号（正则提取，秒回）。适合在大文件里快速定位要改的位置，再配合 read 读局部。",
		promptSnippet: "- code_symbols: 列出文件的函数/类定义行号，快速定位",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "要扫描的文件路径" } },
			required: ["path"],
		},
		execute(_id, params = {}) {
			if (!params.path) return out("缺少参数 path", false);
			const abs = resolveInWs(String(params.path));
			const hits = symbolScan(abs);
			if (hits === null) return out(`文件不存在：${abs}`, false);
			if (!hits.length) return out(`未发现函数/类定义（可能不是代码文件，或都是内联逻辑）：${abs}`);
			return out(`符号（行号: 名称）：\n${hits.join("\n").slice(0, 2000)}`);
		},
	},
	{
		name: "verify_init",
		label: "验证门槛配置",
		description: "检测当前项目类型（js/ts/python），返回建议的验证门槛 hooks 配置（写入 <工作区>/.openpi/hooks.json 后立即生效：写代码后的自动检查失败会强制 AI 修复）。调用后应把返回的建议配置用 write 工具写入该文件。",
		promptSnippet: "- verify_init: 检测项目类型并给出验证门槛配置建议（写入 .openpi/hooks.json 生效）",
		parameters: { type: "object", properties: {}, required: [] },
		execute() {
			if (!wsDir) return out("当前会话无工作区，无法配置项目级验证门槛", false);
			const pj = path.join(wsDir, "package.json");
			let pjData = null;
			try { pjData = JSON.parse(fs.readFileSync(pj, "utf8")); } catch { /* 非 node 项目 */ }
			const hooks = [];
			const notes = [];
			if (pjData) {
				const hasTs = fs.existsSync(path.join(wsDir, "node_modules", "typescript"));
				const cmd = checkerCommand();
				if (hasTs) {
					hooks.push({ _note: "P58：TS 项目类型门槛（写 ts 后全项目 tsc --noEmit，失败强制修复）", on: ["write", "edit"], phase: "after", command: "npx tsc --noEmit --pretty false", timeoutMs: 90000, blockOnError: true });
					notes.push("检测到 TypeScript 项目 → 建议 tsc --noEmit 类型门槛（较重，每次写码后约 10–60s，可按需去掉）");
				} else if (cmd) {
					hooks.push({ _note: "P58：JS/ESM 语法门槛（自动识别模块类型，失败强制修复）", on: ["write", "edit"], phase: "after", command: cmd, timeoutMs: 20000, blockOnError: true });
					notes.push("检测到 Node 项目 → 建议 JS/ESM 语法门槛（支持 .mjs 与 type:module）");
				}
				if (pjData.scripts?.test) notes.push(`项目有测试脚本「npm test」——建议重大改动后手动跑一次（不放进 hooks：每次写码后全量测试太重）`);
			} else if (fs.readdirSync(wsDir).some((f) => f.endsWith(".py"))) {
				hooks.push({ _note: "P58：Python 语法门槛", on: ["write", "edit"], phase: "after", command: 'python -m py_compile "{{input.path}}"', timeoutMs: 30000, blockOnError: true });
				notes.push("检测到 Python 项目 → 建议 py_compile 语法门槛");
			} else {
				hooks.push({ _note: "P58：默认 JS 语法门槛", on: ["write", "edit"], phase: "after", command: 'node --check "{{input.path}}"', timeoutMs: 15000, blockOnError: true });
				notes.push("未识别项目类型 → 用默认 JS 语法门槛");
			}
			const target = path.join(wsDir, ".openpi", "hooks.json");
			return out(
				`项目类型分析：\n- ${notes.join("\n- ")}\n\n建议配置（请用 write 工具原样写入 ${target.split(path.sep).join("/")}，写完立即生效）：\n${JSON.stringify(hooks, null, 2)}`,
			);
		},
	},
];
