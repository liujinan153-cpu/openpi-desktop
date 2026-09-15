/**
 * P60 电脑控制 daemon 化：常驻 PowerShell 进程（stdin JSON 指令行协议），单次操作 ~100ms，
 * 取代 P56 的每次冷启动（1~2s）。进程崩溃自动重启并重试一次。
 *
 * 工具集（对齐官方 computer-use 扩展命名，消除双套工具混淆；agent-host 侧过滤全局扩展）：
 * - 只读：computer_windows / computer_screenshot / computer_elements / computer_read / computer_wait / computer_apps
 * - 写类（走审批）：computer_click / computer_drag / computer_type / computer_key / computer_scroll
 *   / computer_clipboard / computer_focus / computer_activate（focus 的兼容别名）/ computer_launch
 * - 安全：全量审计 ~/.pi/agent/computer-audit.log；子代理不带本组工具
 * - 反撒谎：click 返回实际命中窗口/控件；type 返回文字实际落点；read 可程序化回读焦点控件
 */
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const g = globalThis;

const PS1 = (() => {
	try {
		const packed = join(process.resourcesPath ?? "", "computer-daemon.ps1"); // 打包态：extraResources
		if (packed && existsSync(packed)) return packed;
	} catch { /* 普通 node 环境 */ }
	return join(dirname(fileURLToPath(import.meta.url)), "computer-daemon.ps1"); // dev 态
})();

const OKR = (text, details = {}) => ({ content: [{ type: "text", text }], details: { ok: true, ...details } });
const BADR = (text) => ({ content: [{ type: "text", text }], details: { ok: false } });

/** 审计日志（谁在何时动了电脑，全量落盘） */
function audit(op, args) {
	try {
		const dir = join(homedir(), ".pi", "agent");
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "computer-audit.log"), `${new Date().toISOString()} ${op} ${JSON.stringify(args).slice(0, 200)}\n`);
	} catch { /* 日志失败不阻断 */ }
}

/* ---------- 常驻 daemon 客户端 ---------- */

function cuDaemon() {
	if (g.__cuProc && g.__cuProc.stdin && g.__cuProc.stdin.writable) return g.__cuProc;
	const proc = spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", PS1],
		{ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
	);
	proc.stdout.setEncoding("utf8");
	let buf = "";
	proc.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 1);
			if (!line.startsWith("@R@")) continue;
			try {
				const r = JSON.parse(line.slice(3));
				const p = g.__cuPending?.get(r.id);
				if (p) {
					g.__cuPending.delete(r.id);
					clearTimeout(p.timer);
					r.ok ? p.res(r.data) : p.rej(new Error(String(r.data)));
				}
			} catch { /* 忽略坏行 */ }
		}
	});
	proc.stderr.on("data", () => {});
	proc.on("exit", () => {
		g.__cuProc = null;
		for (const p of (g.__cuPending ?? new Map()).values()) {
			clearTimeout(p.timer);
			p.rej(new Error("电脑控制进程退出"));
		}
		g.__cuPending = new Map();
	});
	g.__cuProc = proc;
	g.__cuPending = new Map();
	return proc;
}

let cuSeq = 0;
function cuCall(op, params = {}, timeout = 15000) {
	const proc = cuDaemon();
	const id = ++cuSeq;
	audit(`daemon_${op}`, params);
	return new Promise((res, rej) => {
		const timer = setTimeout(() => {
			g.__cuPending?.delete(id);
			// 超时后杀掉 daemon 重建，防止半死状态（如 UIA 对自绘应用阻塞）拖垮后续操作
			try { proc.kill(); } catch { /* 已退出 */ }
			g.__cuProc = null;
			rej(new Error(`电脑操作 ${op} 超时（${timeout}ms）——若目标是无障碍树缺失的自绘应用（如 Blender/游戏），请改用 computer_screenshot + 坐标方案`));
		}, timeout);
		g.__cuPending.set(id, { res, rej, timer });
		try {
			proc.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
		} catch (e) {
			clearTimeout(timer);
			g.__cuPending.delete(id);
			rej(e);
		}
	});
}

/** 重试一次（daemon 崩溃自动重建） */
async function cuCall2(op, params = {}, timeout = 15000) {
	try {
		return await cuCall(op, params, timeout);
	} catch (e) {
		if (String(e.message).includes("进程退出")) return cuCall(op, params, timeout);
		throw e;
	}
}

