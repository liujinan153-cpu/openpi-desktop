/**
 * OpenPi Desktop —— Electron 主进程入口（M3 多窗口）
 *
 * M3：多工作区并行 —— 每个窗口一个独立 AgentHost（独立会话/工作区/模型/审批通道），
 * IPC 按 webContents.id 路由到对应宿主；窗口关闭即释放其 AgentSession。
 */
import { app, BrowserWindow, ipcMain, dialog, shell, Notification, session } from "electron";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { execFileSync, execFile, spawn, spawnSync } from "node:child_process";
import { createAgentProxy } from "./agent-proxy.mjs"; // P43：AgentHost 实例在 agent-worker 子进程，此处仅代理
import { getAgentDir } from "@earendil-works/pi-coding-agent"; // P47 设置文件定位
import { cleanupExpired, sandboxRoot } from "./workspace-store.mjs";
import { SessionIndex } from "./sessions-index.mjs";
import { detectImportSources, importAllClaude, importAllCodex, importAllOpenCode } from "./session-import.mjs"; // P64⑧/P69 外部会话导入
import { initLogger, collectLogBundle } from "./app-logger.mjs"; // P71：主进程日志 + 导出日志包
import { mergeChanges, parseNameStatus, parseNumstat, parsePorcelain } from "./review-changes.mjs"; // P72b：会话改动审阅——git 输出解析纯函数
import { lastCheckpointId } from "./git-checkpoint.mjs"; // P72b：审阅基线=快照链最新提交（P27）
import { ensureShellEnv } from "./shell-env.mjs";
import { initUpdater, checkUpdate, downloadUpdate, installUpdate, openUpdaterConfig, getSnapshot, UPDATER_CFG, feedConfigured } from "./updater.mjs";
import { getConfig, saveProvider, deleteProvider, saveKey, testEndpoint, probeModels, LOCAL_PRESETS } from "./config-store.mjs"; // P76：+probeModels
import { installElectronSecurity } from "./electron-security.mjs";
import { expandHome, resolveAllowedPath, resolveWorkspacePath } from "./path-policy.mjs";
import { BUILTIN_SUBAGENT_META, parseSubagentJsonFile, sanitizeSubagentFilename } from "./p73-logic.mjs"; // P73 子智能体管理

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_FILE = path.join(__dirname, "..", "renderer", "index.html");
const DEFAULT_WORKSPACE = path.join(os.homedir(), "openpi-workspace");
const SESSIONS_ROOT = process.env.OPENPI_SESSIONS_ROOT || path.join(os.homedir(), ".pi", "agent", "sessions"); // env 覆盖供 e2e 隔离

/* ---- P71：主进程日志（~/.pi/agent/logs/main.log），模块加载即初始化，越早越好 ----
 * initLogger 会拦截 console.error/warn 双写文件并兜底 uncaughtException/unhandledRejection */
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent"); // 与 SESSIONS_ROOT/audit 等既有路径保持同一套算法

const LOG_DIR = path.join(AGENT_DIR, "logs");
const logger = initLogger(LOG_DIR);

/** P73：读禁用子智能体清单（openpi-settings.json 的 disabledSubagents；无设置文件/字段缺失 = 空数组） */
function readDisabledSubagents() {
	try {
		const s = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "openpi-settings.json"), "utf8"));
		return Array.isArray(s.disabledSubagents) ? s.disabledSubagents.map(String) : [];
	} catch { return []; }
}
let fatalShown = false; // 防异常风暴导致弹窗循环
process.on("uncaughtException", (err) => {
	// P71：initLogger 注册监听后会吞掉 Electron 默认错误弹窗，这里补一个可见提示（每会话一次）
	if (fatalShown) return;
	fatalShown = true;
	try { dialog.showErrorBox("OpenPi 遇到未处理错误", String(err?.stack ?? err)); } catch { /* app 未就绪等场景忽略 */ }
});
/** webContents.id -> AgentHost */
const hosts = new Map();

function hostOf(e) {
	const h = hosts.get(e.sender.id);
	if (!h) throw new Error("窗口已关闭或会话宿主不存在");
	return h;
}

/**
 * P36：内置 Python 运行时（安装即用）——注入 PATH 最前，AI 的 bash/powershell 里 python3 直接可用。
 * 打包版：<install>/resources/runtime/python；开发版：<repo>/resources/runtime/python。
 * 必须在 app.whenReady 之前注入：pi 内核的 bash 工具子进程继承主进程 env。
 */
