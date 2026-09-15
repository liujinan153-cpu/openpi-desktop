// 全量 E2E 回归调度器 —— 打包前的硬门槛
// 用法：node scripts/e2e-all.mjs [--only p30,p31]（过滤调试用）
// 约定：每套独立启动干净实例（9333）→ 跑脚本 → 杀进程；FAIL 自动重试一次，仍失败才算失败
// 纳入标准：只回归当前功能体系的代表套件；旧里程碑一次性脚本不纳入（README 有全套功能清单）
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// npm run dist 用系统 node（v16，无全局 fetch）→ 检测到旧 node 时用本机 node-lts 重入（踩坑 #79）
const SELF = fileURLToPath(import.meta.url);
if (Number(process.versions.node.split(".")[0]) < 20) {
	const lts = path.join(process.env.LOCALAPPDATA ?? "", "node-lts", "node-v22.14.0-win-x64", "node.exe");
	if (fs.existsSync(lts)) {
		const r = spawnSync(lts, [SELF, ...process.argv.slice(2)], { stdio: "inherit" });
		process.exit(r.status ?? 1);
	}
	console.error(`node < 20 且未找到 node-lts（${lts}），无法运行全量回归`);
	process.exit(2);
}

// 兼容 node16（npm run dist 用系统 node 跑本脚本）：import.meta.dirname 需 20.11+
const ROOT = path.resolve(path.dirname(SELF), "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const NODE = process.execPath; // 调度器自己跑在 node-lts 上，同版本跑套件
const PORT = 9333;

// ── 套件清单（轻 → 重；before 钩子按需准备外部夹具） ──
const SUITES = [
	{ file: "e2e-p31.mjs", label: "打磨：任务隔离+审计入口", ver: "0.26.1" },
	{ file: "e2e-p26.mjs", label: "AGENTS.md 呈现+审核 dock+通知", ver: "0.22.0" },
	{ file: "e2e-p29.mjs", label: "full-auto 护栏+审计日志", ver: "0.25.0" },
	{ file: "e2e-p33.mjs", label: "自动更新器+diff块级撤销", ver: "0.28.0" },
	{ file: "e2e-p34.mjs", label: "块级采纳+跨会话搜索", ver: "0.29.0" },
	{ file: "e2e-p35.mjs", label: "Todo清单+计划模式+快捷记忆", ver: "0.30.0" },
	{ file: "e2e-p36.mjs", label: "办公技能安装即用(内置Python)", ver: "0.32.0" },
	{ file: "e2e-p37.mjs", label: "产物文件卡+贴图视觉提示+办公产物规范", ver: "0.33.0" },
	{ file: "e2e-archive.mjs", label: "压缩包技能archive", ver: "0.34.0" },
	{ file: "e2e-p385-vision.mjs", label: "视觉链路修复(贴图400)", ver: "0.34.0" },
	{ file: "e2e-p39.mjs", label: "Cursor取经三件套(改动卡/允许清单/重试)", ver: "0.34.5" },
	{ file: "e2e-p40.mjs", label: "快赢批(KaTeX/复制按钮/PATH保险)", ver: "0.35.0" },
	{ file: "e2e-p41.mjs", label: "沙箱工作区+办公产物预览", ver: "0.36.0" },
	{ file: "e2e-p43.mjs", label: "Agent独立进程(utilityProcess)", ver: "0.37.0" },
	{ file: "e2e-p44.mjs", label: "SQLite FTS5会话索引", ver: "0.37.0" },
	{ file: "e2e-p45.mjs", label: "聊天内ECharts可视化", ver: "0.38.0" },
	{ file: "e2e-p47.mjs", label: "联网检索+用量面板", ver: "0.40.0" },
	{ file: "e2e-p49.mjs", label: "子代理+Hooks+自动压缩开关", ver: "0.41.0" },
	{ file: "e2e-p52.mjs", label: "内置浏览器控制", ver: "0.42.0" },
	{ file: "e2e-p53.mjs", label: "git 检查点", ver: "0.43.0" },
	{ file: "e2e-p54.mjs", label: "验证闭环", ver: "0.44.0" },
	{ file: "e2e-p55.mjs", label: "项目记忆", ver: "0.44.0" },
	{ file: "e2e-p27.mjs", label: "checkpoint 回滚+@补全", ver: "0.23.0" },
	{ file: "e2e-office-skills.mjs", label: "内置办公技能", ver: "0.21.0" },
	{
		file: "e2e-p28.mjs", label: "MCP 桥", ver: "0.24.0",
		before() { // 确保夹具配置存在（保留用户其他 server 条目）
			const mcpPath = path.join(os.homedir(), ".pi", "agent", "mcp.json");
			let cfg = {};
			try { cfg = JSON.parse(fs.readFileSync(mcpPath, "utf8")); } catch { /* 首次 */ }
			cfg.mcpServers = cfg.mcpServers ?? {};
			cfg.mcpServers.echo = {
				command: process.execPath, // 调度器的 node（node-lts）
				args: [path.join(ROOT, "scripts", "fixtures", "mcp-echo-server.mjs")],
			};
			fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
			fs.writeFileSync(mcpPath, JSON.stringify(cfg, null, 2));
		},
	},
	{ file: "e2e-handoff.mjs", label: "上下文自动接力", ver: "0.20.0" },
	{ file: "e2e-p30.mjs", label: "后台并行任务", ver: "0.26.0" },
];

const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx > -1 ? process.argv[onlyIdx + 1].split(",") : null;
const suites = only ? SUITES.filter((s) => only.some((o) => s.file.includes(o))) : SUITES;
if (!suites.length) { console.error("--only 无匹配套件"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killElectron = () => { // 只杀 9333 占用者，不误伤系统里其他 Electron 应用
	const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout ?? "";
	const pids = new Set(
		out.split("\n").filter((l) => l.includes(`:${PORT}`) && l.includes("LISTENING"))
			.map((l) => l.trim().split(/\s+/).at(-1)).filter((p) => /^\d+$/.test(p)),
	);
	for (const pid of pids) spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
};
const waitReady = async (timeoutMs = 60000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
			if (r.ok) return true;
		} catch { /* 未就绪 */ }
		await sleep(1000);
	}
	return false;
};
const startApp = async () => {
	killElectron();
	await sleep(800);
	const { ELECTRON_RUN_AS_NODE, ...cleanEnv } = process.env;
	const child = spawn(ELECTRON, [ROOT, `--remote-debugging-port=${PORT}`], {
		cwd: ROOT, env: cleanEnv, detached: true, stdio: "ignore",
	}).unref();
	if (!(await waitReady())) throw new Error("应用 60s 未就绪（CDP 端口）");
	await sleep(3000); // 渲染层稳定
};
const runSuite = (suite, timeoutMs = 8 * 60_000) => new Promise((resolve) => {
	const t0 = Date.now();
	const child = spawn(NODE, [path.join(ROOT, "scripts", suite.file)], { cwd: ROOT, env: process.env });
	let out = "";
	const timer = setTimeout(() => { child.kill(); resolve({ timeout: true }); }, timeoutMs);
	child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
	child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
	child.on("close", (code) => {
		clearTimeout(timer);
		const passes = (out.match(/^PASS /gm) ?? []).length;
		const fails = (out.match(/^FAIL /gm) ?? []).length;
		resolve({ code, passes, fails, dur: Date.now() - t0, timeout: false });
	});
});

console.log(`\n═══ 全量 E2E 回归（${suites.length} 套，每套独立干净实例，FAIL 自动重试 1 次）═══\n`);
const results = [];
for (const suite of suites) {
	console.log(`\n──── [${suite.file}] ${suite.label}（${suite.ver}）────`);
	let r = { code: 999, passes: 0, fails: 99, dur: 0, timeout: false };
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			suite.before?.();
			await startApp();
			r = await runSuite(suite);
		} catch (err) {
			console.error(`启动失败：${String(err).slice(0, 200)}`);
			r = { code: 999, passes: 0, fails: 99, dur: 0, timeout: false, bootFail: true };
		}
		if ((r.code === 0 && r.fails === 0) || attempt === 2) break;
		console.log(`\n⚠ 首跑未过，自动重试（${attempt}/1）…\n`);
	}
	results.push({ ...suite, ...r, retry: r.code !== 0 ? "（重试后）" : "" });
	killElectron();
	await sleep(500);
}

// ── 汇总表 ──
console.log("\n═══ 回归汇总 ═══");
console.log("结果   套件                    断言    用时   功能");
let bad = 0;
for (const r of results) {
	const okFlag = r.code === 0 && r.fails === 0 && !r.bootFail;
	if (!okFlag) bad++;
	const stat = r.timeout ? "超时" : r.bootFail ? "起不来" : okFlag ? "✅" : "❌";
	console.log(
		`${stat.padEnd(5)}  ${r.file.padEnd(22)}  ${String(`${r.passes}过${r.fails}败`).padEnd(8)}  ${(r.dur / 1000).toFixed(0).padStart(4)}s   ${r.label}${r.retry}`,
	);
}
console.log(bad ? `\n❌ ${bad}/${results.length} 套失败 —— 禁止打包，先修回归` : `\n✅ 全部 ${results.length} 套通过 —— 可以打包`);
process.exit(bad ? 1 : 0);
