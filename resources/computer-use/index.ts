/**
 * computer-use — OpenPi Desktop 内置「电脑控制」扩展（Windows）
 *
 * 工具：截图（回传给模型看）/ 界面元素（UIA 精准定位）/ 读取焦点控件 / 点击 / 拖拽 / 打字（含中文）/ 组合键 / 滚轮 / 剪贴板 / 窗口管理 / 等待。
 * 架构：常驻 PowerShell daemon（daemon.ps1）—— 首次工具调用时拉起，之后每次操作 ~100ms，
 * 避免每次冷启动 PowerShell+Add-Type 的 1~2s 开销。进程崩溃自动重启并重试一次。
 */
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const g = globalThis;

/* ---------- 常驻 daemon 客户端 ---------- */

function cuDaemon() {
	if (g.__cuProc && g.__cuProc.stdin && g.__cuProc.stdin.writable) return g.__cuProc;
	const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "daemon.ps1");
	const proc = spawn(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
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
	g.__cuPending = g.__cuPending ?? new Map();
	return proc;
}

/** 调用 daemon；失败/超时自动重启进程并重试一次 */
function cuCall(op, params, timeout = 20000, retries = 1) {
	const id = (g.__cuId = (g.__cuId || 0) + 1);
	const proc = cuDaemon();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			g.__cuPending.delete(id);
			reject(new Error(`${op} 超时（${timeout}ms）`));
		}, timeout);
		g.__cuPending.set(id, { res: resolve, rej: reject, timer });
		try {
			proc.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
		} catch (e) {
			clearTimeout(timer);
			g.__cuPending.delete(id);
			reject(e);
		}
	}).catch(async (e) => {
		if (retries > 0) {
			try { g.__cuProc?.kill(); } catch { }
			g.__cuProc = null;
			await new Promise((r) => setTimeout(r, 300));
			return cuCall(op, params, timeout, 0);
		}
		throw e;
	});
}

/** "ctrl+shift+t" → [0x11,0x10,0x54] */
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

