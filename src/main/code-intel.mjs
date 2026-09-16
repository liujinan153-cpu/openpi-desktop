// P58：轻量代码智能（诊断 + 符号导航）+ 验证门槛项目化引导（verify_init）
// 设计立场：不做全量 LSP（每语言一个 server 进程，成本高收益边际）——
// 用 node --check / tsc --noEmit / py_compile 覆盖 90% 场景，配 hooks 验证门槛形成硬闭环
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import ts from "typescript"; // P63 静态导入（worker 里 async custom tool + 动态 import 有竞态：tool result 不回传致 agent loop 卡死）

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

/** P62：ast-grep 二进制定位（打包态 extraResources / dev 态 node_modules） */
function sgBin() {
	try {
		const packed = path.join(process.resourcesPath ?? "", "ast-grep.exe");
		if (packed && fs.existsSync(packed)) return packed;
	} catch { /* 非 electron 环境 */ }
	for (const p of [
		path.join(process.cwd(), "resources", "bin", "ast-grep.exe"),
		path.join(process.cwd(), "node_modules", "@ast-grep", "cli", "ast-grep.exe"),
	]) {
		if (fs.existsSync(p)) return p;
	}
	return null;
}

/** sg 语言参数按扩展名映射（不支持的语言返回 null → 提示用 edit） */
function sgLang(file) {
	const ext = path.extname(file).toLowerCase();
	const map = { ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
		".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
		".py": "python", ".rs": "rust", ".go": "go", ".java": "java", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".json": "json", ".html": "html", ".css": "css" };
	return map[ext] ?? null;
}