function parseKey(combo) {
	const VK = {
		backspace: 8, tab: 9, enter: 13, return: 13, shift: 16, ctrl: 17, control: 17, alt: 18, menu: 18,
		pause: 19, capslock: 20, esc: 27, escape: 27, space: 32, pageup: 33, pagedown: 34, end: 35,
		home: 36, left: 37, up: 38, right: 39, down: 40, insert: 45, delete: 46, del: 46,
		win: 0x5b, lwin: 0x5b, rwin: 0x5c, apps: 0x5d,
	};
	for (let i = 1; i <= 24; i++) VK["f" + i] = 0x70 + i - 1;
	const parts = String(combo).trim().toLowerCase().split("+").map((s) => s.trim()).filter(Boolean);
	if (!parts.length) throw new Error("空按键");
	return parts.map((p) => {
		if (VK[p] !== undefined) return VK[p];
		if (/^[a-z0-9]$/.test(p)) return p.charCodeAt(0) - 32;
		if (/^numpad[0-9]$/.test(p)) return 0x60 + Number(p.slice(6));
		throw new Error(`未知按键: ${p}（支持 enter/esc/tab/方向键/f1-f24/ctrl/alt/shift/win/字母数字）`);
	});
}

/** OpenPi 自己窗口的 pid/进程名（反误伤：文字粘到自己窗口视为失败）。注意不能匹配 "electron"——dev 怂下任何 electron 应用都叫 electron */
function isOwnTarget(pid, name) {
	if (pid === process.pid) return true;
	const n = String(name ?? "").toLowerCase();
	return n.includes("openpi");
}

