/**
 * P52 内置浏览器控制（customTools 注入，SDK 零改动）
 *
 * 受控 Chromium 实例（Chrome/Edge 自动探测）+ CDP（chrome-remote-interface，已有依赖）驱动：
 *   - 独立 userDataDir（~/.pi/agent/browser-profile/），不碰用户日常浏览器；登录态跨会话保留
 *   - --remote-debugging-port=0 随机端口，从 stderr 解析 DevTools ws 地址
 *
 * 工具（10 个）：
 *   browser_open      打开 URL（懒启动受控浏览器）→ 返回页面快照
 *   browser_snapshot  当前页可交互元素快照（带 ref，token 高效）
 *   browser_click     按 ref 点击（写类，审批确认）
 *   browser_type      按 ref 输入（写类，审批确认；submit=true 回车提交）
 *   browser_select    按 ref 选择下拉项（写类）
 *   browser_press     按键（Enter/Esc…，写类）
 *   browser_scroll    滚轮
 *   browser_tabs      标签页 list/switch/close（switch/close 写类）
 *   browser_screenshot  截图回传（视觉兜底，model 可看）
 *   browser_wait      等待页面出现指定文本（最多 15s）
 *
 * ref 机制：快照时给元素打 data-openpi-ref 标签，操作按 ref 定位——模型无需猜坐标。
 * SPA 重渲染可能丢失标签 → 操作前检测，失效提示重新快照。
 * dialog 自动接受（含提示）；未做 file upload（诚实边界，见 SKILL/说明）。
 */
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SNAP_MAX = 12000; // 快照文本上限
const NAV_TIMEOUT = 30000;

/* ---------- 浏览器实例管理 ---------- */

const g = { proc: null, port: 0, cri: null, targetId: null, refs: new Map() }; // refs: ref -> {tag, text}