/** P42：预览缓存页的极简外壳（无外部依赖；内联样式在 file:// 下无 CSP 限制） */
const PREVIEW_HTML_TMPL = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui,"Segoe UI",sans-serif;max-width:860px;margin:0 auto;padding:16px 24px;color:#222;line-height:1.6}
table{border-collapse:collapse;font-size:13px;max-width:100%;display:block;overflow-x:auto}
td,th{border:1px solid #ccc;padding:4px 8px;white-space:nowrap}th{background:#f2f2f2}
h2.pv-sheet{font-size:15px;margin:18px 0 8px}hr{border:none;border-top:1px dashed #bbb;margin:20px 0}
img{max-width:100%}code{background:#f4f4f4;padding:1px 4px;border-radius:4px}pre code{display:block;padding:10px}
blockquote{border-left:3px solid #ccc;margin:0;padding-left:12px;color:#555}
</style></head><body>__BODY__</body></html>`;
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function injectPythonRuntime() {
	try {
		const rt = app.isPackaged
			? path.join(process.resourcesPath, "runtime", "python")
			: path.join(__dirname, "..", "..", "resources", "runtime", "python");
		if (!fs.existsSync(path.join(rt, "python3.exe"))) {
			console.error("[python-runtime] 未找到内置运行时，办公技能将依赖用户系统 Python");
			return null;
		}
		const sep = process.platform === "win32" ? ";" : ":";
		process.env.PATH = rt + sep + process.env.PATH;
		return rt;
	} catch (err) {
		console.error("[python-runtime] 注入失败:", err.message ?? err);
		return null;
	}
}
const PYTHON_RUNTIME = injectPythonRuntime();

function createWindow() {
	const win = new BrowserWindow({
		width: 1280,
		height: 840,
		minWidth: 900,
		minHeight: 600,
		backgroundColor: "#0d1017",
		title: "OpenPi Desktop",
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webviewTag: true, // M5：右侧实时预览面板
		},
	});
	win.setMenuBarVisibility(false);
	win.loadFile(RENDERER_FILE);
	const host = createAgentProxy(win, app.getPath("userData"), (event) => { // P43 事件钩子 + P44 settled 增量索引
		if (event?.type === "agent_settled") {
			host.agentInfo().then((info) => {
				if (info?.sessionFile) sIndex.indexFile(info.sessionFile);
			}).catch(() => {});
		}
	}); // P43：AgentHost 移入 utilityProcess 子进程，main 只转发
	try { // P41：启动时清理 45 天不活跃的任务沙箱（进行中目录 mtime 必然新，不受影响）
		const removed = cleanupExpired(sandboxRoot(host.userDataDir));
		if (removed.length) console.error(`[sandbox] 清理过期沙箱 ${removed.length} 个: ${removed.join(", ")}`);
	} catch (err) { console.error(`[sandbox] 清理失败: ${err.message ?? err}`); }
	hosts.set(win.webContents.id, host);
	win.on("closed", () => {
		host.dispose();
		hosts.delete(win.webContents.id);
	});
	return win;
}

app.whenReady().then(async () => {
	installElectronSecurity({ app, session, shell, rendererFile: RENDERER_FILE }); // P70：导航/webview/权限边界
	await ensureShellEnv(); // P40.2：PATH 保险，必须早于任何 bash/SDK 子进程
	app.setAppUserModelId("dev.openpi.desktop"); // Windows toast 通知来源标识（与 appId 一致）
	const win = createWindow();
	// P44：会话全文索引（FTS5 trigram）；引擎不可用自动降级旧扫描。启动后台同步，不阻塞
	const sIndex = new SessionIndex(process.env.OPENPI_INDEX_DB || path.join(app.getPath("userData"), "sessions-index.db"), [SESSIONS_ROOT]);
	setTimeout(() => {
		try {
			const r = sIndex.syncRoot();
			if (r.indexed) console.error(`[session-index] 启动同步 ${r.indexed} 个（剩余 ${r.remaining}）`);
		} catch (err) { console.error(`[session-index] 启动同步失败: ${err.message ?? err}`); }
	}, 4000);
	initUpdater(win); // 更新状态变化经 agent:event 通道推渲染层

	// ---- IPC: 生命周期 ----
	ipcMain.handle("agent:init", async (e) => {
		const info = await hostOf(e).init();
		return { ...info, appVersion: app.getVersion(), nodeVersion: process.versions.node };
	});
	ipcMain.handle("window:new", () => {
		createWindow();
		return true;
	});

	ipcMain.handle("agent:pick-workspace", async (e) => {
		const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
			properties: ["openDirectory", "createDirectory"],
			title: "选择工作区文件夹",
			defaultPath: DEFAULT_WORKSPACE,
		});
		if (r.canceled || r.filePaths.length === 0) return null;
		return r.filePaths[0];
	});

	ipcMain.handle("agent:start", async (e, opts = {}) => {
		let workspace = opts.workspace;
		if (workspace === null) {
			// 任务模式：不在项目中工作（无项目绑定，不落到默认工作区）
			const info = await hostOf(e).start({ ...opts, workspace: null });
			return { ...info, workspace: null, task: true };
		}
		if (!workspace) {
			fs.mkdirSync(DEFAULT_WORKSPACE, { recursive: true });
			workspace = DEFAULT_WORKSPACE;
		}
		const info = await hostOf(e).start({ ...opts, workspace });
		return { ...info, workspace };
	});

	// ---- IPC: 联网检索设置（P47，存 ~/.pi/agent/openpi-settings.json）----
	ipcMain.handle("settings:get", () => {
		try {
			return JSON.parse(fs.readFileSync(path.join(getAgentDir(), "openpi-settings.json"), "utf8"));
		} catch {
			return {};
		}
	});
	ipcMain.handle("settings:set", async (e, patch = {}) => {
		const p = path.join(getAgentDir(), "openpi-settings.json");
		let cur = {};
		try { cur = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* 首次 */ }
		const next = { ...cur, ...patch };
		fs.writeFileSync(p, JSON.stringify(next, null, 2));
		try { await hostOf(e).reloadSettings(); } catch { /* worker 未起也能存 */ }
		return { ok: true };
	});
	// ---- IPC: 对话控制 ----
	ipcMain.handle("agent:prompt", (e, text, images) => hostOf(e).prompt(String(text ?? ""), Array.isArray(images) ? images : []));
	ipcMain.handle("agent:steer", (e, text, images) => hostOf(e).steer(String(text ?? ""), Array.isArray(images) ? images : []));
	ipcMain.handle("agent:abort", (e) => hostOf(e).abort());
	ipcMain.handle("agent:approval-mode", (e, mode, goalText) => hostOf(e).setApprovalMode(String(mode ?? ""), goalText));
	ipcMain.handle("agent:approval-allowlist", (e, list) => hostOf(e).setApprovalAllowlist(list));
	ipcMain.handle("agent:get-approval-mode", (e) => hostOf(e).getApprovalMode());
	ipcMain.handle("agent:set-model", (e, { provider, id }) => hostOf(e).setModel(provider, id));
	ipcMain.handle("agent:set-thinking", (e, level) => hostOf(e).setThinking(level));
	ipcMain.handle("agent:new-session", (e, opts = {}) => hostOf(e).start(opts));
	ipcMain.handle("agent:resume", (e, sessionFile) => hostOf(e).start({ resumeFile: sessionFile }));
	ipcMain.handle("agent:info", (e) => hostOf(e).info());
	ipcMain.handle("agent:tools", (e) => hostOf(e).toolNames()); // P43：worker 内枚举（session 对象不再跨进程）

	/* ================= 技能管理（P20） ================= */
	const SKILLS_DIR = path.join(os.homedir(), ".pi", "agent", "skills");
	const SKILLS_OFF_DIR = path.join(os.homedir(), ".pi", "agent", "skills-disabled");
	const CU_INSTALLED = path.join(os.homedir(), ".pi", "agent", "extensions", "computer-use", "index.ts");

	/** 解析 SKILL.md frontmatter（name/description） */
	const parseSkillMd = (dir) => {
		const p = path.join(dir, "SKILL.md");
		if (!fs.existsSync(p)) return null;
		try {
			const m = fs.readFileSync(p, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
			if (!m) return null;
			const desc = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
			if (!desc) return null; // pi 规则：无 description 不加载
			const descZh = m[1].match(/^(?:description-zh|description_zh|描述):\s*["“]?(.+?)["”]?\s*$/m)?.[1]?.trim() || null;
			return { name: m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() || path.basename(dir), description: desc, descriptionZh: descZh, dir };
		} catch {
			return null;
		}
	};
	const scanSkillsDir = (root) => {
		if (!fs.existsSync(root)) return [];
		const out = [];
		for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
			if (ent.name.startsWith(".")) continue;
			const full = path.join(root, ent.name);
			if (ent.isDirectory()) {
				const s = parseSkillMd(full);
				if (s) out.push(s);
			} // 根级单文件 .md 技能不支持（只管理目录式技能）
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	};

	ipcMain.handle("skills:list", () => ({
		managed: scanSkillsDir(SKILLS_DIR),
		disabled: scanSkillsDir(SKILLS_OFF_DIR),
		external: scanSkillsDir(path.join(os.homedir(), ".agents", "skills")),
		cuInstalled: fs.existsSync(CU_INSTALLED),
	}));

	ipcMain.handle("skills:toggle", (_e, name, enabled) => {
		const from = path.join(enabled ? SKILLS_OFF_DIR : SKILLS_DIR, name);
		const to = path.join(enabled ? SKILLS_DIR : SKILLS_OFF_DIR, name);
		if (!fs.existsSync(from)) throw new Error("技能目录不存在: " + from);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		if (fs.existsSync(to)) throw new Error("目标已存在同名技能: " + to);
		fs.renameSync(from, to);
		return { ok: true };
	});

	ipcMain.handle("skills:delete", async (_e, name) => {
		for (const dir of [SKILLS_DIR, SKILLS_OFF_DIR]) {
			const full = path.join(dir, name);
			if (fs.existsSync(full)) {
				const ok = await shell.trashItem(full).then(() => true, () => false);
				if (ok && OFFICE_ZH[name]) {
					// 内置办公技能：记入忽略名单，重启不复活（修复按钮可重装）
					try { const d = readDismissed(); d.add(name); fs.writeFileSync(dismissFile, JSON.stringify([...d]), "utf8"); } catch { /* 非致命 */ }
				}
				return { ok };
			}
		}
		throw new Error("未找到技能: " + name);
	});

	ipcMain.handle("skills:create", (_e, name, description) => {
		if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9-]$/.test(name) && !/^[a-z0-9]$/.test(name))
			throw new Error("名称只能小写字母/数字/连字符，且不以连字符开头结尾");
		const dir = path.join(SKILLS_DIR, name);
		if (fs.existsSync(dir)) throw new Error("已存在同名技能");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${description || `${name} 技能（请编辑此描述，决定 Agent 何时使用它）`}\n---\n\n# ${name}\n\n## 何时使用\n\n（描述触发条件）\n\n## 步骤\n\n1. …\n2. …\n\n## 注意事项\n\n- 脚本可放在 scripts/ 子目录，用相对路径引用\n`,
			"utf8",
		);
		return { ok: true, dir };
	});
	/* ---- P73 第二批：项目级技能目录（workspace/.agents/skills，只读扫描展示）---- */
	// 与 skills:list 的全局目录语义分离：读不到（无 workspace）返回 { ok:false } 不报错
	ipcMain.handle("skills:projectList", (e) => {
		const ws = hostOf(e).workspace;
		if (!ws) return { ok: false, reason: "当前不在项目中" };
		const dir = path.join(ws, ".agents", "skills");
		return { ok: true, dir, exists: fs.existsSync(dir), skills: scanSkillsDir(dir) };
	});

	/* ---- P25：内置办公技能（docx/pdf/pptx/xlsx，随包分发，启动自动部署）---- */
	// 技能源自带 LICENSE（Z.ai 专有：仅限个人/教育/非商业使用），随免费安装包非商业分发，LICENSE.txt 原样保留；
	// 启动时只部署缺失的，用户删除过的记入忽略名单不复活；修复=覆盖重装
	const OFFICE_SKILLS_DIR = "resources/skills";
	const OFFICE_ZH = {
		docx: "Word 文档创建、编辑与分析：支持修订、批注、格式保留、文本提取，适合新建文档、修改内容、处理修订批注等专业 Word 任务。",
		pdf: "专业 PDF 工具集：覆盖报告排版、创意视觉、学术 LaTeX 与现有 PDF 处理四条产线，按文档类型自动路由；支持报告、海报、论文、简历、提取、合并、拆分、表单填写与格式转换。",
		pptx: "通过 pptxgenjs / python-pptx 创建和编辑 PPT 幻灯片。",
		xlsx: "电子表格一站式处理：打开、读取、编辑、修复 .xlsx/.xlsm/.csv/.tsv；从零创建表格；分析数据并输出带图表的 Excel；格式互转（CSV/JSON/PDF ⇄ XLSX）；清洗、合并、透视、变换。用户提到表格文件、「做张表/报表/模型」、Excel/CSV/数据分析/报表/汇总或要在表格里可视化时使用。",
		archive: "压缩包处理：读取/解压/创建 zip、7z、tar、tar.gz、tgz、tar.bz2、tar.xz；自动修复中文 GBK 文件名乱码；支持密码包与 zip-slip 防护；rar 只读尽力而为。用户给压缩包让处理、要「压缩/打包/归档/解压/解压到/拆包」或要从压缩包里提取文件时使用。",
		"skill-creator": "创建新技能、编辑与迭代改进现有技能：把重复工作流沉淀为可复用的 SKILL.md 能力包，优化技能描述与触发可靠性。用户想「做个技能 / 把这套流程固化下来」或要改进现有技能、技能不触发时使用。",
		viz: "数据可视化：在对话里直接渲染 ECharts 交互图表（柱/线/饼/关系图/桑基/时间线）。用户要「画个图/可视化/图表/看趋势/占比/关系图/时间线」或回复中数据用图更直观时，输出 echarts 代码块即可。",
	};
	const officeSrcRoot = () => {
		const unpacked = path.join(process.resourcesPath, "app.asar.unpacked", OFFICE_SKILLS_DIR);
		if (fs.existsSync(path.join(unpacked, "docx", "SKILL.md"))) return unpacked; // 打包后（asarUnpack）
		return path.join(app.getAppPath(), OFFICE_SKILLS_DIR); // 开发模式（项目根）
	};
	const dismissFile = path.join(SKILLS_DIR, ".office-dismissed.json");
	const readDismissed = () => { try { return new Set(JSON.parse(fs.readFileSync(dismissFile, "utf8"))); } catch { return new Set(); } };
	const injectSkillZh = (dest, zh) => {
		const p = path.join(dest, "SKILL.md");
		let md = fs.readFileSync(p, "utf8");
		const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		if (!fm) return;
		let head = fm[1];
		if (/^description-zh:/m.test(head)) head = head.replace(/^description-zh:.*$/m, `description-zh: "${zh}"`);
		else if (/^license:/m.test(head)) head = head.replace(/^license:/m, `description-zh: "${zh}"\nlicense:`);
		else head += `\ndescription-zh: "${zh}"`;
		fs.writeFileSync(p, md.replace(fm[0], `---\n${head}\n---`), "utf8");
	};
	const deployOfficeSkill = (name, { force = false } = {}) => {
		const src = path.join(officeSrcRoot(), name);
		if (!OFFICE_ZH[name] || !fs.existsSync(path.join(src, "SKILL.md"))) return false;
		const dest = path.join(SKILLS_DIR, name);
		if (!force && (fs.existsSync(dest) || readDismissed().has(name))) return false; // 已装/已忽略不覆盖
		fs.cpSync(src, dest, { recursive: true });
		injectSkillZh(dest, OFFICE_ZH[name]);
		return true;
	};
	const ensureOfficeSkills = () => {
		// P38.7：版本标记——应用升级后强制重部署一次，让 SKILL.md 更新（如去安装化）到达已装用户
		const deployVerFile = path.join(SKILLS_DIR, ".office-deploy-ver");
		const wantVer = app.getVersion();
		let needForce = false;
		try { needForce = fs.readFileSync(deployVerFile, "utf8").trim() !== wantVer; } catch { needForce = true; }
		for (const name of Object.keys(OFFICE_ZH)) {
			try { deployOfficeSkill(name, { force: needForce }); } catch (err) { console.error(`[office-skills] 部署 ${name} 失败:`, err.message); }
		}
		if (needForce) { try { fs.mkdirSync(SKILLS_DIR, { recursive: true }); fs.writeFileSync(deployVerFile, wantVer, "utf8"); } catch { /* 非致命 */ } }
	};
	ensureOfficeSkills(); // whenReady 内同步执行：~2.2MB 仅缺失时复制，毫秒级
	ipcMain.handle("skills:officeScan", () => {
		const dismissed = readDismissed();
		return {
			available: fs.existsSync(path.join(officeSrcRoot(), "docx", "SKILL.md")),
			skills: Object.entries(OFFICE_ZH).map(([name, zh]) => ({
				name, zh,
				installed: fs.existsSync(path.join(SKILLS_DIR, name)) || fs.existsSync(path.join(SKILLS_OFF_DIR, name)),
				dismissed: dismissed.has(name),
			})),
		};
	});
	ipcMain.handle("skills:officeReinstall", (_e, names) => {
		const done = [];
		for (const name of Array.isArray(names) && names.length ? names : Object.keys(OFFICE_ZH)) {
			if (!deployOfficeSkill(name, { force: true })) throw new Error("内置资源缺失: " + name);
			try { const d = readDismissed(); if (d.delete(name)) fs.writeFileSync(dismissFile, JSON.stringify([...d]), "utf8"); } catch { /* 名单清理失败不致命 */ }
			done.push(name);
		}
		return { ok: true, installed: done };
	});

	/* ================= 电脑控制（computer-use 扩展安装开关） ================= */
	ipcMain.handle("computeruse:set", (_e, enabled) => {
		const srcDir = path.join(__dirname, "..", "..", "resources", "computer-use");
		const destDir = path.dirname(CU_INSTALLED);
		if (enabled) {
			if (!fs.existsSync(path.join(srcDir, "index.ts"))) throw new Error("扩展源文件缺失: " + srcDir);
			fs.mkdirSync(destDir, { recursive: true });
			fs.cpSync(srcDir, destDir, { recursive: true });
		} else if (fs.existsSync(destDir)) {
			fs.rmSync(destDir, { recursive: true, force: true });
		}
		return { ok: true, installed: fs.existsSync(CU_INSTALLED) };
	});

	/* ================= 技能：从 GitHub 安装 ================= */
	const httpsGet = (url, headers = {}, redirects = 5) =>
		new Promise((resolve, reject) => {
			const req = https.request(url, { headers: { "User-Agent": "openpi-desktop", ...headers } }, (res) => {
				if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
					res.resume();
					return resolve(httpsGet(new URL(res.headers.location, url).href, headers, redirects - 1));
				}
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode, data: Buffer.concat(chunks) }));
				res.on("error", reject);
	
			});
			req.on("error", reject);
			req.setTimeout(60000, () => req.destroy(new Error("下载超时")));
			req.end();
		});

	ipcMain.handle("skills:install", async (_e, rawUrl) => {
		const m = String(rawUrl).trim().match(/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([^/]+)((?:\/[\w./\-]*))?)?/i);
		if (!m) throw new Error("请填 GitHub 地址，如 https://github.com/user/repo（可带 /tree/branch/subdir）");
		const [, owner, repoRaw, branchIn, sub] = m;
		const repo = repoRaw.replace(/\.git$/, "");
		let branch = branchIn;
		if (!branch) {
			try {
				const info = await httpsGet(`https://api.github.com/repos/${owner}/${repo}`);
				if (info.status === 200) branch = JSON.parse(info.data.toString("utf8")).default_branch;
			} catch { }
			branch = branch || "main";
		}
		let dl = await httpsGet(`https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`);
		if (dl.status !== 200 && !branchIn) {
			branch = "master";
			dl = await httpsGet(`https://codeload.github.com/${owner}/${repo}/zip/refs/heads/master`);
		}
		if (dl.status !== 200) throw new Error(`下载失败（HTTP ${dl.status}）：检查仓库/分支是否存在`);
		const tag = `skill-${repo}-${Date.now()}`;
		const zipPath = path.join(os.tmpdir(), tag + ".zip");
		const exDir = path.join(os.tmpdir(), tag);
		try {
			fs.writeFileSync(zipPath, dl.data);
			await new Promise((res, rej) =>
				execFile("powershell.exe", ["-NoProfile", "-Command", "Expand-Archive", "-Path", zipPath, "-DestinationPath", exDir, "-Force"], { timeout: 120000 }, (e) => (e ? rej(e) : res())),
			);
			const inner = fs.readdirSync(exDir)[0];
			const root = inner ? path.join(exDir, inner) : exDir;
			const candidates = [];
			if (fs.existsSync(path.join(root, "SKILL.md"))) candidates.push(root);
			const walk = (d, depth) => {
				if (depth > 3) return;
				for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
					if (!ent.isDirectory() || [".git", "node_modules"].includes(ent.name)) continue;
					const full = path.join(d, ent.name);
					if (fs.existsSync(path.join(full, "SKILL.md"))) candidates.push(full);
					else walk(full, depth + 1);
				}
			};
			walk(root, 1);
			let list = candidates;
			if (sub) {
				const needle = sub.toLowerCase().replace(/^\/+|\/+$/g, "");
				list = candidates.filter((c) => path.relative(root, c).toLowerCase().replace(/\\/g, "/").startsWith(needle) || path.basename(c).toLowerCase() === needle);
			}
			if (!list.length) throw new Error("仓库里没找到 SKILL.md（这不是技能仓库；技能仓库根目录或子目录需含 SKILL.md）");
			const installed = [];
			for (const c of list) {
				const s = parseSkillMd(c);
				const name = s?.name || path.basename(c);
				const dest = path.join(SKILLS_DIR, name);
				if (fs.existsSync(dest)) continue; // 同名已存在则跳过
				fs.mkdirSync(SKILLS_DIR, { recursive: true });
				fs.cpSync(c, dest, { recursive: true });
				installed.push(name);
			}
			return { ok: true, found: list.length, installed };
		} finally {
			try { fs.rmSync(zipPath, { force: true }); } catch { }
			try { fs.rmSync(exDir, { recursive: true, force: true }); } catch { }
		}
	});
	ipcMain.handle("agent:get-messages", (e) => hostOf(e).getMessages());

	// ---- IPC: M2 会话树 / 压缩 / 导出 / 改名 / 扩展UI ----
	ipcMain.handle("agent:compact", (e) => hostOf(e).compact());
	ipcMain.handle("agent:handoff", (e, opts = {}) => hostOf(e).handoff(opts ?? {}));
	ipcMain.handle("agent:tree", (e) => hostOf(e).tree());
	ipcMain.handle("agent:get-usage", (e) => hostOf(e).getUsage()); // P48 会话累计用量（含历史轮）
	ipcMain.handle("agent:set-auto-compact", (e, on) => hostOf(e).setAutoCompact(on)); // P49 自动压缩开关
	ipcMain.handle("agent:get-auto-compact", (e) => hostOf(e).getAutoCompact());
	// P51 用户 Hooks 配置
	ipcMain.handle('hooks:sample', (e) => {
		const p = path.join(getAgentDir(), 'hooks.json');
		if (!fs.existsSync(p)) {
			const checker = path.join(getAgentDir(), "verify-check.cjs");
			fs.writeFileSync(checker, "const fs=require(\"fs\"),path=require(\"path\"),cp=require(\"child_process\");\nconst p=process.argv[2];\nif(!p||!fs.existsSync(p)){process.stderr.write(\"file not found: \"+p);process.exit(1);}\nconst src=fs.readFileSync(p,\"utf8\");\nconst pj=(()=>{try{return JSON.parse(fs.readFileSync(path.join(path.dirname(p),\"package.json\"),\"utf8\"))||{}}catch{return{}}})();\nconst esm=/\\.mjs$/.test(p)||(/\\.js$/.test(p)&&pj.type===\"module\")||/\\.mts$/.test(p);\nconst r=cp.spawnSync(process.execPath,esm?[\"--input-type=module\",\"--check\"]:[\"--check\"],{input:src});\nif(r.status===0)process.exit(0);\nprocess.stderr.write(String(r.stderr||\"syntax error\"));\nprocess.exit(1);\n");
			fs.writeFileSync(p, JSON.stringify([
				{ _note: 'P58 验证硬门槛：write/edit 后自动语法检查（支持 .mjs/type:module），失败作为错误返回给 AI（强制修复，不可忽略）；也可换成项目自己的 lint/test 命令', on: ['write', 'edit'], phase: 'after', command: `node "${checker.split(path.sep).join("/")}" "{{input.path}}"`, timeoutMs: 20000, blockOnError: true },
				{ _note: '示例：write/edit 工具调用后自动记录到文件（按需修改后重启应用生效）', on: ['write', 'edit'], phase: 'after', command: 'node -e "require(\'fs\').appendFileSync(process.env.USERPROFILE + \'/Desktop/hook-log.txt\', JSON.stringify(process.argv[1]) + String.fromCharCode(10))" "{{input.path}}"', timeoutMs: 10000 },
				{ _note: '示例：bash 调用前拦截演示——命令失败即拦截（默认 blockOnError 为假，仅记日志）', on: 'bash', phase: 'before', command: 'exit 0', blockOnError: false },
			], null, 2));
		}
		return { path: p, created: true };
	});
	ipcMain.handle('hooks:open', () => { shell.showItemInFolder(path.join(getAgentDir(), 'hooks.json')); return { ok: true }; });
	ipcMain.handle("agent:navigate", (e, targetId) => hostOf(e).navigateTree(String(targetId)));
	ipcMain.handle("agent:export-html", async (e) => {
		const dl = path.join(app.getPath("downloads"), "openpi-exports");
		fs.mkdirSync(dl, { recursive: true });
		const p = path.join(dl, `openpi-${Date.now()}.html`);
		const real = await hostOf(e).exportHtml(p);
		shell.showItemInFolder(real);
		return real;
	});
	ipcMain.handle("agent:set-name", (e, name) => hostOf(e).setName(String(name ?? "")));
	ipcMain.on("agent:ui-response", (e, id, value) => hosts.get(e.sender.id)?.resolveUi(String(id), value));

	// ---- IPC: 会话列表（扫 pi 原生会话存储，全窗口共享） ----
	ipcMain.handle("sessions:list", () => listSessions());
	ipcMain.handle("sessions:meta-get", () => loadSessionMeta());
	ipcMain.handle("sessions:meta-set", (_e, id, patch) => {
		const m = loadSessionMeta();
		m[String(id)] = { ...(m[String(id)] ?? {}), ...(patch ?? {}) };
		saveSessionMeta(m);
		return m[String(id)];
	});
	ipcMain.handle("sessions:delete", async (_e, file) => {
		const p = String(file ?? "");
		if (!p.endsWith(".jsonl") || !p.includes(path.join(".pi", "agent", "sessions"))) throw new Error("非法会话路径");
		await shell.trashItem(p); // 移入系统回收站，可恢复
		return true;
	});
	// P64⑧：外部会话导入（Claude Code 起步）
	ipcMain.handle("sessions:import-scan", () => detectImportSources());
	ipcMain.handle("sessions:import-do", (_e, kind) => {
		// 索引不用手动同步：sessions:search 每次都 syncRoot，导入的会话下次搜索自动可见
		if (String(kind) === "claude-code") return importAllClaude();
		if (String(kind) === "codex") return importAllCodex(); // P69
		if (String(kind) === "opencode") return importAllOpenCode(); // P69
		throw new Error("暂不支持该来源");
	});
	ipcMain.handle("shell:open-external", (_e, url) => {
		const u = String(url ?? "");
		if (!/^https?:\/\//i.test(u)) throw new Error("仅支持 http(s) 链接");
		return shell.openExternal(u);
	});
	ipcMain.handle("shell:open-workspace-file", (e, file) => {
		const abs = resolveWorkspacePath(hostOf(e).workspace, file, { mustExist: true });
		return shell.openPath(abs);
	});
	// P74：开发者模式——渲染层开关控制本窗口 DevTools 独立窗口开/关（仅影响发起调用的窗口）
	ipcMain.handle("devtools:toggle", (e, on) => {
		const win = BrowserWindow.fromWebContents(e.sender);
		if (!win || win.isDestroyed()) return false;
		if (on) win.webContents.openDevTools({ mode: "detach" });
		else win.webContents.closeDevTools();
		return true;
	});
	// P74：信息页「应用」卡——运行时版本号（app 版本另有 update:snapshot 同源，这里补 electron/chrome）
	ipcMain.handle("app:versions", () => ({
		app: app.getVersion(),
		electron: process.versions.electron ?? "—",
		chrome: process.versions.chrome ?? "—",
		node: process.versions.node ?? "—",
	}));

	// ---- IPC: 配置中心（只写 Pi 标准文件，全窗口共享） ----
	ipcMain.handle("config:get", () => getConfig());
	ipcMain.handle("config:save-provider", (_e, id, patch) => saveProvider(String(id), patch ?? {}));
	ipcMain.handle("config:delete-provider", (_e, id) => deleteProvider(String(id)));
	ipcMain.handle("config:save-key", (_e, id, key) => saveKey(String(id), String(key)));
	ipcMain.handle("config:test", (_e, opts) => testEndpoint(opts ?? {}));
	ipcMain.handle("config:preset", (_e, key) => LOCAL_PRESETS[key] ?? null);
	ipcMain.handle("models:probe", (_e, opts) => probeModels(opts ?? {})); // P76：模型列表探测（测试连接/拉取模型/本地预设共用）
	ipcMain.handle("agent:refresh-models", (e) => hostOf(e).refreshModels());

	// ---- IPC: M3 内核版本检查 ----
	ipcMain.handle("agent:check-updates", () => checkKernelUpdate());

	// ---- IPC: git 面板（工作区内执行，不烧会话上下文） ----
	ipcMain.handle("git:status", (e) => gitCmd(hostOf(e), ["status", "--porcelain=v1", "-b"]));
	ipcMain.handle("git:diff", (e, file) => gitCmd(hostOf(e), ["diff", "HEAD", "--", String(file ?? "")]));
	ipcMain.handle("git:diff-file", (e, file, untracked) => gitDiffFile(hostOf(e), file, untracked));
	ipcMain.handle("git:diff-staged", (e, file) => gitCmd(hostOf(e), ["diff", "--cached", "--", String(file ?? "")]));
	ipcMain.handle("git:discard", async (e, file) => gitDiscard(hostOf(e), file));
	ipcMain.handle("git:commit", (e, { message }) => {
		const host = hostOf(e);
		// P34 智能提交：index 已有块级采纳的暂存内容 → 只提交 index（不 add -A，未采纳块留在 worktree）；否则维持旧行为全量提交
		let staged = false;
		try {
			execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: host.workspace, windowsHide: true, timeout: 10000 });
		} catch {
			staged = true;
		}
		return gitCmd(host, ["commit", "-m", String(message ?? "")], { add: !staged });
	});
	ipcMain.handle("git:revert-hunk", (e, file, hunkIndex) => gitRevertHunk(hostOf(e), file, hunkIndex));
	ipcMain.handle("git:stage-hunk", (e, file, hunkIndex) => gitStageHunk(hostOf(e), file, hunkIndex));
	ipcMain.handle("git:staged-info", (e) => {
		const host = hostOf(e);
		let staged = false;
		try {
			execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: host.workspace, windowsHide: true, timeout: 10000 });
		} catch {
			staged = true; // --quiet 退出非 0 = index 有内容
		}
		return { staged };
	});
	/** 写入本仓库局部 git 身份（v0.29.1：commit 遇 identity 缺失时的引导补配） */
	ipcMain.handle("git:set-identity", (e, { name, email }) => {
		const host = hostOf(e);
		if (!host.workspace) throw new Error("当前会话无工作区");
		const n = String(name ?? "").trim();
		const m = String(email ?? "").trim();
		if (!n || !m) throw new Error("姓名与邮箱都要填");
		try {
			execFileSync("git", ["config", "user.name", n], { cwd: host.workspace, windowsHide: true, timeout: 10000 });
			execFileSync("git", ["config", "user.email", m], { cwd: host.workspace, windowsHide: true, timeout: 10000 });
		} catch (err) {
			throw new Error(`写入身份失败: ${String(err.stderr ?? err.message).slice(0, 200)}`);
		}
		return { ok: true };
	});
	/* ---- P72b：会话改动审阅面板（基线=会话最新快照，无则 HEAD；非 git 仓库/无工作区返回 ok:false，渲染层显示空态不报错） ---- */
	// 审查修复：审阅 diff 的 git 调用统一关掉路径引号转义，否则中文文件名被 git 转成八进制转义串，解析/二次查询全链路坏
	const gitReview = (h, args) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: h.workspace, windowsHide: true, timeout: 15000, maxBuffer: 10 * 1024 * 1024 }).toString();
	ipcMain.handle("review:changes", (e) => {
		const host = hostOf(e);
		if (!host.workspace) return { ok: false, reason: "当前会话无工作区" };
		try {
			const base = reviewBaseline(host);
			const numstat = gitReview(host, ["diff", "--numstat", base]);
			const nameStatus = gitReview(host, ["diff", "--name-status", base]);
			const porcelain = gitReview(host, ["status", "--porcelain"]);
			return { ok: true, base, files: mergeChanges(parseNameStatus(nameStatus), parseNumstat(numstat), parsePorcelain(porcelain)) };
		} catch (err) {
			return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
		}
	});
	ipcMain.handle("review:diff", (e, file) => {
		const host = hostOf(e);
		const f = String(file ?? "").trim();
		if (!host.workspace || !f) return { ok: false, reason: "无效的文件或会话无工作区" };
		try {
			const base = reviewBaseline(host);
			let text = gitReview(host, ["diff", base, "--", f]);
			if (!text.trim()) {
				// diff 为空：未跟踪新文件（git diff 不含 ??）给占位说明，真无差异也给一句，避免空白弹窗
				const st = gitCmd(host, ["status", "--porcelain", "--", f]).trim();
				text = st.startsWith("??") ? "（新文件，未被 git 跟踪，暂无逐行 diff）\n" : "（与基线无差异）\n";
			}
			let truncated = false;
			if (text.length > 200 * 1024) {
				// >200KB 触发截断：先按行取前 500 行，仍超限再按字符硬切（审查修复：压缩单行 diff 500 行也可能几 MB）
				truncated = true;
				text = text.split("\n").slice(0, 500).join("\n");
				if (text.length > 200 * 1024) text = text.slice(0, 200 * 1024);
				text += "\n…（diff 过大，已截断显示）";
			}
		} catch (err) {
			return { ok: false, reason: String(err?.message ?? err).slice(0, 200) };
		}
	});
	ipcMain.handle("sessions:search", (e, q) => {
		// P44：FTS5 引擎优先；搜索前轻量增量同步（stat 比对，变更才重索引；顺带 prune 已删文件）
		const hit = (() => {
			try { sIndex.syncRoot(); return sIndex.search(q); } catch { return null; }
		})();
		if (hit) return hit;
		return searchSessions(q);
	});
	/** P35：# 快捷记忆——把一句话追加进工作区 AGENTS.md（不存在则创建） */
	ipcMain.handle("agents:append-memory", (e, text) => {
		const host = hostOf(e);
		if (!host.workspace) throw new Error("当前会话无工作区，无法记忆");
		const line = String(text ?? "").trim().replace(/[\r\n]+/g, " ").slice(0, 500);
		if (!line) throw new Error("记忆内容为空");
		const file = path.join(host.workspace, "AGENTS.md");
		if (!fs.existsSync(file)) fs.writeFileSync(file, "# AGENTS.md\n\n", "utf8");
		fs.appendFileSync(file, `- （${new Date().toLocaleString("zh-CN", { hour12: false })}）${line}\n`, "utf8");
		return { ok: true, file };
	});
	/** P35.1：记忆管理——列出 AGENTS.md 里的记忆条目 */
	ipcMain.handle("agents:list-memory", (e) => {
		const host = hostOf(e);
		if (!host.workspace) return [];
		const file = path.join(host.workspace, "AGENTS.md");
		if (!fs.existsSync(file)) return [];
		const items = [];
		const lines = fs.readFileSync(file, "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			const m = lines[i].match(/^- （(.+?)）(.+)$/);
			if (m) items.push({ line: i, ts: m[1], text: m[2].slice(0, 500) });
		}
		return items;
	});
	/** P35.1：删除单条记忆（按内容精确匹配整行） */
	ipcMain.handle("agents:delete-memory", (e, text) => {
		const host = hostOf(e);
		if (!host.workspace) throw new Error("当前会话无工作区");
		const file = path.join(host.workspace, "AGENTS.md");
		if (!fs.existsSync(file)) return { ok: false, removed: 0 };
		const lines = fs.readFileSync(file, "utf8").split("\n");
		const target = String(text ?? "").slice(0, 500);
		const kept = lines.filter((l) => {
			const m = l.match(/^- （(.+?)）(.+)$/);
			return !(m && m[2] === target); // 解析后内容全等才删，避免前缀误删
		});
		const removed = lines.length - kept.length;
		if (removed > 0) fs.writeFileSync(file, kept.join("\n"), "utf8");
		return { ok: true, removed };
	});
	/* ---- P73：子智能体管理（内置角色展示 + ~/.pi/agent/subagents 自定义角色 CRUD + 禁用开关）---- */
	ipcMain.handle("subagents:list", () => {
		const dir = path.join(getAgentDir(), "subagents");
		const disabled = readDisabledSubagents(); // P73：禁用清单（openpi-settings.json 的 disabledSubagents）
		const builtin = BUILTIN_SUBAGENT_META.map((r) => ({ ...r, builtin: true, disabled: disabled.includes(r.id) }));
		const customs = [];
		try {
			for (const f of fs.readdirSync(dir)) {
				if (!f.endsWith(".json")) continue;
				try {
					const def = parseSubagentJsonFile(f, fs.readFileSync(path.join(dir, f), "utf8"));
					if (def) customs.push({ ...def, file: path.join(dir, f), disabled: disabled.includes(def.id) });
				} catch { /* 单文件读失败跳过 */ }
			}
		} catch { /* 目录不存在 = 空 */ }
		return { builtin, customs, dir };
	});
	ipcMain.handle("subagents:save", (e, payload = {}) => {
		const dir = path.join(getAgentDir(), "subagents");
		const name = String(payload.name ?? "").trim();
		if (!name) throw new Error("名称必填");
		const id = sanitizeSubagentFilename(name);
		fs.mkdirSync(dir, { recursive: true });
		// 编辑时若改名（新文件名 ≠ 旧文件名），删旧文件避免留下孤儿角色
		const oldId = typeof payload.id === "string" ? sanitizeSubagentFilename(payload.id) : "";
		if (oldId && oldId !== id) { try { fs.unlinkSync(path.join(dir, `${oldId}.json`)); } catch { /* 旧文件不存在 */ } }
		// 审查修复：不同原名 sanitize 后可能同 id（如 a/b 与 a:b），落点已占用且非编辑本身时明确报错，防静默覆盖丢角色
		const target = path.join(dir, `${id}.json`);
		if (oldId !== id && fs.existsSync(target)) throw new Error(`已存在同名角色：${id}`);
		const rec = {
			name,
			desc: String(payload.desc ?? "").trim(),
			tools: Array.isArray(payload.tools) ? payload.tools.map((t) => String(t).trim()).filter(Boolean) : [],
			prefix: String(payload.prefix ?? ""),
		};
		const file = path.join(dir, `${id}.json`);
		fs.writeFileSync(file, JSON.stringify(rec, null, "\t"), "utf8");
		return { ok: true, id, file };
	});
	ipcMain.handle("subagents:delete", (e, id) => {
		const file = path.join(getAgentDir(), "subagents", `${sanitizeSubagentFilename(String(id ?? ""))}.json`);
		let removed = false;
		try { fs.unlinkSync(file); removed = true; } catch { /* 不存在 = 幂等成功 */ }
		return { ok: true, removed, file };
	});
	ipcMain.handle("subagents:toggle", (e, { id, disabled } = {}) => {
		const key = String(id ?? "").trim();
		if (!key) throw new Error("缺少角色 id");
		const p = path.join(getAgentDir(), "openpi-settings.json");
		let cur = {};
		try { cur = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* 首次 */ }
		const set = new Set(Array.isArray(cur.disabledSubagents) ? cur.disabledSubagents.map(String) : []);
		if (disabled) set.add(key); else set.delete(key);
		const next = { ...cur, disabledSubagents: [...set] };
		fs.writeFileSync(p, JSON.stringify(next, null, 2));
		return { ok: true, disabledSubagents: next.disabledSubagents };
	});
	/* ---- P73：全局指令（~/.pi/agent/AGENTS.md，优先于项目指令生效；写回前备份一次 .bak 防手抖）---- */
	ipcMain.handle("agents:global-read", () => {
		const p = path.join(getAgentDir(), "AGENTS.md");
		let text = "";
		try { text = fs.readFileSync(p, "utf8"); } catch { /* 不存在 = 空串 */ }
		return { path: p, text };
	});
	ipcMain.handle("agents:global-write", (e, text) => {
		const p = path.join(getAgentDir(), "AGENTS.md");
		fs.mkdirSync(getAgentDir(), { recursive: true });
		try { fs.copyFileSync(p, `${p}.bak`); } catch { /* 原文件不存在 = 无需备份 */ }
		fs.writeFileSync(p, String(text ?? ""), "utf8");
		return { ok: true, path: p, backup: `${p}.bak` };
	});
	ipcMain.handle("git:log", (e) => gitCmd(hostOf(e), ["log", "--oneline", "-10"]));

	/* ---- P26：系统通知 + AGENTS.md 指令文件呈现 ---- */
	ipcMain.handle("app:notify", (e, { title, body } = {}) => {
		if (!Notification.isSupported()) return { ok: false, reason: "unsupported" };
		const n = new Notification({ title: String(title || "OpenPi Desktop"), body: String(body || ""), silent: false });
		n.on("click", () => {
			const w = BrowserWindow.fromWebContents(e.sender);
			if (w) {
				if (w.isMinimized()) w.restore();
				w.show();
				w.focus();
			}
		});
		n.show();
		return { ok: true };
	});
	ipcMain.handle("ctx:agentsFiles", (e) => hostOf(e).contextFiles?.() ?? []);
	// P70：渲染层只能打开工作区/已加载指令目录内的真实路径（同时阻止符号链接逃逸）。
	const allowedUiRoots = (host) => [host.workspace, getAgentDir(), path.join(os.homedir(), ".agents")].filter(Boolean);
	ipcMain.handle("app:openPath", (e, p) => {
		const host = hostOf(e);
		return shell.openPath(resolveAllowedPath(allowedUiRoots(host), expandHome(p, app.getPath("home")), { mustExist: true, base: host.workspace || getAgentDir() }));
	});
	// P42：办公产物预览转换（docx/xlsx/md → 临时 HTML，webview 直接能看）
	ipcMain.handle("preview:convert", async (e, p) => {
		try {
			const abs = resolveWorkspacePath(hostOf(e).workspace, expandHome(p, app.getPath("home")), { mustExist: true });
			const ext = path.extname(abs).toLowerCase();
			if (!fs.existsSync(abs)) return { error: "文件不存在" };
			if (!ext) return { error: "无扩展名，无法识别类型" };
			const st = fs.statSync(abs);
			if (st.size > 10 * 1024 * 1024) return { error: `文件过大（${Math.round(st.size / 1024 / 1024)}MB > 10MB），请用系统程序打开` };
			const { createHash } = await import("node:crypto");
			const cacheDir = path.join(app.getPath("userData"), "preview-cache");
			fs.mkdirSync(cacheDir, { recursive: true });
			const cachePath = path.join(cacheDir, `${createHash("sha1").update(abs).digest("hex")}${ext}.html`);
			let html;
			if (ext === ".docx") {
				const mammoth = (await import("mammoth")).default;
				const r = await mammoth.convertToHtml({ path: abs });
				html = r.value;
			} else if (ext === ".xlsx" || ext === ".xlsm" || ext === ".csv") {
				const XLSX = (await import("xlsx")).default; // CJS interop：readFile 在 default 上
				const wb = XLSX.readFile(abs, { dense: true });
				html = wb.SheetNames.map((name) => `<h2 class="pv-sheet">${escapeHtml(name)}</h2>` + XLSX.utils.sheet_to_html(wb.Sheets[name])).join("<hr/>");
			} else if (ext === ".md" || ext === ".markdown") {
				const { marked } = await import("marked");
				html = marked.parse(fs.readFileSync(abs, "utf8").slice(0, 512 * 1024));
			} else {
				return { error: `不支持的预览类型：${ext}` };
			}
			fs.writeFileSync(cachePath, PREVIEW_HTML_TMPL.replace("__BODY__", html));
			return { path: cachePath };
		} catch (err) {
			return { error: `转换失败：${String(err?.message ?? err).slice(0, 200)}` };
		}
	});
	// P37：产物文件卡配套——资源管理器中定位 + 存在性检查（渲染层卡片灰置缺失态用）
	ipcMain.handle("app:showItemInFolder", (e, p) => {
		const abs = resolveWorkspacePath(hostOf(e).workspace, expandHome(p, app.getPath("home")), { mustExist: true });
		shell.showItemInFolder(abs);
		return true;
	});
	ipcMain.handle("app:fileStat", (e, p) => {
		try {
			const abs = resolveWorkspacePath(hostOf(e).workspace, expandHome(p, app.getPath("home")), { mustExist: true });
			const st = fs.statSync(abs);
			return { exists: true, isFile: st.isFile(), size: st.size };
		} catch {
			return { exists: false };
		}
	});

	/* ---- P28：MCP 服务器状态 ---- */
	ipcMain.handle("mcp:status", (e) => hostOf(e).mcpStatus()); // P43：经 worker（避免 main 双连接）
	ipcMain.handle("mcp:reconnect", async (e) => hostOf(e).mcpRefresh()); // P43：经 worker
	// P73：打开/创建 mcp.json——不存在时落一份对齐 Claude Desktop 格式的最小模板，再交系统默认编辑器打开
	ipcMain.handle("mcp:ensure-config", () => {
		const p = path.join(getAgentDir(), "mcp.json");
		let created = false;
		if (!fs.existsSync(p)) {
			const tpl = { mcpServers: { "example-stdio": { command: "node", args: ["server.js"], env: {} } } };
			fs.writeFileSync(p, JSON.stringify(tpl, null, "\t"), "utf8");
			created = true;
		}
		return { ok: true, path: p, created };
	});

	/* ---- P30：后台并行任务 ---- */
	ipcMain.handle("task:start", async (e, prompt) => hostOf(e).startBackground(String(prompt ?? "")));
	ipcMain.handle("task:cancel", (e, id) => hostOf(e).taskCancel(String(id ?? ""))); // P69 取消通道
	ipcMain.handle("task:list", (e) => hostOf(e).taskList());

	/* ---- P33：自动更新 ---- */
	ipcMain.handle("update:snapshot", () => getSnapshot());
	ipcMain.handle("update:check", async () => {
		try {
			const r = await checkUpdate();
			return { ok: true, version: r?.updateInfo?.version ?? null };
		} catch (err) {
			return { ok: false, error: err.friendly ? err.message : String(err.message ?? err).slice(0, 160) };
		}
	});
	ipcMain.handle("update:download", () => downloadUpdate());
	ipcMain.handle("update:install", () => {
		installUpdate();
		return true;
	});
	ipcMain.handle("update:open-config", async () => {
		const p = openUpdaterConfig();
		await shell.openPath(p);
		return true;
	});

	/* ---- P31：审计日志入口 ---- */
	ipcMain.handle("audit:open", async () => {
		const dir = path.join(os.homedir(), ".pi", "agent", "audit");
		fs.mkdirSync(dir, { recursive: true });
		await shell.openPath(dir);
		return true;
	});

	/* ---- P71：一键导出日志包（日志 + 脱敏 settings + 环境信息；绝不包含 auth.json / sessions） ---- */
	ipcMain.handle("logs:export", async (e) => {
		const now = new Date();
		const p2 = (n) => String(n).padStart(2, "0");
		const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
		const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
			title: "导出日志包",
			defaultPath: path.join(app.getPath("downloads"), `OpenPi-日志包-${stamp}.zip`),
			filters: [{ name: "Zip", extensions: ["zip"] }],
		});
		if (r.canceled || !r.filePath) return { ok: false, canceled: true };
		const entries = collectLogBundle({
			piAgentDir: AGENT_DIR,
			appInfo: { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, platform: process.platform },
		});
		// 写临时目录 → PowerShell Compress-Archive 压包 → 清理；压包失败降级为同名文件夹留在目标目录
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openpi-logs-"));
		try {
			for (const f of entries) fs.writeFileSync(path.join(tmp, f.name), f.content);
			const zip = r.filePath;
			const esc = (s) => String(s).replace(/'/g, "''"); // PowerShell 单引号转义（路径含空格/单引号安全）
			const psCmd = `Compress-Archive -Path '${esc(tmp)}\\*' -DestinationPath '${esc(zip)}' -Force`;
			const res = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psCmd], { timeout: 30000, windowsHide: true });
			if (res.status === 0 && fs.existsSync(zip)) {
				logger.log(`[logs-export] 已导出日志包: ${zip}`);
				return { ok: true, path: zip };
			}
			// 降级：压包失败 → 日志文件夹复制到用户选的目录（cpSync 兼容跨盘，rename 会 EXDEV）；
			// 同名已存在则加序号，绝不 rmSync 用户目录里的既有文件夹
			logger.error(`[logs-export] Compress-Archive 失败(status=${res.status})，降级为文件夹: ${String(res.stderr ?? "").slice(0, 300)}`);
			const base = zip.replace(/\.zip$/i, "");
			let folder = base;
			for (let i = 2; fs.existsSync(folder); i++) folder = `${base}-${i}`;
			fs.cpSync(tmp, folder, { recursive: true });
			shell.showItemInFolder(folder);
			return { ok: true, path: folder, fallback: true };
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	/* ---- P27：快照回滚 + Git 分支保护 + @ 文件列表 ---- */
	ipcMain.handle("checkpoint:list", (e) => hostOf(e).listCheckpoints?.() ?? []);
	ipcMain.handle("checkpoint:restore", (e, rel) => hostOf(e).restoreCheckpoint(String(rel ?? "")));
	ipcMain.handle("git:protect", (e) => {
		const host = hostOf(e);
		if (!host.workspace) throw new Error("当前会话无工作区");
		if (gitCmd(host, ["status", "--porcelain"]).trim()) throw new Error("工作区有未提交变更，请先提交或还原再切保护分支");
		const cur = gitCmd(host, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
		if (cur.startsWith("openpi/")) return { ok: true, branch: cur, msg: "已在保护分支上" };
		const name = `openpi/agent-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
		gitCmd(host, ["checkout", "-b", name]);
		return { ok: true, branch: name };
	});
	ipcMain.handle("git:mergeBack", (e) => {
		const host = hostOf(e);
		if (!host.workspace) throw new Error("当前会话无工作区");
		const cur = gitCmd(host, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
		if (!cur.startsWith("openpi/")) throw new Error("当前不在 openpi/* 分支上，无需合并");
		let base = "main";
		try {
			gitCmd(host, ["rev-parse", "--verify", "--quiet", "main"]);
		} catch {
			base = "master";
			try {
				gitCmd(host, ["rev-parse", "--verify", "--quiet", "master"]);
			} catch {
				throw new Error("找不到 main/master 基线分支");
			}
		}
		gitCmd(host, ["checkout", base]);
		try {
			gitCmd(host, ["merge", "--no-ff", cur, "-m", `Merge ${cur}`]);
		} catch (err) {
			throw new Error(`合并失败（可能冲突）：${String(err.message).slice(0, 200)}；可在工作区终端执行 git merge --abort 撤销`);
		}
		return { ok: true, base, branch: cur };
	});
	ipcMain.handle("files:flat", (e) => {
		const host = hostOf(e);
		if (!host.workspace) return [];
		try {
			return gitCmd(host, ["ls-files", "-co", "--exclude-standard", "-z"])
				.split("\0")
				.filter(Boolean)
				.slice(0, 800);
		} catch {
			const res = [];
			const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);
			const walk = (rel) => {
				if (res.length >= 800) return;
				let items;
				try { items = fs.readdirSync(path.join(host.workspace, rel), { withFileTypes: true }); } catch { return; }
				for (const it of items) {
					if (res.length >= 800) return;
					const r = rel ? `${rel}/${it.name}` : it.name;
					if (it.isDirectory()) {
						if (!SKIP.has(it.name)) walk(r);
					} else if (it.isFile()) res.push(r);
				}
			};
			walk("");
			return res;
		}
	});

	// ---- IPC: P1 终端（工作区内独立执行，不烧会话上下文） ----
	ipcMain.handle("term:run", (e, command) => termRun(e, String(command ?? "")));
	ipcMain.handle("term:kill", (e, id) => termKill(e, String(id ?? "")));

	// ---- IPC: P1 文件树 / 只读预览 / 文件名搜索 ----
	ipcMain.handle("fs:list", (e, relDir) => fsList(hostOf(e), relDir));
	ipcMain.handle("fs:read", (e, relFile) => fsRead(hostOf(e), relFile));
	ipcMain.handle("fs:search", (e, query) => fsSearch(hostOf(e), String(query ?? "")));

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});
});

app.on("window-all-closed", () => {
	for (const h of hosts.values()) h.dispose();
	app.quit();
});

/** git 命令辅助：在宿主工作区内执行，返回 stdout；失败抛可读错误 */
function gitCmd(host, args, opts = {}) {
	if (!host.workspace) throw new Error("当前会话无工作区");
	if (opts.add) {
		try {
			execFileSync("git", ["add", "-A"], { cwd: host.workspace, windowsHide: true, timeout: 15000 });
		} catch (err) {
			throw new Error(`git add 失败: ${String(err.stderr ?? err.message).slice(0, 300)}`);
		}
	}
	try {
		return execFileSync("git", args, { cwd: host.workspace, windowsHide: true, timeout: 15000, maxBuffer: 10 * 1024 * 1024 }).toString();
	} catch (err) {
		// git 把 "nothing to commit" 等错误输出到 stdout；stderr 为空串时也不能丢 message（?? 不回退空串）
		const msg = [err.stderr, err.stdout, err.message].map((s) => String(s ?? "").trim()).filter(Boolean).join(" | ");
		if (/不是 git 仓库|not a git repository/i.test(msg)) throw new Error("当前工作区不是 git 仓库");
		// git 身份未配置（实测踩到）：抛可识别前缀，前端弹身份表单引导补配后重试（v0.29.1）
		if (/Author identity unknown|tell me who you are|user\.useConfigOnly|no user\.name/i.test(msg)) {
			throw new Error("GIT_IDENTITY_MISSING: git 未配置用户身份");
		}
		throw new Error(`git ${args[0]} 失败: ${msg.slice(0, 300)}`);
	}
}

/** 拆分 diff 文本为 hunk 列表（@@ 起始到下一个 @@）；head 为 diff 头（---/+++ 行） */
function splitDiffHunks(diffText) {
	const lines = diffText.split("\n");
	const head = [];
	const hunks = [];
	let cur = null;
	for (const l of lines) {
		if (l.startsWith("@@")) {
			if (cur) hunks.push(cur);
			cur = [l];
		} else if (cur) cur.push(l);
		else head.push(l);
	}
	if (cur) hunks.push(cur);
	return { head, hunks };
}

/** 采纳单个 hunk：重构单 hunk patch 后 git apply --cached 暂存进 index（worktree 不动）；commit 只提交 index，未采纳块留在 worktree 可继续编辑/撤销 */
function gitStageHunk(host, file, hunkIndex) {
	// 基于 worktree vs index 的 diff（已采纳的块不再出现，序号自洽）
	const diff = gitCmd(host, ["diff", "--", String(file ?? "")]);
	const { head, hunks } = splitDiffHunks(diff);
	const i = Number(hunkIndex);
	if (!Number.isInteger(i) || i < 0 || i >= hunks.length) throw new Error(`hunk 序号越界（0..${hunks.length - 1}）`);
	const patch = [...head, ...hunks[i]].filter((l, idx, arr) => !(idx === arr.length - 1 && l === "")).join("\n") + "\n";
	try {
		execFileSync("git", ["apply", "--cached", "--whitespace=nowarn"], {
			cwd: host.workspace, windowsHide: true, timeout: 15000, input: patch,
		});
	} catch (err) {
		const msg = [err.stderr, err.stdout, err.message].map((s) => String(s ?? "").trim()).filter(Boolean).join(" | ");
		throw new Error(`采纳块失败: ${msg.slice(0, 300)}`);
	}
	return { ok: true, hunks: hunks.length };
}

/** 跨会话全文搜索：扫 sessions 目录消息内容，返回匹配会话（单文件取首条匹配，全局最多 30 条，总扫描 2s 上限） */
function searchSessions(q) {
	const needle = String(q ?? "").trim().toLowerCase();
	if (needle.length < 2 || !fs.existsSync(SESSIONS_ROOT)) return [];
	const t0 = Date.now();
	const all = [];
	for (const grp of fs.readdirSync(SESSIONS_ROOT)) {
		const gdir = path.join(SESSIONS_ROOT, grp);
		let files = [];
		try {
			files = fs.readdirSync(gdir).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const full = path.join(gdir, f);
			try {
				all.push({ full, mtime: fs.statSync(full).mtimeMs });
			} catch {
				/* 忽略 */
			}
		}
	}
	all.sort((a, b) => b.mtime - a.mtime); // 用户大概率搜最近的会话
	const out = [];
	outer: for (const { full, mtime } of all) {
		if (out.length >= 30 || Date.now() - t0 > 2000) break outer;
		let size = 0;
		try {
			size = fs.statSync(full).size;
		} catch {
			continue;
		}
		let text;
		try {
			const fd = fs.openSync(full, "r");
			const buf = Buffer.alloc(Math.min(size, 1024 * 1024)); // 单文件最多扫 1MB（足够覆盖长会话头部）
			const n = fs.readSync(fd, buf, 0, buf.length, 0);
			fs.closeSync(fd);
			text = buf.slice(0, n).toString("utf8");
		} catch {
			continue;
		}
		let head = null;
		let match = null;
		for (const line of text.split("\n")) {
			if (!line) continue;
			let e2;
			try {
				e2 = JSON.parse(line); // 每行都要 parse：session 头行不含搜索词，不能靠 needle 粗筛跳过（踩坑 #74）
			} catch {
				continue;
			}
			if (!head && e2.type === "session") {
				head = e2;
				if (match) break;
			}
			if (e2.type === "message" && e2.message?.role && !match) {
				const c = e2.message.content;
				const txt = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "";
				const at = txt.toLowerCase().indexOf(needle);
				if (at >= 0) {
					const from = Math.max(0, at - 40);
					match = (from > 0 ? "…" : "") + txt.slice(from, at + needle.length + 60) + (at + needle.length + 60 < txt.length ? "…" : "");
					if (head) break;
				}
			}
		}
		if (head && match) out.push({ file: full, id: head.id, cwd: head.cwd ?? "", mtime, preview: match, title: "" });
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

/** 撤销单个 hunk：重构只含该 hunk 的 patch，git apply -R 打回 worktree；行号偏移由 git apply 自带上下文搜索处理。基于 vs-index diff，与 UI 待处理段序号一致（P34） */
function gitRevertHunk(host, file, hunkIndex) {
	const diff = gitCmd(host, ["diff", "--", String(file ?? "")]);
	const { head, hunks } = splitDiffHunks(diff);
	const i = Number(hunkIndex);
	if (!Number.isInteger(i) || i < 0 || i >= hunks.length) throw new Error(`hunk 序号越界（0..${hunks.length - 1}）`);
	const patch = [...head, ...hunks[i]].filter((l, idx, arr) => !(idx === arr.length - 1 && l === "")).join("\n") + "\n";
	try {
		execFileSync("git", ["apply", "-R", "--whitespace=nowarn"], {
			cwd: host.workspace, windowsHide: true, timeout: 15000, input: patch,
		});
	} catch (err) {
		const msg = [err.stderr, err.stdout, err.message].map((s) => String(s ?? "").trim()).filter(Boolean).join(" | ");
		throw new Error(`撤销块失败: ${msg.slice(0, 300)}`);
	}
	return { ok: true, hunks: hunks.length };
}

/** 单文件 diff：untracked 文件生成全 "+" 行的干净伪 diff（避免 --no-index 的绝对路径转义头） */
function gitDiffFile(host, file, untracked) {
	if (!host.workspace) throw new Error("当前会话无工作区");
	const rel = String(file ?? "");
	if (!rel || rel.includes("..") || path.isAbsolute(rel)) throw new Error("非法文件路径");
	if (untracked) {
		const abs = path.join(host.workspace, rel);
		let raw;
		try { raw = fs.readFileSync(abs); } catch { return "(无法读取文件内容)"; }
		if (raw.includes(0)) return `--- /dev/null\n+++ b/${rel}\n@@ 二进制新文件，暂不显示内容 @@`;
		const lines = raw.toString("utf8").split("\n");
		if (lines[lines.length - 1] === "") lines.pop();
		const CAP = 600;
		const shown = lines.slice(0, CAP);
		const note = lines.length > CAP ? `\n…（其余 ${lines.length - CAP} 行省略）` : "";
		return `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${shown.length} 新文件 @@\n${shown.map((l) => "+" + l).join("\n")}${note}`;
	}
	return gitCmd(host, ["diff", "HEAD", "--", rel]);
}

/** P72b：会话改动审阅基线——快照链（refs/openpi/checkpoints）最新提交；无快照回退 HEAD。
 *  审查修复：原实现误调 host.listCheckpoints()（那是 P53 文件快照计数，不是提交链），恒回退 HEAD。 */
function reviewBaseline(host) {
	try {
		const id = String(lastCheckpointId(host.workspace) ?? "").trim();
		if (/^[0-9a-f]{7,40}$/i.test(id)) return id;
	} catch { /* 快照链不可用 → HEAD */ }
	return "HEAD";
}

/** 还原单文件改动：已跟踪走 checkout HEAD；未跟踪/新增移入回收站（可恢复） */
async function gitDiscard(host, file) {
	if (!host.workspace) throw new Error("当前会话无工作区");
	const rel = String(file ?? "");
	if (!rel || rel.includes("..") || path.isAbsolute(rel)) throw new Error("非法文件路径");
	try {
		execFileSync("git", ["checkout", "HEAD", "--", rel], { cwd: host.workspace, windowsHide: true, timeout: 15000 });
		// 可能已暂存，同步取消暂存
		try { execFileSync("git", ["reset", "HEAD", "--", rel], { cwd: host.workspace, windowsHide: true, timeout: 15000 }); } catch { /* 新仓库无 HEAD 时忽略 */ }
		return "reverted";
	} catch {
		// 不在 HEAD 里（新文件）：移入系统回收站，可恢复
		const abs = path.join(host.workspace, rel);
		if (!abs.startsWith(host.workspace)) throw new Error("非法文件路径");
		await shell.trashItem(abs);
		return "trashed";
	}
}

/* ================= P1：工作区终端（每命令一进程，流式回传） ================= */
const termProcs = new Map(); // "webContentsId:termId" -> ChildProcess
let termSeq = 0;

function wsJoin(host, rel) {
	const relNorm = String(rel ?? "").replace(/\\/g, "/");
	if (!relNorm || relNorm.includes("..") || path.isAbsolute(relNorm)) throw new Error("非法路径");
	const abs = path.resolve(host.workspace, relNorm);
	if (abs !== path.resolve(host.workspace) && !abs.startsWith(path.resolve(host.workspace) + path.sep)) throw new Error("非法路径");
	return abs;
}

function termRun(e, command) {
	const host = hostOf(e);
	if (!host.workspace) throw new Error("当前会话无工作区");
	if (!command.trim()) throw new Error("命令为空");
	const id = `t${++termSeq}`;
	const key = `${e.sender.id}:${id}`;
	// Windows 下强制 UTF-8 代码页，避免中文输出乱码（GBK）
	const finalCmd = process.platform === "win32" ? `chcp 65001>nul && ${command}` : command;
	const proc = spawn(finalCmd, [], { shell: true, cwd: host.workspace, windowsHide: true, env: process.env });
	termProcs.set(key, proc);
	const send = (event) => { try { e.sender.send("term:event", event); } catch { /* 窗口已关 */ } };
	proc.stdout.on("data", (d) => send({ id, type: "data", stream: "stdout", text: d.toString() }));
	proc.stderr.on("data", (d) => send({ id, type: "data", stream: "stderr", text: d.toString() }));
	proc.on("error", (err) => {
		send({ id, type: "data", stream: "stderr", text: `${String(err.message)}\n` });
		send({ id, type: "exit", code: -1 });
		termProcs.delete(key);
	});
	proc.on("close", (code) => {
		send({ id, type: "exit", code });
		termProcs.delete(key);
	});
	return id;
}

function termKill(e, id) {
	const proc = termProcs.get(`${e.sender.id}:${id}`);
	if (!proc || proc.exitCode !== null || proc.signalCode) return false;
	if (process.platform === "win32") {
		// Windows 下杀整棵进程树（shell:true 会带出子进程）
		execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => {});
	} else {
		proc.kill("SIGKILL");
	}
	return true;
}

// 窗口关闭时清理其终端进程 + 文件监听
app.on("web-contents-created", (_e, wc) => {
	wc.once("destroyed", () => {
		for (const [key, proc] of termProcs) {
			if (key.startsWith(`${wc.id}:`)) {
				try { proc.kill(); } catch { /* noop */ }
				termProcs.delete(key);
			}
		}
		const fw = fsWatchers.get(wc.id);
		if (fw) { try { fw.watcher.close(); } catch { /* noop */ } fsWatchers.delete(wc.id); }
	});
});

/* ================= P1：文件树 / 只读预览 / 文件名搜索 ================= */
const FS_IGNORE = new Set(["node_modules", ".git", "dist", "out", ".pi", ".worktrees", ".venv", "__pycache__", ".next"]);

/* ---- 工作区文件监听：Agent/终端/外部改动 → 推送 fs:changed ---- */
const fsWatchers = new Map(); // webContents.id -> { watcher, workspace, timer }

ipcMain.handle("fs:watch", (e) => {
	const host = hostOf(e);
	if (!host.workspace) throw new Error("当前会话无工作区");
	const wid = e.sender.id;
	const prev = fsWatchers.get(wid);
	if (prev && prev.workspace === host.workspace) return true; // 已在监听同一工作区
	if (prev) { try { prev.watcher.close(); } catch { /* noop */ } fsWatchers.delete(wid); }
	let timer = null;
	const watcher = fs.watch(host.workspace, { recursive: true }, (_evt, filename) => {
		const p = String(filename ?? "").replace(/\\/g, "/");
		// 忒掉 .git / node_modules 噪声，避免提交/还原触发死循环
		if (!p || p === ".git" || p.startsWith(".git/") || p.includes("/.git/") || p === "node_modules" || p.startsWith("node_modules/") || p.includes("/node_modules/")) return;
		clearTimeout(timer);
		timer = setTimeout(() => {
			try { e.sender.send("fs:changed", p); } catch { /* 窗口已关 */ }
		}, 500);
	});
	watcher.on("error", () => { /* 目录被删等场景静默 */ });
	fsWatchers.set(wid, { watcher, workspace: host.workspace });
	return true;
});

function fsList(host, relDir) {
	if (!host.workspace) throw new Error("当前会话无工作区");
	const abs = relDir ? wsJoin(host, relDir) : path.resolve(host.workspace);
	const entries = fs.readdirSync(abs, { withFileTypes: true });
	const out = [];
	for (const ent of entries) {
		if (ent.name.startsWith(".") && ent.name !== "." && FS_IGNORE.has(ent.name)) continue;
		if (FS_IGNORE.has(ent.name)) continue;
		let isDir = ent.isDirectory();
		if (ent.isSymbolicLink()) { try { isDir = fs.statSync(path.join(abs, ent.name)).isDirectory(); } catch { continue; } }
		out.push({ name: ent.name, dir: isDir });
	}
	out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
	return out.slice(0, 500);
}

function fsRead(host, relFile) {
	if (!host.workspace) throw new Error("当前会话无工作区");
	const abs = wsJoin(host, relFile);
	const st = fs.statSync(abs);
	if (st.isDirectory()) throw new Error("是文件夹，不是文件");
	const CAP = 256 * 1024;
	const fd = fs.openSync(abs, "r");
	const buf = Buffer.alloc(Math.min(st.size, CAP));
	fs.readSync(fd, buf, 0, buf.length, 0);
	fs.closeSync(fd);
	if (buf.includes(0)) return { path: relFile, binary: true, content: "", truncated: false };
	return { path: relFile, binary: false, content: buf.toString("utf8"), truncated: st.size > CAP };
}

function fsSearch(host, query) {
	if (!host.workspace) throw new Error("当前会话无工作区");
	const q = query.toLowerCase();
	if (!q) return [];
	const results = [];
	const walk = (rel, depth) => {
		if (results.length >= 50 || depth > 8) return;
		let entries;
		try { entries = fs.readdirSync(rel ? wsJoin(host, rel) : path.resolve(host.workspace), { withFileTypes: true }); } catch { return; }
		for (const ent of entries) {
			if (ent.name.startsWith(".") || FS_IGNORE.has(ent.name)) continue;
			const relPath = rel ? `${rel}/${ent.name}` : ent.name;
			if (ent.name.toLowerCase().includes(q)) results.push({ name: ent.name, path: relPath, dir: ent.isDirectory() });
			if (ent.isDirectory() && results.length < 50) walk(relPath, depth + 1);
			if (results.length >= 50) return;
		}
	};
	walk("", 0);
	return results;
}

/** M3：检查 pi 内核新版本（npm view，10s 超时） */
async function checkKernelUpdate() {
	let local = null;
	try {
		local = JSON.parse(
			fs.readFileSync(path.join(__dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
		).version;
	} catch {
		local = null;
	}
	const latest = await new Promise((resolve) => {
		const t = setTimeout(() => resolve(null), 15000);
		// Windows 下 npm 是 npm.cmd，需 shell 模式
		execFile("npm", ["view", "@earendil-works/pi-coding-agent", "version"], { timeout: 14000, windowsHide: true, shell: true }, (err, stdout) => {
			clearTimeout(t);
			resolve(err ? null : String(stdout).trim());
		});
	});
	return { local, latest, hasUpdate: latest && local ? latest !== local : null };
}

/** 扫描 pi 原生会话目录: ~/.pi/agent/sessions/<cwd-slug>/<ts>_<id>.jsonl */
function listSessions() {
	const out = [];
	if (!fs.existsSync(SESSIONS_ROOT)) return out;
	for (const grp of fs.readdirSync(SESSIONS_ROOT)) {
		const gdir = path.join(SESSIONS_ROOT, grp);
		let gst;
		try {
			gst = fs.statSync(gdir);
		} catch {
			continue;
		}
		if (!gst.isDirectory()) continue;
		for (const f of fs.readdirSync(gdir)) {
			if (!f.endsWith(".jsonl")) continue;
			const full = path.join(gdir, f);
			try {
				const st = fs.statSync(full);
				// 只读前 64KB 提取头部与首条用户消息预览
				const fd = fs.openSync(full, "r");
				const buf = Buffer.alloc(65536);
				const n = fs.readSync(fd, buf, 0, buf.length, 0);
				fs.closeSync(fd);
				const lines = buf.slice(0, n).toString("utf8").split("\n");
				const head = JSON.parse(lines[0]);
				if (head.type !== "session") continue;
				let preview = "";
				for (const line of lines) {
					if (preview || !line.trim()) continue;
					try {
						const e = JSON.parse(line);
						if (e.type === "message" && e.message?.role === "user") {
							const c = e.message.content;
							const txt = typeof c === "string"
								? c
								: (Array.isArray(c) ? c.filter((b) => b.type === "text").map((b) => b.text).join(" ") : "");
							preview = txt.replace(/\s+/g, " ").slice(0, 90);
						}
					} catch { /* 跳过坏行 */ }
				}
				out.push({ file: full, id: head.id, cwd: head.cwd ?? "", mtime: st.mtimeMs, preview });
			} catch { /* 跳过坏文件 */ }
		}
	}
	const meta = loadSessionMeta();
	for (const s of out) Object.assign(s, meta[s.id] ?? {}); // 合并置顶/自定义标题
	out.sort((a, b) => b.mtime - a.mtime);
	return out.slice(0, 120);
}

/* ---- M5：会话元数据（重命名/置顶），存自有文件不动 pi 会话 ---- */
const META_FILE = path.join(os.homedir(), ".pi", "agent", "openpi-meta.json");
function loadSessionMeta() {
	try { return JSON.parse(fs.readFileSync(META_FILE, "utf8")); } catch { return {}; }
}
function saveSessionMeta(m) {
	fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
	fs.writeFileSync(META_FILE, JSON.stringify(m, null, 2));
}