export default function computerUse(pi) {
	pi.registerTool({
		name: "computer_screenshot",
		label: "屏幕截图",
		description:
			"截取屏幕返回图片供你查看。默认全屏（多显示器合并虚拟屏），可用 x/y/width/height 截指定区域。先截图看屏幕，再决定点击坐标；操作后截图验证结果。",
		promptSnippet: "Capture the screen (or a region) as an image you can see",
		promptGuidelines: [
			"Use computer_screenshot before and after computer_click / computer_type / computer_key to see the screen and verify results.",
			"Before typing or clicking into a window, use computer_windows to find it and computer_focus it first.",
		],
		parameters: Type.Object({
			x: Type.Optional(Type.Integer({ description: "区域左上角 X（全屏省略）" })),
			y: Type.Optional(Type.Integer({ description: "区域左上角 Y" })),
			width: Type.Optional(Type.Integer({ description: "区域宽" })),
			height: Type.Optional(Type.Integer({ description: "区域高" })),
		}),
		async execute(_id, params) {
			const dir = mkdtempSync(join(tmpdir(), "cu-shot-"));
			const file = join(dir, "shot.jpg");
			try {
				const info = await cuCall("shot", { path: file, x: params.x ?? null, y: params.y ?? null, w: params.width ?? 0, h: params.height ?? 0, maxw: 1600 }, 25000);
				const b64 = readFileSync(file).toString("base64");
				return {
					content: [
						{ type: "image", source: { type: "base64", mediaType: "image/jpeg", data: b64 } },
						{ type: "text", text: `截图 ${info.w}x${info.h}（已缩放至宽≤1600）` },
					],
					details: {},
				};
			} finally {
				try { rmSync(dir, { recursive: true, force: true }); } catch { }
			}
		},
	});

	pi.registerTool({
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
		async execute(_id, params) {
			const r = await cuCall("click", params, 15000);
			const d = typeof r === "object" ? r : { msg: String(r) };
			return { content: [{ type: "text", text: `${d.msg}（命中：${d.target ?? "未知"}${d.title ? `「${d.title}」` : ""}${d.elType ? ` · ${d.elType}${d.elName ? `「${d.elName}」` : ""}` : ""}）` }], details: {} };
		},
	});

	pi.registerTool({
		name: "computer_drag",
		label: "鼠标拖拽",
		description: "按住左键从 (x1,y1) 平滑拖到 (x2,y2) 再松开。用于拖文件、滑块、选中文本等。",
		parameters: Type.Object({
			x1: Type.Integer(),
			y1: Type.Integer(),
			x2: Type.Integer(),
			y2: Type.Integer(),
		}),
		async execute(_id, params) {
			const r = await cuCall("drag", params, 20000);
			return { content: [{ type: "text", text: String(r) }], details: {} };
		},
	});

	pi.registerTool({
		name: "computer_type",
		label: "键入文字",
		description:
			"向指定窗口输入文字（支持中文等任意 Unicode）。用法：先 computer_windows 找到目标进程 pid，把 pid 传进来（强烈建议）——会先聚焦并验证，聚焦失败则直接报错、不会盲目输入。实现：写剪贴板 → Ctrl+V（会覆盖剪贴板）。返回实际接收输入的窗口进程。铁律：输入后必须 computer_screenshot 验证文字真的出现，未验证不得告诉用户已完成。",
		promptGuidelines: [
			"After computer_type / computer_key, ALWAYS take a computer_screenshot to VERIFY the text actually appeared in the target window before claiming success. Never claim success without visual verification.",
		],
		parameters: Type.Object({
			text: Type.String(),
			pid: Type.Optional(Type.Integer({ description: "目标进程 pid（computer_windows 查看）；强烈建议提供，聚焦失败会直接报错而不是盲输入" })),
		}),
		async execute(_id, params) {
			if (params.pid !== undefined) {
				const f = await cuCall("focus", { pid: params.pid }, 15000);
				if (!f.verified) {
					throw new Error(`聚焦目标窗口失败（Windows 前台锁或窗口已关闭），本次未输入任何文字。请用 computer_screenshot 确认目标窗口状态后重试。`);
				}
				await new Promise((r) => setTimeout(r, 250)); // 焦点稳定
			}
			const r = await cuCall("paste", { text: params.text }, 20000);
			if (r.targetPid === process.pid) {
				throw new Error(`文字被粘贴到了 OpenPi 自己的窗口（不是目标应用），视为失败。请先用 computer_windows + computer_focus(pid) 聚焦目标窗口再输入。`);
			}
			return {
				content: [{ type: "text", text: `已向「${r.target ?? "未知"}」(${r.title ?? ""}) 粘贴 ${r.pasted} 字符（焦点控件：${r.feType ?? "?"}${r.feName ? `「${r.feName}」` : ""}）。必须 computer_screenshot 验证文字真的出现，未验证不得宣称成功。` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "computer_key",
		label: "按组合键",
		description:
			"向当前焦点窗口发送按键。格式：单键（enter/esc/tab/up/down/left/right/delete/home/end/f5/a/1…）或组合（ctrl+c / alt+F4 / ctrl+shift+t / win）。",
		parameters: Type.Object({
			key: Type.String(),
		}),
		async execute(_id, params) {
			const vks = parseKey(params.key);
			await cuCall("key", { vks }, 15000);
			return { content: [{ type: "text", text: `pressed ${params.key}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "computer_scroll",
		label: "滚轮滚动",
		description: "在坐标 (x,y) 处滚动滚轮，amount 正=上/负=下（格数）。省略坐标则在当前位置滚。",
		parameters: Type.Object({
			amount: Type.Integer(),
			x: Type.Optional(Type.Integer()),
			y: Type.Optional(Type.Integer()),
		}),
		async execute(_id, params) {
			const r = await cuCall("scroll", params, 15000);
			return { content: [{ type: "text", text: String(r) }], details: {} };
		},
	});

	pi.registerTool({
		name: "computer_clipboard",
		label: "剪贴板",
		description: "读写系统剪贴板文本。action: get（读取）/ set（写入 text）。打字前可先 set 备份原内容。",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("get"), Type.Literal("set")]),
			text: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			const r = await cuCall(params.action === "get" ? "clip_get" : "clip_set", { text: params.text ?? "" }, 10000);
			return {
				content: [{ type: "text", text: params.action === "get" ? `剪贴板内容：\n${String(r) || "（空）"}` : "已写入剪贴板" }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "computer_windows",
		label: "窗口列表",
		description: "列出当前所有有窗口的进程（pid / 进程名 / 窗口标题）。配合 computer_focus 使用。",
		parameters: Type.Object({}),
		async execute() {
			const r = await cuCall("wins", {}, 15000);
			const lines = (Array.isArray(r) ? r : [r]).map((w) => `pid=${w.pid}  ${w.name}  「${w.title}」`);
			return { content: [{ type: "text", text: lines.join("\n") || "（无可见窗口）" }], details: {} };
		},
	});

	pi.registerTool({
		name: "computer_elements",
		label: "界面元素",
		description:
			"枚举目标窗口的 UI 自动化元素（按钮/输入框/菜单/链接等），返回类型、名称与中心点精确坐标。这是精准定位的首选方式：先 computer_focus 聚焦目标窗口（或传 pid），再用本工具拿元素坐标，然后 computer_click 点元素中心——比从截图猜像素坐标精准得多。最多返回 200 个元素。",
		promptGuidelines: [
			"Prefer computer_elements over guessing pixel coordinates: focus the target window, list its elements, then computer_click the element's exact center.",
		],
		parameters: Type.Object({
			pid: Type.Optional(Type.Integer({ description: "目标进程 pid（computer_windows 查看）；省略=当前前台窗口" })),
		}),
		async execute(_id, params) {
			const r = await cuCall("elements", params.pid ? { pid: params.pid } : {}, 30000);
			const lines = (r.elements ?? []).map((e) => `#${e.i} ${e.type}${e.enabled ? "" : " [禁用]"}「${e.name}」 @ (${e.x},${e.y}) ${e.w}x${e.h}`);
			const head = `窗口「${r.window?.name ?? "?"}」（${r.window?.type ?? "?"}）共 ${r.total} 元素，返回 ${r.count}：`;
			return { content: [{ type: "text", text: head + "\n" + (lines.join("\n") || "（无匹配元素）") }], details: {} };
		},
	});

	pi.registerTool({
		name: "computer_read",
		label: "读取焦点控件",
		description:
			"读取当前焦点控件里的文本（输入框/编辑器/文档内容）。输入后的程序化验证首选——比截图更可靠：computer_type 之后读本工具确认文字真的进了目标控件，防止假报成功。部分自绘控件（如游戏画面）不支持读取，此时改用 computer_screenshot。",
		promptGuidelines: [
			"After computer_type, use computer_read to programmatically verify the text landed in the target control (falls back to computer_screenshot for controls that don't support text reading).",
		],
		parameters: Type.Object({}),
		async execute() {
			const r = await cuCall("readfocus", {}, 15000);
			return { content: [{ type: "text", text: `${r.type}「${r.name}」内容：\n${r.text || "（空）"}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "computer_focus",
		label: "置前窗口",
		description:
			"把指定 pid 的窗口切换到前台并验证聚焦成功（返回 verified 字段）。打字/点击目标窗口前务必先聚焦；verified=false 时绝不能继续输入，否则文字会落到别的窗口。",
		promptGuidelines: [
			"Always computer_focus the target window before computer_type / computer_key; only proceed if verified is true.",
		],
		parameters: Type.Object({
			pid: Type.Integer({ description: "目标进程 pid（computer_windows 查看）" }),
		}),
		async execute(_id, params) {
			const r = await cuCall("focus", { pid: params.pid }, 15000);
			const fe = r.verified && r.feType ? `（焦点控件：${r.feType}${r.feName ? `「${r.feName}」` : ""}）` : "";
			return { content: [{ type: "text", text: `聚焦「${r.name}」(${r.title ?? ""})：${r.verified ? "✓ 已验证前台" : "✗ 失败（未成为前台窗口，禁止继续输入/点击）"}${fe}` }], details: {} };
		},
	});

	pi.registerTool({
		name: "computer_wait",
		label: "等待",
		description: "等待毫秒数（≤10000），等程序启动/加载后再继续。",
		parameters: Type.Object({
			ms: Type.Integer(),
		}),
		async execute(_id, params) {
			const ms = Math.min(Math.max(params.ms ?? 500, 0), 10000);
			await new Promise((r) => setTimeout(r, ms));
			return { content: [{ type: "text", text: `waited ${ms}ms` }], details: {} };
		},
	});
}