function profileDir() {
	const dir = join(homedir(), ".pi", "agent", "browser-profile");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function findBrowserExe() {
	const pf = process.env["ProgramFiles"] || "C:\\Program Files";
	const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
	const lad = process.env["LocalAppData"] || join(homedir(), "AppData", "Local");
	const candidates = [
		join(pf, "Google", "Chrome", "Application", "chrome.exe"),
		join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
		join(lad, "Google", "Chrome", "Application", "chrome.exe"),
		join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
		join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
	];
	return candidates.find((p) => existsSync(p)) || null;
}

async function launchBrowser() {
	const exe = findBrowserExe();
	if (!exe) throw new Error("未找到 Chrome/Edge，请安装其一后重试。");
	const { default: CRI } = await import("chrome-remote-interface");
	g.CRI = CRI;
	g.port = 0;
	const proc = spawn(exe, [
		"--remote-debugging-port=0",
		`--user-data-dir=${profileDir()}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate",
		"--window-size=1380,880",
		"about:blank",
	], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
	const wsUrl = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("浏览器启动超时（未收到 DevTools 地址）")), 20000);
		let buf = "";
		proc.stderr.on("data", (d) => {
			buf += d.toString();
			const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
			if (m) { clearTimeout(timer); resolve(m[1]); }
		});
		proc.once("exit", () => { clearTimeout(timer); reject(new Error("浏览器进程异常退出")); });
	});
	// 从 ws 地址提取端口（http 端点用）
	g.port = Number(new URL(wsUrl.replace("ws://", "http://")).port);
	g.proc = proc;
	proc.once("exit", () => { // 崩溃自愈：清状态，下次调用自动重启
		g.proc = null; g.cri = null; g.targetId = null; g.refs = new Map();
	});
	return g.port;
}

async function connectTo(targetId) {
	if (g.cri) { try { await g.cri.close(); } catch { /* noop */ } g.cri = null; }
	const client = await g.CRI({ port: g.port, target: targetId }); // 坐坑：target 传 id 时必须带 port，否则内部回落 9222
	const { Runtime, Page, Input, Network } = client;
	await Promise.all([Runtime.enable(), Page.enable(), Network.enable()]);
	Page.javascriptDialogOpening(async (e) => { // dialog 自动接受，不让页面卡死
		try { await Page.handleJavaScriptDialog({ accept: true }); } catch { /* noop */ }
	});
	g.cri = client;
	g.targetId = targetId;
	return client;
}

async function ensureBrowser() {
	if (!g.proc || !g.port) await launchBrowser();
	if (!g.cri) {
		const targets = await g.CRI.List({ port: g.port });
		const page = targets.find((t) => t.type === "page");
		if (!page) throw new Error("浏览器已启动但没有页面 target");
		await connectTo(page.id);
	}
	return g.cri;
}

async function newTab(url) {
	const { targetId } = await g.CRI.New({ port: g.port, url: url || "about:blank" });
	await connectTo(targetId);
	return targetId;
}

/** 导航后等待 load + 余量，返回页面标题 */
async function navAndWait(url) {
	const { Page } = g.cri;
	const evName = "Page.loadEventFired";
	const loaded = new Promise((resolve) => {
		const h = () => { g.cri.removeAllListeners(evName); resolve(); };
		g.cri.on(evName, h);
		setTimeout(() => { g.cri.removeAllListeners(evName); resolve(); }, NAV_TIMEOUT); // 超时不挂死
	});
	await Page.navigate({ url }).catch((err) => { throw new Error(`导航失败: ${err.message ?? err}`); });
	await loaded;
	await new Promise((r) => setTimeout(r, 600)); // SPA 首渲染余量
	return evaluateText("document.title");
}

/* ---------- 页面内执行 ---------- */

async function evaluateText(expr) {
	const { Runtime } = g.cri;
	const res = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true }).catch((err) => { throw new Error(`页面执行失败: ${err.message ?? err}`); });
	if (res.exceptionDetails) throw new Error(`页面脚本异常: ${res.exceptionDetails.exception?.description?.slice(0, 200) ?? "unknown"}`);
	return res.result?.value;
}

/** 快照：给交互元素打 ref，输出紧凑文本 */
async function snapshot() {
	const url = await evaluateText("location.href");
	const title = await evaluateText("document.title");
	const body = await evaluateText(`(() => {
		const MAX = ${SNAP_MAX};
		const out = [];
		const mark = (el) => {
			if (out.length > 400) return;
			let ref = el.getAttribute("data-openpi-ref");
			if (!ref) {
				ref = "e" + (Math.floor(Math.random() * 1e9)).toString(36);
				el.setAttribute("data-openpi-ref", ref);
			}
			const tag = el.tagName.toLowerCase();
			const type = tag === "input" ? (el.getAttribute("type") || "text") : (el.getAttribute("role") || "");
			const text = (tag === "input" || tag === "textarea")
				? (el.value ? "值=" + String(el.value).slice(0, 60) : (el.placeholder ? "占位=" + el.placeholder.slice(0, 40) : ""))
				: String(el.innerText || el.getAttribute("aria-label") || el.getAttribute("value") || "").trim().replace(/\\s+/g, " ").slice(0, 80);
			const extra = tag === "a" && el.getAttribute("href") ? " → " + el.getAttribute("href").slice(0, 70) : "";
			out.push("[" + ref + "] <" + tag + (type ? " type=" + type : "") + ">" + (text ? " " + text : "") + extra);
		};
		const sel = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[onclick],[contenteditable="true"]';
		for (const el of document.querySelectorAll(sel)) {
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0 && !el.disabled && el.getAttribute("aria-hidden") !== "true") mark(el);
		}
		const main = (document.querySelector("main") || document.body).innerText.replace(/\\s+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n");
		return out.join("\\n") + "\\n--- 页面文本 ---\\n" + main.slice(0, Math.max(0, MAX - out.join("\\n").length));
	})()`);
	g.refs = new Map(); // 重建 ref 索引：ref 字符串本身就是定位器（data-openpi-ref 属性），此处仅作追踪
	if (body === undefined) throw new Error("快照失败（页面可能正在跳转），请重试");
	return `页面：${title}\n地址：${url}\n\n${String(body).slice(0, SNAP_MAX + 2000)}`;
}

async function byRef(ref, action) {
	const ok = await evaluateText(`(() => {
		const el = document.querySelector('[data-openpi-ref="${String(ref).replace(/[^a-z0-9-]/gi, "")}"]');
		if (!el) return "REF_STALE";
		el.scrollIntoView({ block: "center" });
		window.__openpiTarget = el;
		return "OK";
	})()`);
	if (ok !== "OK") throw new Error(`ref「${ref}」已失效（页面变动），请重新 browser_snapshot`);
	return evaluateText(action); // 在同一页面上执行具体操作
}

/* ---------- 工具定义 ---------- */

const errText = (msg) => ({ content: [{ type: "text", text: msg }], details: { ok: false } });

const browserOpen = {
	name: "browser_open",
	label: "打开网页",
	description: "在受控浏览器（独立于你日常浏览器的沙箱实例，可保留登录态）中打开 URL 并返回可交互元素快照。首次调用会自动启动浏览器（Chrome/Edge）。读类操作。",
	parameters: Type.Object({
		url: Type.String({ description: "要打开的完整 URL（http/https）" }),
		newTab: Type.Optional(Type.Boolean({ description: "是否新开标签页（默认复用当前标签页）" })),
	}),
	async execute(_id, params) {
		try {
			await ensureBrowser();
			if (params.newTab || !g.cri) await newTab(/^https?:\/\//.test(params.url) ? params.url : "https://" + params.url);
			else await navAndWait(/^https?:\/\//.test(params.url) ? params.url : "https://" + params.url);
			return { content: [{ type: "text", text: await snapshot() }], details: { ok: true } };
		} catch (err) { return errText(`browser_open 失败：${err.message ?? err}`); }
	},
};

const browserSnapshot = {
	name: "browser_snapshot",
	label: "页面快照",
	description: "获取当前页面的可交互元素清单（带 [ref] 标记，供 browser_click/browser_type 定位）+ 页面正文文本。只读操作。",
	parameters: Type.Object({}),
	async execute() {
		try {
			await ensureBrowser();
			return { content: [{ type: "text", text: await snapshot() }], details: { ok: true } };
		} catch (err) { return errText(`browser_snapshot 失败：${err.message ?? err}`); }
	},
};

const browserClick = {
	name: "browser_click",
	label: "点击页面元素",
	description: "按快照里的 [ref] 点击页面元素（按钮/链接/勾选框）。写类操作。",
	parameters: Type.Object({ ref: Type.String({ description: "快照中的元素 ref，如 e3f2a" }) }),
	async execute(_id, { ref }) {
		try {
			await ensureBrowser();
			const info = await byRef(ref, "(() => { const el = window.__openpiTarget; el.click(); return el.tagName.toLowerCase(); })()");
			await new Promise((r) => setTimeout(r, 500));
			return { content: [{ type: "text", text: `已点击 <${info}>。${await snapshot()}` }], details: { ok: true } };
		} catch (err) { return errText(`browser_click 失败：${err.message ?? err}`); }
	},
};

const browserType = {
	name: "browser_type",
	label: "输入文本",
	description: "按 [ref] 向输入框/文本域输入文本。submit=true 时输入后按回车提交。写类操作。",
	parameters: Type.Object({
		ref: Type.String({ description: "快照中的元素 ref" }),
		text: Type.String({ description: "要输入的文本（会先清空原内容）" }),
		submit: Type.Optional(Type.Boolean({ description: "输入后是否回车提交" })),
	}),
	async execute(_id, { ref, text, submit }) {
		try {
			await ensureBrowser();
			const tag = await byRef(ref, `(() => {
				const el = window.__openpiTarget;
				el.focus();
				if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) {
					if (el.select) el.select();
					document.execCommand("selectAll", false, null);
					document.execCommand("insertText", false, ${JSON.stringify(String(text))});
					if (!el.isContentEditable && el.value !== ${JSON.stringify(String(text))}) { // execCommand 未生效（如 date/file）
						el.value = ${JSON.stringify(String(text))};
						el.dispatchEvent(new Event("input", { bubbles: true }));
					}
				}
				return el.tagName.toLowerCase();
			})()`);
			if (submit) await keyPress("Enter");
			return { content: [{ type: "text", text: `已在 <${tag}> 输入 ${submit ? "并回车提交" : ""}：${String(text).slice(0, 50)}${submit ? "\n" + await snapshot() : ""}` }], details: { ok: true } };
		} catch (err) { return errText(`browser_type 失败：${err.message ?? err}`); }
	},
};

const browserSelect = {
	name: "browser_select",
	label: "选择下拉项",
	description: "按 [ref] 选择 <select> 下拉框的选项（按选项文本或 value 匹配）。写类操作。",
	parameters: Type.Object({
		ref: Type.String({ description: "快照中的元素 ref" }),
		value: Type.String({ description: "选项文本或 value" }),
	}),
	async execute(_id, { ref, value }) {
		try {
			await ensureBrowser();
			const picked = await byRef(ref, `(() => {
				const el = window.__openpiTarget;
				if (el.tagName !== "SELECT") return "NOT_SELECT";
				const v = ${JSON.stringify(String(value))};
				let opt = [...el.options].find((o) => o.value === v || o.text.trim() === v || o.text.includes(v));
				if (!opt) return "NO_OPTION:" + [...el.options].map((o) => o.text.trim()).join(" | ").slice(0, 200);
				el.value = opt.value;
				el.dispatchEvent(new Event("input", { bubbles: true }));
				el.dispatchEvent(new Event("change", { bubbles: true }));
				return opt.text.trim();
			})()`);
			if (picked === "NOT_SELECT") return errText("该元素不是下拉框，请重新快照确认");
			if (String(picked).startsWith("NO_OPTION:")) return errText(`没有匹配选项「${value}」，现有：${picked.slice(9)}`);
			return { content: [{ type: "text", text: `已选择：${picked}` }], details: { ok: true } };
		} catch (err) { return errText(`browser_select 失败：${err.message ?? err}`); }
	},
};

async function keyPress(key) {
	const { Input } = g.cri;
	const map = { Enter: "\r", Tab: "\t" };
	const code = { Enter: "Enter", Escape: "Escape", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };
	const kd = code[key] || key;
	await Input.dispatchKeyEvent({ type: "rawKeyDown", key: kd, windowsVirtualKeyCode: kd.length === 1 ? kd.toUpperCase().charCodeAt(0) : 13 });
	if (map[key]) await Input.dispatchKeyEvent({ type: "char", text: map[key], key, windowsVirtualKeyCode: 13 });
	await Input.dispatchKeyEvent({ type: "keyUp", key: kd, windowsVirtualKeyCode: kd.length === 1 ? kd.toUpperCase().charCodeAt(0) : 13 });
}

const browserPress = {
	name: "browser_press",
	label: "按键",
	description: "向当前聚焦元素发送按键（Enter/Escape/Tab/ArrowUp…）。写类操作。",
	parameters: Type.Object({ key: Type.String({ description: "键名：Enter、Escape、Tab、Backspace、ArrowDown 等" }) }),
	async execute(_id, { key }) {
		try {
			await ensureBrowser();
			await keyPress(String(key));
			await new Promise((r) => setTimeout(r, 400));
			return { content: [{ type: "text", text: `已按键 ${key}。${await snapshot()}` }], details: { ok: true } };
		} catch (err) { return errText(`browser_press 失败：${err.message ?? err}`); }
	},
};

const browserScroll = {
	name: "browser_scroll",
	label: "滚动页面",
	description: "滚动当前页面。direction: up/down，amount 为滚轮格数（默认 5）。只读操作。",
	parameters: Type.Object({
		direction: Type.Optional(Type.String({ description: "up 或 down（默认 down）" })),
		amount: Type.Optional(Type.Number({ description: "滚轮格数，默认 5" })),
	}),
	async execute(_id, { direction = "down", amount = 5 }) {
		try {
			await ensureBrowser();
			const { Input } = g.cri;
			for (let i = 0; i < Math.min(Number(amount) || 5, 30); i++) {
				await Input.dispatchMouseEvent({ type: "mouseWheel", x: 690, y: 440, deltaX: 0, deltaY: direction === "up" ? -120 : 120 });
			}
			await new Promise((r) => setTimeout(r, 300));
			return { content: [{ type: "text", text: `已向${direction === "up" ? "上" : "下"}滚动 ${amount} 格。需要内容请 browser_snapshot。` }], details: { ok: true } };
		} catch (err) { return errText(`browser_scroll 失败：${err.message ?? err}`); }
	},
};

const browserTabs = {
	name: "browser_tabs",
	label: "管理标签页",
	description: "管理受控浏览器的标签页：list（列出，只读）/ switch（切换）/ close（关闭）。switch 和 close 是写类操作。",
	parameters: Type.Object({
		action: Type.String({ description: "list / switch / close" }),
		index: Type.Optional(Type.Number({ description: "switch/close 的目标标签页序号（从 list 输出获得，0 起）" })),
	}),
	async execute(_id, { action, index }) {
		try {
			await ensureBrowser();
			const targets = (await g.CRI.List({ port: g.port })).filter((t) => t.type === "page");
			if (action === "list" || index === undefined) {
				const cur = targets.findIndex((t) => t.id === g.targetId);
				return { content: [{ type: "text", text: targets.map((t, i) => `${i === cur ? "→" : " "}[${i}] ${t.title.slice(0, 40)} ${t.url.slice(0, 80)}`).join("\n") }], details: { ok: true } };
			}
			const t = targets[Number(index)];
			if (!t) return errText(`标签页 [${index}] 不存在（共 ${targets.length} 个）`);
			if (action === "switch") {
				await connectTo(t.id);
				return { content: [{ type: "text", text: `已切换到 [${index}] ${t.title.slice(0, 40)}。${await snapshot()}` }], details: { ok: true } };
			}
			if (action === "close") {
				await g.CRI.Close({ port: g.port, id: t.id });
				if (t.id === g.targetId) {
					g.cri = null; g.targetId = null;
					await ensureBrowser(); // 回连剩余页面
				}
				return { content: [{ type: "text", text: `已关闭标签页 [${index}]` }], details: { ok: true } };
			}
			return errText(`未知 action：${action}（list/switch/close）`);
		} catch (err) { return errText(`browser_tabs 失败：${err.message ?? err}`); }
	},
};

const browserScreenshot = {
	name: "browser_screenshot",
	label: "页面截图",
	description: "截取当前页面为图片回传（模型可直接看）。用于布局类问题、快照看不清的验证码/图形元素。只读操作。",
	parameters: Type.Object({}),
	async execute() {
		try {
			await ensureBrowser();
			const { Page } = g.cri;
			const shot = await Page.captureScreenshot({ format: "jpeg", quality: 62 });
			if (!shot?.data) return errText("截图失败（页面可能不允许）");
			return { content: [{ type: "image", data: shot.data, mimeType: "image/jpeg" }], details: { ok: true } };
		} catch (err) { return errText(`browser_screenshot 失败：${err.message ?? err}`); }
	},
};

const browserWait = {
	name: "browser_wait",
	label: "等待页面内容",
	description: "等待页面文本出现指定内容（如加载结果），最多 15 秒。只读操作。",
	parameters: Type.Object({
		text: Type.String({ description: "等待出现的文本片段" }),
	}),
	async execute(_id, { text }) {
		try {
			await ensureBrowser();
			const needle = JSON.stringify(String(text));
			const start = Date.now();
			while (Date.now() - start < 15000) {
				const hit = await evaluateText(`document.body.innerText.includes(${needle})`);
				if (hit) return { content: [{ type: "text", text: `已出现「${String(text).slice(0, 40)}」（等待 ${Math.round((Date.now() - start) / 1000)}s）。${await snapshot()}` }], details: { ok: true } };
				await new Promise((r) => setTimeout(r, 600));
			}
			return errText(`15s 内未出现「${String(text).slice(0, 40)}」。可 browser_snapshot 看当前页面实际内容`);
		} catch (err) { return errText(`browser_wait 失败：${err.message ?? err}`); }
	},
};

export const browserTools = [
	browserOpen, browserSnapshot, browserClick, browserType, browserSelect,
	browserPress, browserScroll, browserTabs, browserScreenshot, browserWait,
];

/** 审批分类（agent-host approvalExtension 用）：写类浏览器工具 */
export const BROWSER_WRITE = new Set(["browser_click", "browser_type", "browser_select", "browser_press", "browser_tabs"]);