export const computerTools = [
	{
		name: "computer_windows",
		label: "窗口列表",
		description: "列出当前所有有窗口的进程（pid / 进程名 / 窗口标题）。操作任何窗口前先用它定位目标。",
		parameters: Type.Object({}),
		async execute() {
			const r = await cuCall2("wins");
			const lines = (Array.isArray(r) ? r : [r]).map((w) => `pid=${w.pid}  ${w.name}  「${w.title}」`);
			return OKR(lines.join("\n") || "（无可见窗口）");
		},
	},
	{
		name: "computer_screenshot",
		label: "截取屏幕",
		description:
			"截取屏幕保存为图片并返回文件路径——再用 read 工具读取该路径即可看到画面。默认全屏（多显示器合并虚拟屏），可用 x/y/width/height 截指定区域。先截图看屏幕，再决定点击坐标；操作后截图验证结果。out 必须是绝对路径。",
		parameters: Type.Object({
			out: Type.Optional(Type.String({ description: "图片保存绝对路径；省略则存临时目录" })),
			x: Type.Optional(Type.Integer({ description: "区域左上角 X（全屏省略）" })),
			y: Type.Optional(Type.Integer({ description: "区域左上角 Y" })),
			width: Type.Optional(Type.Integer({ description: "区域宽" })),
			height: Type.Optional(Type.Integer({ description: "区域高" })),
		}),
		async execute(_id, params = {}) {
			// P60 坐坑：相对路径会落到进程 cwd（安装目录）——强制绝对路径；daemon 输出 JPEG，默认 .jpg
			const out = params.out && isAbsolute(params.out) ? params.out : join(tmpdir(), `computer-${Date.now()}.jpg`);
			const info = await cuCall2("shot", { path: out, x: params.x ?? null, y: params.y ?? null, w: params.width ?? 0, h: params.height ?? 0, maxw: 0 }, 25000);
			const size = existsSync(out) ? statSync(out).size : 0;
			return OKR(`已截图：${out}（${info.w}x${info.h}，${Math.round(size / 1024)}KB）。用 read 工具读取该路径查看画面。`, { path: out, w: info.w, h: info.h });
		},
	},
	{
		name: "computer_elements",
		label: "界面元素",
		description:
			"枚举目标窗口的 UI 自动化元素（按钮/输入框/菜单/链接等），返回类型、名称与中心点精确坐标。这是精准定位的首选方式：先 computer_focus 聚焦目标窗口（或传 pid），再用本工具拿元素坐标，然后 computer_click 点元素中心——比从截图猜像素坐标精准得多。最多返回 200 个元素。注意：自绘 UI 应用（Blender/游戏/部分 Electron）可能返回空——此时降级为截图+坐标方案。",
		parameters: Type.Object({
			pid: Type.Optional(Type.Integer({ description: "目标进程 pid（computer_windows 查看）；省略=当前前台窗口" })),
		}),
		async execute(_id, params = {}) {
			const r = await cuCall2("elements", params.pid ? { pid: params.pid } : {}, 30000);
			const lines = (r.elements ?? []).map((e) => `#${e.i} ${e.type}${e.enabled ? "" : " [禁用]"}「${e.name}」 @ (${e.x},${e.y}) ${e.w}x${e.h}`);
			const head = `窗口「${r.window?.name ?? "?"}」（${r.window?.type ?? "?"}）共 ${r.total} 元素，返回 ${r.count}：`;
			return OKR(head + "\n" + (lines.join("\n") || "（无匹配元素）"), { count: r.count });
		},
	},
	{
		name: "computer_read",
		label: "读取焦点控件",
		description:
			"读取当前焦点控件里的文本（输入框/编辑器/文档内容）。输入后的程序化验证首选——比截图更可靠：computer_type 之后读本工具确认文字真的进了目标控件，防止假报成功。部分自绘控件（如游戏画面）不支持读取，此时改用 computer_screenshot。",
		parameters: Type.Object({}),
		async execute() {
			const r = await cuCall2("readfocus");
			return OKR(`${r.type}「${r.name}」内容：\n${r.text || "（空）"}`);
		},
	},
	{
		name: "computer_wait",
		label: "等待",
		description: "等待毫秒数（≤10000），等程序启动/加载后再继续。",
		parameters: Type.Object({ ms: Type.Integer() }),
		async execute(_id, params = {}) {
			const ms = Math.min(Math.max(params.ms ?? 500, 0), 10000);
			await new Promise((r) => setTimeout(r, ms));
			return OKR(`waited ${ms}ms`);
		},
	},
	{
		name: "computer_apps",
		label: "搜索应用",
		description: "按名称搜索本机已安装应用（开始菜单全量：桌面程序 + UWP）。启动应用前先搜索，拿到 id 后用 computer_launch 启动——不许凭想象拿替代品顶替。",
		parameters: Type.Object({ q: Type.String({ description: "应用名关键字" }) }),
		async execute(_id, params = {}) {
			const list = await cuCall2("apps", { q: params.q ?? "" });
			const lines = (list ?? []).map((a) => `${a.name}  →  id=${a.id}`);
			return OKR(lines.join("\n") || "（无匹配应用）");
		},
	},
	{
		name: "computer_click",
		label: "鼠标点击",
		description:
			"移动鼠标到屏幕坐标 (x, y) 并点击。button: left（默认）/ right / middle；double: true 双击。点击前先截图确认坐标；更精准的方式：先 computer_elements 拿目标控件的精确中心坐标再点。返回实际命中的窗口与控件（target/elType）——若不是你期望的目标，说明点偏了，必须重新定位，不得假装成功。",
		parameters: Type.Object({
			x: Type.Integer(),
			y: Type.Integer(),
			button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")])),
			double: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params = {}) {
			const r = await cuCall2("click", params);
			const d = typeof r === "object" ? r : { msg: String(r) };
			return OKR(`${d.msg}（命中：${d.target ?? "未知"}${d.title ? `「${d.title}」` : ""}${d.elType ? ` · ${d.elType}${d.elName ? `「${d.elName}」` : ""}` : ""}）`, { hit: d });
		},
	},
	{
		name: "computer_drag",
		label: "鼠标拖拽",
		description: "按住左键从 (x1,y1) 平滑拖到 (x2,y2) 再松开。用于拖文件、滑块、选中文本等。",
		parameters: Type.Object({ x1: Type.Integer(), y1: Type.Integer(), x2: Type.Integer(), y2: Type.Integer() }),
		async execute(_id, params = {}) {
			const r = await cuCall2("drag", params, 20000);
			return OKR(String(r));
		},
	},
	{
		name: "computer_type",
		label: "键入文字",
		description:
			"向指定窗口输入文字（支持中文等任意 Unicode）。用法：先 computer_windows 找到目标进程 pid，把 pid 传进来（强烈建议）——会先聚焦并验证，聚焦失败则直接报错、不会盲目输入。实现：写剪贴板 → Ctrl+V（会覆盖剪贴板）。返回实际接收输入的窗口进程。铁律：输入后必须 computer_read 或 computer_screenshot 验证文字真的出现，未验证不得告诉用户已完成。",
		parameters: Type.Object({
			text: Type.String(),
			pid: Type.Optional(Type.Integer({ description: "目标进程 pid（computer_windows 查看）；强烈建议提供，聚焦失败会直接报错而不是盲输入" })),
		}),
		async execute(_id, params = {}) {
			if (params.pid !== undefined) {
				const f = await cuCall2("focus", { pid: params.pid });
				if (!f.verified) {
					return BADR(`聚焦目标窗口失败（Windows 前台锁或窗口已关闭），本次未输入任何文字。请用 computer_screenshot 确认目标窗口状态后重试。`);
				}
				await new Promise((r) => setTimeout(r, 250)); // 焦点稳定
			}
			const r = await cuCall2("paste", { text: params.text }, 20000);
			if (isOwnTarget(r.targetPid, r.target)) {
				return BADR(`文字被粘贴到了 OpenPi 自己的窗口（不是目标应用），视为失败。请先用 computer_windows + computer_focus(pid) 聚焦目标窗口再输入。`);
			}
			return OKR(`已向「${r.target ?? "未知"}」(${r.title ?? ""}) 粘贴 ${r.pasted} 字符（焦点控件：${r.feType ?? "?"}${r.feName ? `「${r.feName}」` : ""}）。必须 computer_read 或 computer_screenshot 验证文字真的出现，未验证不得宣称成功。`, { targetPid: r.targetPid });
		},
	},
	{
		name: "computer_key",
		label: "按组合键",
		description:
			"向当前焦点窗口发送按键。格式：单键（enter/esc/tab/up/down/left/right/delete/home/end/f5/a/1…）或组合（ctrl+c / alt+F4 / ctrl+shift+t / win）。",
		parameters: Type.Object({ key: Type.String() }),
		async execute(_id, params = {}) {
			const vks = parseKey(params.key);
			await cuCall2("key", { vks });
			return OKR(`pressed ${params.key}`);
		},
	},
	{
		name: "computer_scroll",
		label: "滚轮滚动",
		description: "在坐标 (x,y) 处滚动滚轮，amount 正=上/负=下（格数）。省略坐标则在当前位置滚。",
		parameters: Type.Object({
			amount: Type.Integer(),
			x: Type.Optional(Type.Integer()),
			y: Type.Optional(Type.Integer()),
		}),
		async execute(_id, params = {}) {
			const r = await cuCall2("scroll", params);
			return OKR(String(r));
		},
	},
	{
		name: "computer_clipboard",
		label: "剪贴板",
		description: "读写系统剪贴板文本。action: get（读取）/ set（写入 text）。打字前可先 set 备份原内容。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
			text: Type.Optional(Type.String()),
		}),
		async execute(_id, params = {}) {
			const r = await cuCall2(params.action === "get" ? "clip_get" : "clip_set", { text: params.text ?? "" }, 10000);
			return OKR(params.action === "get" ? `剪贴板内容：\n${String(r) || "（空）"}` : "已写入剪贴板");
		},
	},
	{
		name: "computer_focus",
		label: "置前窗口",
		description:
			"把指定 pid 的窗口切换到前台并验证聚焦成功（返回 verified 字段）。打字/点击目标窗口前务必先聚焦；verified=false 时绝不能继续输入，否则文字会落到别的窗口。",
		parameters: Type.Object({ pid: Type.Integer({ description: "目标进程 pid（computer_windows 查看）" }) }),
		async execute(_id, params = {}) {
			const r = await cuCall2("focus", { pid: params.pid });
			const fe = r.verified && r.feType ? `（焦点控件：${r.feType}${r.feName ? `「${r.feName}」` : ""}）` : "";
			return OKR(`聚焦「${r.name}」(${r.title ?? ""})：${r.verified ? "✓ 已验证前台" : "✗ 失败（未成为前台窗口，禁止继续输入/点击）"}${fe}`, { verified: r.verified });
		},
	},
	{
		name: "computer_activate",
		label: "激活窗口",
		description: "把指定 pid 的窗口切到前台（computer_focus 的兼容别名，行为一致）。pid 从 computer_windows 获取。",
		parameters: Type.Object({ pid: Type.Integer({ description: "目标进程 pid" }) }),
		async execute(_id, params = {}) {
			const r = await cuCall2("focus", { pid: params.pid });
			const fe = r.verified && r.feType ? `（焦点控件：${r.feType}${r.feName ? `「${r.feName}」` : ""}）` : "";
			return OKR(`聚焦「${r.name}」(${r.title ?? ""})：${r.verified ? "✓ 已验证前台" : "✗ 失败"}${fe}`, { verified: r.verified });
		},
	},
	{
		name: "computer_launch",
		label: "启动应用",
		description: "按 id 启动本机应用（id 来自 computer_apps 搜索）。启动后等待几秒再用 computer_windows 确认窗口出现。",
		parameters: Type.Object({ id: Type.String({ description: "应用 id（computer_apps 返回）" }) }),
		async execute(_id, params = {}) {
			const r = await cuCall2("launch", { id: params.id });
			return OKR(String(r));
		},
	},
];