/** P62：测试命令探测（返回 { cmd, args 模板, name } 或 null） */
function detectTestRunner(cwd) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
		if (pkg.scripts?.test) return { kind: "npm", cmd: "npm", base: ["test"] };
	} catch { /* 非 npm */ }
	if (fs.existsSync(path.join(cwd, "pytest.ini")) || fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "setup.py"))) return { kind: "pytest", cmd: "python", base: ["-m", "pytest"] };
	if (fs.existsSync(path.join(cwd, "go.mod"))) return { kind: "go", cmd: "go", base: ["test", "./..."] };
	if (fs.existsSync(path.join(cwd, "Cargo.toml"))) return { kind: "cargo", cmd: "cargo", base: ["test"] };
	return null;
}

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
	{
		name: "ast_edit",
		label: "结构化编辑",
		description:
			"用 ast-grep 按语法树批量替换代码（P62）：pattern 里用 $VAR 匹配单节点、$$$REST 匹配序列。先预览（apply 省略）统计匹配数：0 处报错（放宽 pattern），超 30 处拒绝（收窄 path 或加上下文）；确认后传 apply=true 写入。语法树级替换天然不错配引号/缩进——重命名/大范围重构首选，小改动用 edit 即可。支持 js/ts/tsx/py/go/rust/java/c/cpp/json/html/css。",
		promptSnippet: "- ast_edit: ast-grep 语法树批量替换（重命名/重构首选，不错配）",
		parameters: {
			type: "object",
			properties: {
				pattern: { type: "string", description: "查找模式（$VAR 单节点，$$$REST 序列）" },
				rewrite: { type: "string", description: "替换模板（可引用 pattern 变量）" },
				path: { type: "string", description: "目标文件或目录（相对工作区或绝对；目录递归）" },
				lang: { type: "string", description: "可选：语言（默认按扩展名推断）" },
				apply: { type: "boolean", description: "true=写入；省略=只预览" },
			},
			required: ["pattern", "rewrite", "path"],
		},
		execute(_id, params = {}) {
			if (!params.pattern || params.rewrite === undefined || !params.path) return out("缺少参数（pattern/rewrite/path 均必填）", false);
			const bin = sgBin();
			if (!bin) return out("ast-grep 二进制不可用——请改用 edit 工具做文本替换", false);
			const target0 = resolveInWs(String(params.path));
			if (!fs.existsSync(target0)) return out(`路径不存在：${target0}`, false);
			// 坑：ast-grep 把路径参数当 glob 模式，Windows 反斜杠被视为转义符→静默 0 匹配/exit1——一律转正斜杠
			const target = target0.split(path.sep).join("/");
			const isDir = fs.statSync(target0).isDirectory();
			if (!isDir) {
				const lang = params.lang || sgLang(target);
				if (!lang) return out(`不支持的语言：${path.extname(target) || target}（ast_edit 面向代码文件；配置/文本用 edit）`, false);
			}
			let preview;
			try {
				preview = execFileSync(bin, [
					"run", "--pattern", String(params.pattern), "--json=compact",
					...(params.lang ? ["-l", String(params.lang)] : []),
					target,
				], { encoding: "utf8", timeout: 30000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
			} catch (e) {
				return out(`ast-grep 执行失败：${String(e.stderr ?? e.message).slice(0, 300)}`, false);
			}
			let matches = [];
			try { matches = JSON.parse(preview); } catch { /* 空输出 = 0 匹配 */ }
			const n = Array.isArray(matches) ? matches.length : 0;
			if (n === 0) return out("0 处匹配——pattern 太窄或语法不匹配。可用 code_symbols 先定位，或放宽 pattern 重试。", false);
			if (n > 30 && !params.apply) return out(`${n} 处匹配，超 30——预览拒绝。请收窄 path 范围或给 pattern 加更多上下文，避免误伤。`, false);
			const where = matches.slice(0, 5).map((m) => `${m.file?.file ?? "?"}:${m.metaVariables?.single?.start?.line ?? "?"}`).join(", ");
			if (!params.apply) return out(`${n} 处匹配（${where}${n > 5 ? " …" : ""}）。确认无误后传 apply=true 写入。`);
			// 应用重写（spawnSync：ast-grep 把 "Applied N changes" 写 stderr，execFileSync 拿不到 stderr）
			const rr = spawnSync(bin, [
				"run", "--pattern", String(params.pattern), "--rewrite", String(params.rewrite), "--update-all",
				...(params.lang ? ["-l", String(params.lang)] : []),
				target,
			], { encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
			const all = String(rr.stdout ?? "") + String(rr.stderr ?? "");
			if (rr.status !== 0) return out(`ast-grep 重写失败：${String(rr.stderr ?? rr.error?.message ?? "").slice(0, 300)}`, false);
			const applied = /Applied (\d+) changes/.exec(all)?.[1] ?? "?";
			return out(`已应用 ${applied} 处替换（${target}）。建议立即 code_diag 或 run_tests 自证。`, true);
		},
	},
	{
		name: "run_tests",
		label: "跑测试",
		description:
			"在工作区跑测试套件（P62）：自动探测 npm test / pytest / go test / cargo test。传 file 可尝试只跑相关测试（npm 项目默认 vitest；不适用则回落全套）。改代码后优先用它自证——验证行为而不只是语法。输出自动截断保留尾部（错误通常在尾部）。",
		promptSnippet: "- run_tests: 跑项目测试（npm/pytest/go/cargo 自动探测），改码后自证首选",
		parameters: {
			type: "object",
			properties: { file: { type: "string", description: "可选：相关源文件/测试文件路径，尝试只跑受影响测试" } },
		},
		execute(_id, params = {}) {
			const cwd = wsDir || process.cwd();
			const runner = detectTestRunner(cwd);
			if (!runner) return out("未探测到测试设施（package.json scripts.test / pytest / go / cargo 均无）——用 code_diag 做语法自证即可", false);
			let args = [...runner.base];
			if (params.file) {
				const abs = resolveInWs(String(params.file));
				let rel = path.relative(cwd, abs).split(path.sep).join("/");
				if (runner.kind === "npm") {
					if (!/(test|spec)\./.test(rel)) {
						const stem = path.basename(rel, path.extname(rel));
						const ext = path.extname(rel);
						const cand = ["test", "tests", "__tests__", "src"].flatMap((d) => [path.join(cwd, d, `${stem}.test${ext}`), path.join(cwd, d, `${stem}.spec${ext}`)]).filter((p2) => fs.existsSync(p2));
						if (cand.length) rel = path.relative(cwd, cand[0]).split(path.sep).join("/");
					}
					args = ["exec", "vitest", "run", rel]; // npm 项目默认 vitest；失败信息里会体现，非 vitest 项目回落 npm test 重试
				} else if (runner.kind === "pytest") {
					args.push(rel);
				}
				// go/cargo 按包粒度，不按文件过滤
			}
			let r;
			try {
				r = execFileSync(runner.cmd, args, { cwd, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: runner.kind === "npm" });
			} catch (e) {
				const stdout = String(e.stdout ?? "");
				// npm 项目 vitest 不存在时回落 npm test
				if (runner.kind === "npm" && /is not recognized|not found|ERR_.unknown/.test(stdout + String(e.stderr ?? ""))) {
					try {
						r = execFileSync(runner.cmd, ["test"], { cwd, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: true });
					} catch (e2) {
						return out(`测试失败（exit ${e2.status ?? "?"}）：\n${String(e2.stdout ?? "").slice(-3000) || String(e2.message).slice(0, 800)}`, false);
					}
				} else {
					return out(`测试失败（exit ${e.status ?? "?"}）：\n${stdout.slice(-3000) || String(e.message).slice(0, 800)}`, false);
				}
			}
			return out(`测试通过：\n${String(r).slice(-3000)}`);
		},
	},
	{
		name: "lsp_diag",
		label: "语义诊断",
		description:
			"对 JS/TS/JSX/TSX 文件做语义级诊断（P63，内嵌 TypeScript 编译器）：类型错误、不存在的导出/属性、参数个数不对等。改代码后配合 run_tests 用：run_tests 证行为，lsp_diag 证类型。只报 Error 级（Warning/提示忽略）避免噪音；Python 文件不支持（用 code_diag）。首次调用需编译项目（数秒）属正常。",
		promptSnippet: "- lsp_diag: JS/TS 语义级诊断（类型错误/导出缺失），run_tests 的好搭档",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "要诊断的文件路径（相对工作区或绝对）" } },
			required: ["path"],
		},
		execute(_id, params = {}) {
			try {
				if (!params.path) return out("缺少参数（path 必填）", false);
				const abs = resolveInWs(String(params.path));
				if (!fs.existsSync(abs)) return out(`文件不存在：${abs}`, false);
				const ext = path.extname(abs).toLowerCase();
				if (![".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"].includes(ext))
					return out(`lsp_diag 暂只支持 JS/TS（收到 ${ext || abs}）。Python/其他语言用 code_diag 做语法检查`, false);
				// 找项目 tsconfig（有则继承编译选项；无则用宽松默认，allowJs+checkJs）
				const wsRoot = wsDir || path.dirname(abs);
				const configPath = ts.findConfigFile(wsRoot, ts.sys.fileExists, "tsconfig.json");
				let compilerOptions;
				const rootNames = [abs];
				if (configPath) {
					const cfg = ts.getParsedCommandLineOfConfigFile(configPath, { skipLibCheck: true }, ts.sys);
					compilerOptions = { ...cfg?.options, noEmit: true, skipLibCheck: true };
				} else {
					compilerOptions = {
						allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true,
						target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext,
						moduleResolution: ts.ModuleResolutionKind.NodeJs, esModuleInterop: true,
						resolveJsonModule: true, jsx: ext === ".tsx" || ext === ".jsx" ? ts.JsxEmit.ReactJSX : undefined,
					};
				}
				const program = ts.createProgram(rootNames, compilerOptions);
				const sf = program.getSourceFile(abs);
				if (!sf) return out(`文件未被编译器加载：${abs}`, false);
				const all = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
				const errs = all.filter((d) => d.category === ts.DiagnosticCategory.Error); // 只报 Error 级，Warning 忽略防噪音
				if (!errs.length) return out(`✓ 语义诊断通过（${path.basename(abs)}，Error 级 0 条）`, true);
				const lines = errs.slice(0, 30).map((d) => {
					const { line, character } = sf.getLineAndCharacterOfPosition(d.start ?? 0);
					const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n").split("\n")[0];
					return `${line + 1}:${character + 1} TS${d.code} ${msg}`;
				});
				return out(
					`发现 ${errs.length} 条语义错误${errs.length > 30 ? "（仅列前 30）" : ""}：\n${lines.join("\n")}\n\n修复后建议 run_tests 验证行为。`,
					false,
				);
			} catch (e) {
				return out(`lsp_diag 异常：${String(e.message ?? e).slice(0, 300)}`, false);
			}
		},
	},
];
