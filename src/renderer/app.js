/* OpenPi Desktop M1 —— 渲染进程：Pi 事件 → UI
 * 新增：Markdown 渲染 / Diff 视图 / 会话侧栏（恢复+历史回放）
 */
const $ = (id) => document.getElementById(id);
const chat = $("chat");
const input = $("input");
const btnSend = $("btn-send");
const btnWorkspace = $("btn-workspace");
const btnSidebar = $("btn-sidebar");
const sidebar = $("sidebar");
const sessionList = $("session-list");
const sessionFilter = $("session-filter");
const modelSelect = $("model-select");
const thinkingSelect = $("thinking-select");
const statusLeft = $("status-left");
const usageEl = $("usage");
const queueBadge = $("queue-badge");
const workspaceLabel = $("workspace-label");

const state = {
	models: [],
	session: null, // { sessionId, sessionFile, model, workspace }
	streaming: false,
	cur: null, // 当前助手消息缓冲 { root, bodyEl, cursor, text, thinkingEl, thinkingText }
	tools: new Map(), // toolCallId -> { card, outEl, out, st }
	queue: { steering: 0, followUp: 0 },
	usageTotal: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	sessions: [],
	collapsed: new Set(), // 侧栏折叠的项目 cwd
	sideTab: "projects", // 侧栏 tab：projects | flat
	meta: {}, // 会话元数据 { [sessionId]: { title?, pinned? } }
	previewUrl: null, // 当前预览地址（服务/生成物/手动输入）
	previewUrls: [], // 预览历史 chips
	images: [], // 待发送图片 [{ data: base64, mimeType }]
	ctx: null, // 上下文占用 { pct, used, win }（updateCtxBar 维护）
	handoffBusy: false, // 上下文接力进行中（防重入）
};

/* ================= Markdown ================= */
marked.setOptions({ breaks: true, gfm: true });
function renderMarkdown(text) {
	const html = DOMPurify.sanitize(marked.parse(text), {
		ADD_ATTR: ["class"],
		FORBID_TAGS: ["style", "form", "iframe"],
	});
	return html;
}
/* P46：Lucide 图标——动态 DOM 插入后重扫（静态页启动时已扫）；lucide 缺失时静默 */
function refreshIcons() {
	try { window.lucide?.createIcons(); } catch { /* 图标失败不影响功能 */ }
}
function highlightIn(el) {
	echartsRender(el); // P45：先替换 ```echarts 块（替换后的图表不再高亮/复制）
	el.querySelectorAll("pre code").forEach((c) => {
		try { hljs.highlightElement(c); } catch { /* 未知语言忽略 */ }
	});
	mathRender(el); // P40：KaTeX 公式渲染（需 index.html 引 vendor/katex）
	codeCopy(el); // P40：代码块复制按钮
	refreshIcons(); // P46：动态消息内容里的图标
}
/* P40：KaTeX 数学公式（$行内 / $$块级 / \(..\) \[..\]），渲染失败降级为原文 */
function mathRender(el) {
	try {
		window.renderMathInElement?.(el, {
			delimiters: [
				{ left: "$$", right: "$$", display: true },
				{ left: "\\[", right: "\\]", display: true },
				{ left: "\\(", right: "\\)", display: false },
				{ left: "$", right: "$", display: false },
			],
			throwOnError: false,
		});
	} catch { /* 渲染失败保留原文 */ }
}
/* P45：ECharts 可视化——```echarts 代码块（JSON option）→ 交互图表；解析/渲染失败降级为原代码块。
 * 宽度不足（隐藏 tab）时不动，下次 highlightIn 重试。 */
const liveCharts = [];
window.addEventListener("resize", () => { for (const c of liveCharts) { try { c.resize(); } catch { /* 已销毁 */ } } });
function echartsRender(el) {
	if (!window.echarts) return;
	el.querySelectorAll('pre code[class*="language-echarts"]').forEach((code) => {
		const pre = code.closest("pre");
		if (!pre || pre.dataset.echartsDone) return;
		let opt;
		try {
			opt = JSON.parse(code.textContent.replace(/\/\/[^\n"]*$/gm, "").replace(/,(\s*[\]}])/g, "$1")); // 容忍行注释与尾逗号
		} catch { return; } // 非法 JSON 保留原码
		if (!opt || typeof opt !== "object" || !opt.series) return; // 缺 series 视为误触发
		if (pre.offsetWidth < 80) return; // 容器不可见，不替换（下次 highlightIn 重试）
		pre.dataset.echartsDone = "1"; // 幂等：确认替换后才置位（失败/隐藏可重试）
		const box = document.createElement("div");
		box.className = "echarts-box";
		pre.replaceWith(box);
		try {
			const chart = window.echarts.init(box, null, { renderer: "canvas" });
			chart.setOption(opt);
			liveCharts.push(chart);
			if (liveCharts.length > 60) liveCharts.splice(0, liveCharts.length - 60); // 防无限增长
		} catch {
			box.textContent = "⚠ 图表渲染失败";
		}
	});
}

/* P40：代码块右上角「复制」按钮（事件委托，全 chat 一个 listener） */
let codeCopyBound = false;
function codeCopy(el) {
	el.querySelectorAll("pre").forEach((pre) => {
		if (pre.querySelector(".code-copy")) return;
		const btn = document.createElement("button");
		btn.className = "code-copy";
		btn.type = "button";
		btn.textContent = "复制";
		pre.style.position = "relative";
		pre.appendChild(btn);
	});
	if (codeCopyBound) return;
	codeCopyBound = true;
	chat.addEventListener("click", async (e) => {
		const btn = e.target.closest(".code-copy");
		if (!btn) return;
		const code = btn.closest("pre")?.querySelector("code")?.textContent ?? "";
		try { await navigator.clipboard.writeText(code); btn.textContent = "已复制"; }
		catch { btn.textContent = "失败"; }
		setTimeout(() => { btn.textContent = "复制"; }, 1500);
	});
}

/* ================= P37：产物文件卡 =================
 * AI 消息里的文件路径（含 z:code-file-citation 私有标记兑底）渲染成可点击卡片：
 * 左键 = 系统默认程序打开；右键 = 打开/资源管理器定位/复制路径。
 */
const FCARD_EXTS = "docx|doc|xlsx|xlsm|xls|csv|tsv|pptx|ppt|pdf|md|markdown|txt|zip|json";
const FCARD_CITE_RE = /:{0,2}z:?code-file-citation\s*\{[^}]*?path\s*=\s*"([^"]+)"[^}]*\}/gi; // ZCode 私有标记（glm 系训练痕迹；实际见过 ::zcode-file-citation 与 z:code-file-citation 两种）
const FCARD_PATH_RE = new RegExp(
	"(?:[A-Za-z]:[\\\\/]|~[/\\\\]|\\\\\\\\[^\\\\/]+[/\\\\])[^\\s\"'`<>{}（）【】]*?\\.(?:" + FCARD_EXTS + ")",
	"gi",
);
const FCARD_KIND = {
	docx: ["W", "Word", "#2b579a"], doc: ["W", "Word", "#2b579a"],
	xlsx: ["X", "Excel", "#217346"], xlsm: ["X", "Excel", "#217346"], xls: ["X", "Excel", "#217346"],
	csv: ["X", "表格", "#217346"], tsv: ["X", "表格", "#217346"],
	pptx: ["P", "PPT", "#d24726"], ppt: ["P", "PPT", "#d24726"],
	pdf: ["F", "PDF", "#c8102e"],
	md: ["M", "MD", "#6c5ce7"], markdown: ["M", "MD", "#6c5ce7"],
	txt: ["T", "TXT", "#64748b"], zip: ["Z", "ZIP", "#8a6d3b"], json: ["{}", "JSON", "#8a6d3b"],
};

function fcardRelPath(abs) {
	const ws = state.session?.workspace;
	if (!ws) return null;
	const norm = (p) => String(p).replace(/[\\\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
	const nWs = norm(ws), nAbs = norm(abs);
	if (!nAbs.startsWith(nWs + "/")) return null;
	return String(abs).replace(/[\\\\/]+/g, "/").slice(ws.replace(/[\\\\/]+/g, "/").replace(/\/$/, "").length + 1);
}

function fcardOpen(abs) {
	window.openpi.openPath(abs).catch(() => addSysLine(`✗ 打开失败：${abs}`, true));
}

function fileCardEl(absPath) {
	const name = String(absPath).split(/[\\\\/]/).pop() || String(absPath);
	const ext = (name.includes(".") ? name.split(".").pop() : "").toLowerCase();
	const [ic, tag, color] = FCARD_KIND[ext] ?? ["F", "FILE", "#64748b"];
	const el = document.createElement("span");
	el.className = "fcard";
	const icon = document.createElement("span");
	icon.className = "fcard-ic";
	icon.style.background = color;
	icon.textContent = ic;
	const nm = document.createElement("span");
	nm.className = "fcard-name";
	nm.textContent = name;
	const tg = document.createElement("span");
	tg.className = "fcard-tag";
	tg.textContent = tag;
	el.append(icon, nm, tg);
	el.dataset.abs = absPath;
	el.title = absPath;
	el.addEventListener("click", (ev) => { ev.stopPropagation(); fcardOpen(absPath); });
	el.addEventListener("contextmenu", (ev) => {
		ev.preventDefault();
		ev.stopPropagation();
		const items = [
			{ label: "📂 打开", fn: () => fcardOpen(absPath) },
			{ label: "🌐 在资源管理器中显示", fn: () => window.openpi.showItemInFolder(absPath).catch((e) => addSysLine(`✗ 定位失败：${e.message ?? e}`, true)) },
			{ label: "📋 复制绝对路径", fn: () => navigator.clipboard.writeText(absPath) },
		];
		const rel = fcardRelPath(absPath);
		if (rel) items.push({ label: "📋 复制相对路径", fn: () => navigator.clipboard.writeText(rel) });
		showCtx(ev.clientX, ev.clientY, items);
	});
	window.openpi.fileStat(absPath).then((st) => { if (!st?.exists) el.classList.add("missing"); }).catch(() => {});
	return el;
}

/** 消息渲染完后把文本节点里的路径替换成文件卡（跳过代码块；行内 code 整体替换） */
function mountFileCards(rootEl) {
	if (!rootEl || !rootEl.querySelector) return;
	const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
		acceptNode: (n) =>
			n.parentElement?.closest("pre, .fcard, .thinking, .work-list, .sysline")
				? NodeFilter.FILTER_REJECT
				: NodeFilter.FILTER_ACCEPT,
	});
	const nodes = [];
	while (walker.nextNode()) nodes.push(walker.currentNode);
	for (const node of nodes) {
		const text = node.nodeValue;
		if (!text) continue;
		// 先兑底 ZCode 私有标记 → 拼进普通路径匹配
		let hay = text;
		const cites = [...hay.matchAll(FCARD_CITE_RE)];
		if (cites.length) {
			hay = hay.replace(FCARD_CITE_RE, (whole, p1) => p1); // 标记还原成纯路径再统一匹配
		} else if (!FCARD_PATH_RE.test(hay)) {
			FCARD_PATH_RE.lastIndex = 0;
			continue;
		}
		FCARD_PATH_RE.lastIndex = 0;
		const frag = document.createDocumentFragment();
		let last = 0, m;
		let matched = false;
		while ((m = FCARD_PATH_RE.exec(hay))) {
			const abs = m[0].replace(/[.,;:)）】。，；！？]+$/, "");
			if (!abs) continue;
			matched = true;
			const start = m.index, end = m.index + abs.length;
			if (start > last) frag.appendChild(document.createTextNode(hay.slice(last, start)));
			frag.appendChild(fileCardEl(abs));
			last = end;
		}
		if (!matched) continue;
		if (last < hay.length) frag.appendChild(document.createTextNode(hay.slice(last)));
		const inlineCode = node.parentElement?.closest("code");
		const target = inlineCode && !inlineCode.closest("pre") ? inlineCode : node;
		target.parentNode.replaceChild(frag, target);
	}
}

/* ================= 基础渲染 ================= */
/* P68：流式跟随智能化——用户上滚离开底部时，流式输出不再强拉底部（stick=false），
   点回底按钮/发新消息/切会话时强制恢复跟随 */
state.stick = true;
function scrollBottom(force = false) {
	if (force) state.stick = true;
	if (!state.stick) return;
	chat.scrollTop = chat.scrollHeight;
}

function nowTime() {
	const d = new Date();
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function removeWelcome() {
	document.getElementById("welcome")?.remove();
}

function addUserMsg(text, images = [], display = null) {
	removeWelcome();
	const el = document.createElement("div");
	el.className = "msg user";
	el.innerHTML = `
		<div class="avatar">U</div>
		<div class="msg-main">
			<div class="who">YOU <span class="time">${nowTime()}</span></div>
			<div class="body"></div>
			${images.length ? '<div class="imgs"></div>' : ""}
		</div>`;
	if (images.length) {
		const box = el.querySelector(".imgs");
		for (const i of images) {
			const im = document.createElement("img");
			im.className = "attach-thumb";
			im.src = `data:${i.mimeType};base64,${i.data}`;
			box.appendChild(im);
		}
	}
	el.querySelector(".body").textContent = display ?? text;
	chat.appendChild(el);
	scrollBottom(true); // 用户主动发言 → 强制回底跟随
}

function addSysLine(text, warn = false) {
	const el = document.createElement("div");
	el.className = "sysline" + (warn ? " warn" : "");
	el.textContent = text;
	chat.appendChild(el);
	scrollBottom();
	return el;
}

function newAssistantBubble() {
	const el = document.createElement("div");
	el.className = "msg assistant";
	el.innerHTML = `
		<div class="avatar">✦</div>
		<div class="msg-main">
			<div class="who">AGENT <span class="time">${nowTime()}</span></div>
			<div class="body"></div>
		</div>`;
	const body = el.querySelector(".body");
	const cursor = document.createElement("span");
	cursor.className = "cursor";
	body.appendChild(cursor);
	chat.appendChild(el);
	pinLiveBar();
	scrollBottom();
	state.cur = { root: el, bodyEl: body, cursor, text: "", thinkingEl: null, thinkingText: "", startTs: Date.now() };
}

/** zcode 风：消息完成后，把本轮所有工具卡折叠成「已工作 N 秒 ›」一行 */
function collapseTools(c) {
	const tools = [...c.bodyEl.querySelectorAll(":scope > .tool")];
	if (!tools.length) return;
	const secs = Math.max(1, Math.round((Date.now() - (c.startTs ?? Date.now())) / 1000));
	const wrap = document.createElement("div");
	wrap.className = "work";
	const bar = document.createElement("button");
	bar.className = "work-bar";
	bar.innerHTML = `<span class="w-ic"><i data-lucide="settings"></i></span><span class="w-tx">已工作 ${secs} 秒 · ${tools.length} 次工具调用</span><span class="chev">›</span>`;
	const list = document.createElement("div");
	list.className = "work-list";
	list.classList.add("hidden");
	bar.addEventListener("click", () => {
		list.classList.toggle("hidden");
		bar.querySelector(".chev").textContent = list.classList.contains("hidden") ? "›" : "⌄";
	});
	wrap.append(bar, list);
	c.bodyEl.after(wrap);
	list.append(...tools);
}

function appendText(delta) {
	if (!state.cur) newAssistantBubble();
	const c = state.cur;
	// P66：正文来了 → 折叠思考条（流式期间思考条自动展开，见 appendThinking）
	if (c.thinkingEl && c.thinkingEl.open) c.thinkingEl.open = false;
	c.text += delta;
	maybeDetectPreview(delta);
	renderStreamingBody();
	scrollBottom();
}

/** 流式期间: 纯文本 + 光标（避免每 token 重排版），结束后整体转 Markdown */
function renderStreamingBody() {
	const c = state.cur;
	if (!c) return;
	c.bodyEl.textContent = "";
	c.bodyEl.appendChild(document.createTextNode(c.text));
	if (c.thinkingEl) c.bodyEl.appendChild(c.thinkingEl);
	c.bodyEl.appendChild(c.cursor);
}

function appendThinking(delta) {
	if (!state.cur) newAssistantBubble();
	const c = state.cur;
	if (!c.thinkingEl) {
		c.thinkingEl = document.createElement("details");
		c.thinkingEl.className = "thinking";
		c.thinkingEl.innerHTML = `<summary><i data-lucide="brain"></i><span class="tt">思考中…</span></summary><div class="content"></div>`;
		c.thinkingEl.open = false;
	}
	c.thinkingText += delta;
	c.thinkingEl.querySelector(".content").textContent = c.thinkingText;
	c.thinkingEl.querySelector(".tt").textContent = `思考过程 (${c.thinkingText.length} 字)`;
	if (!c.bodyEl.contains(c.thinkingEl)) c.bodyEl.appendChild(c.thinkingEl);
	// P66：思考流式期间自动展开——glm-5.2 thinking=high 先思考几十秒，折叠状态下正文空白，
	// 体感是「没流式输出」。展开让思考文本实时滚动；正文首 delta 或结束时折叠（appendText/finalizeAssistant）。
	if (!c.text) c.thinkingEl.open = true;
	scrollBottom();
}

/** 消息结束：Markdown 化 + 代码高亮 + 记录用量 */
function finalizeAssistant(msg) {
	if (!state.cur) return;
	const c = state.cur;
	state.cur = null;
	c.cursor?.remove();
	if (c.thinkingEl) c.thinkingEl.open = false; // P66：结束收起思考条
	collapseTools(c);
	let text = c.text;
	if (!text && msg) text = extractText(msg.content);
	if (text) {
		c.bodyEl.classList.add("md");
		c.bodyEl.innerHTML = renderMarkdown(text);
		highlightIn(c.bodyEl);
		mountFileCards(c.bodyEl); // P37：产物文件卡（含 z:code-file-citation 标记兑底）
		if (c.thinkingEl) c.bodyEl.appendChild(c.thinkingEl);
	} else if (!c.bodyEl.textContent.trim() && !c.bodyEl.querySelector(".thinking")) {
		// 工具轮无文本：隐藏空壳气泡（工具卡已折叠到 work 条）
		c.bodyEl.classList.add("empty-hide");
	}
	const hasWork = !!c.root.querySelector(".work");
	const hasThinking = !!c.thinkingEl && c.bodyEl.contains(c.thinkingEl);
	if (!text && hasWork) c.root.classList.add("toolonly");
	else if (!text && !hasThinking && !hasWork) c.root.remove(); // 完全空轮次直接移除
	mountMsgActs(c, text); // P68：hover 复制/引用操作条
	if (msg?.stopReason === "error") mountRetryChip(c); // P39：失败一轮给「重试」按钮
	const u = msg?.usage;
	if (u) {
		state.usageTotal.input += u.input ?? 0;
		state.usageTotal.output += u.output ?? 0;
		state.usageTotal.cacheRead += u.cacheRead ?? 0;
		state.usageTotal.cacheWrite += u.cacheWrite ?? 0;
		state.usageTotal.cost += u.cost?.total ?? 0; // P48：pi-ai 内置价格表算好的美元成本
		renderUsage();
	}
	scrollBottom();
	scrollBottom();
}

function extractText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b.type === "text").map((b) => b.text).join("");
}

/* ================= 工具卡 ================= */
function ensureBubble() {
	if (!state.cur) newAssistantBubble();
	return state.cur;
}

function toolCard(id, name, args) {
	const card = document.createElement("div");
	card.className = "tool";
	const argStr = typeof args === "string" ? args : JSON.stringify(args, null, 1) ?? "";
	const head = document.createElement("div");
	head.className = "head";
	head.innerHTML = `<span class="name"><i data-lucide="wrench"></i> ${escapeHtml(name)}</span>
		<span class="arg-preview">${escapeHtml(String(args?.path ?? args?.command ?? argStr).replace(/\s+/g, " ").slice(0, 80))}</span>
		<span class="st run">运行中…</span>`;
	const argsEl = document.createElement("div");
	argsEl.className = "args";
	argsEl.textContent = argStr.slice(0, 2000);
	const outEl = document.createElement("div");
	outEl.className = "out";
	card.append(head, argsEl, outEl);
	ensureBubble().bodyEl.appendChild(card);
	pinLiveBar();
	scrollBottom();
	liveBarTool(name);
	const t0 = Date.now();
	const timer = setInterval(() => {
		const rec = state.tools.get(id);
		if (!rec) return;
		rec.st.textContent = `运行中 · ${Math.round((Date.now() - t0) / 1000)}s`;
	}, 1000);
	state.tools.set(id, { card, outEl, out: "", st: head.querySelector(".st"), timer });
}

function toolUpdate(id, partial) {
	const t = state.tools.get(id);
	if (!t) return;
	const s = extractTextDeep(partial);
	if (!s) return;
	maybeDetectPreview(s);
	t.out += (t.out && !t.out.endsWith("\n") ? "\n" : "") + s;
	t.outEl.textContent = t.out.slice(-4000);
	t.card.classList.add("has-out");
	scrollBottom();
}

/** 从任意工具事件载荷中提取可读文本（兼容 string / content blocks / 嵌套对象） */
function extractTextDeep(v, depth = 0) {
	if (v == null || depth > 4) return "";
	if (typeof v === "string") return v;
	if (Array.isArray(v)) return v.map((x) => extractTextDeep(x, depth + 1)).filter(Boolean).join("\n");
	if (typeof v === "object") {
		if (typeof v.text === "string") return v.text;
		if (typeof v.output === "string") return v.output;
		if (v.content !== undefined) return extractTextDeep(v.content, depth + 1);
	}
	return "";
}

function toolEnd(id, toolName, isError, result) {
	const t = state.tools.get(id);
	if (!t) return;
	clearInterval(t.timer);
	liveBarTool(null); // 单个工具结束 → 回到“工作中…”
	t.st.textContent = isError ? "✗ 失败" : "✓ 完成";
	t.st.className = "st " + (isError ? "err" : "ok");

	// edit 工具: details.diff → 彩色 Diff 视图
	if (!isError && (toolName === "edit" || toolName === "write")) {
		const diff = result?.details?.diff;
		if (diff) {
			t.card.appendChild(buildDiffEl(diff));
			scrollBottom();
			state.tools.delete(id);
			return;
		}
	}
	if (!t.out) {
		const s = extractTextDeep(result);
		if (s) { t.outEl.textContent = String(s).slice(0, 4000); t.card.classList.add("has-out"); }
	}
	scrollBottom();
	state.tools.delete(id);
}

function buildDiffEl(diff) {
	const el = document.createElement("div");
	el.className = "diff";
	for (const line of String(diff).split("\n")) {
		const dl = document.createElement("div");
		dl.className = "dl";
		if (line.startsWith("@@")) dl.classList.add("hunk");
		else if (line.startsWith("+")) dl.classList.add("add");
		else if (line.startsWith("-")) dl.classList.add("del");
		else if (line.startsWith("diff ") || /^(---|\+\+\+) /.test(line)) dl.classList.add("file");
		dl.textContent = line || " ";
		el.appendChild(dl);
	}
	return el;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ================= 用量与状态 ================= */
function renderUsage() {
	const u = state.usageTotal;
	usageEl.textContent = `in ${fmt(u.input)} (cache ${fmt(u.cacheRead)}) · out ${fmt(u.output)}` +
		(u.cost > 0.0005 ? ` · $${u.cost.toFixed(u.cost < 1 ? 3 : 2)}` : ""); // P48：已知单价模型才有成本
	usageEl.title = `本会话累计\n输入 ${u.input ?? 0} tok（cache 读 ${u.cacheRead ?? 0} / 写 ${u.cacheWrite ?? 0}）\n输出 ${u.output ?? 0} tok\n成本约 $${(u.cost ?? 0).toFixed(4)}（按模型单价估算）`;
}
function fmt(n) {
	return n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n ?? 0);
}
function setStatus(text) { statusLeft.textContent = text; }

function setStreaming(on) {
	state.streaming = on;
	btnSend.textContent = on ? "■" : "↑";
	btnSend.title = on ? "停止" : "发送";
	btnSend.classList.toggle("stop", on);
	input.placeholder = on
		? "Agent 运行中… Enter = 插话 (steer)"
		: "向 Agent 下达任务…  (Enter 发送 / Shift+Enter 换行)";
	on ? showLiveBar() : hideLiveBar();
}

/* ============ 活性指示（解决“看起来卡死”）：脉冲点 + 秒数跳动 + 当前工具名 ============ */
function showLiveBar() {
	hideLiveBar();
	const el = document.createElement("div");
	el.className = "live-bar";
	el.innerHTML = `<span class="lb-dot"></span><span class="lb-tx">工作中…</span><span class="lb-sec">0s</span>`;
	chat.appendChild(el);
	state.liveBar = {
		el, tx: el.querySelector(".lb-tx"), sec: el.querySelector(".lb-sec"), start: Date.now(),
		timer: setInterval(() => {
			if (!state.liveBar) return;
			state.liveBar.sec.textContent = `${Math.round((Date.now() - state.liveBar.start) / 1000)}s`;
		}, 1000),
	};
}
function pinLiveBar() { if (state.liveBar) chat.appendChild(state.liveBar.el); } // 始终钉在聊天区最底部
function liveBarTool(name) {
	if (!state.liveBar) return;
	state.liveBar.tx.textContent = name ? `运行工具 ${name}…` : "工作中…";
}
function hideLiveBar() {
	const lb = state.liveBar;
	if (!lb) return;
	state.liveBar = null;
	clearInterval(lb.timer);
	for (const t of state.tools.values()) clearInterval(t.timer); // 兜底：中断时清理工具卡计时器
	lb.el.remove();
}

function renderQueue() {
	const n = state.queue.steering + state.queue.followUp;
	queueBadge.classList.toggle("hidden", n === 0);
	if (n) queueBadge.textContent = `队列: ${state.queue.steering} 条插话 / ${state.queue.followUp} 条跟进`;
}

/* ================= 会话侧栏 ================= */
function timeAgo(ms) {
	const d = Date.now() - ms;
	if (d < 60e3) return "刚刚";
	if (d < 3600e3) return Math.floor(d / 60e3) + " 分钟前";
	if (d < 86400e3) return Math.floor(d / 3600e3) + " 小时前";
	if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + " 天前";
	return new Date(ms).toLocaleDateString();
}

async function loadSessions() {
	[state.sessions, state.meta] = await Promise.all([
		window.openpi.listSessions(),
		window.openpi.sessionsMetaGet(),
	]);
	renderSessionList();
	refreshChatTab();
}

/** 会话显示标题：自定义命名 > 首条消息预览 */
function sTitle(s) {
	return state.meta?.[s.id]?.title || s.preview || "(空会话)";
}

function renderSessionList() {
	const q = (sessionFilter?.value ?? "").trim().toLowerCase();
	const all = state.sessions.slice(0, 120);
	const list = q ? all.filter((s) => (s.preview ?? "").toLowerCase().includes(q) || (s.cwd ?? "").toLowerCase().includes(q)) : all;
	const pinned = (arr) => [...arr.filter((s) => state.meta?.[s.id]?.pinned), ...arr.filter((s) => !state.meta?.[s.id]?.pinned)];
	sessionList.innerHTML = "";
	if (all.length === 0) {
		sessionList.innerHTML = `<div class="side-empty">暂无会话，点上方「新对话」开始</div>`;
		return;
	}
	// P34：消息内容深搜结果区（q≥2 且有结果时置顶；点击直接恢复会话）
	if (q.length >= 2 && (state.deepResults ?? []).length) {
		const sec = document.createElement("div");
		sec.className = "deep-search-sec";
		sec.innerHTML = `<div class="git-sec-title" style="padding:6px 12px 2px"><i data-lucide="search"></i> 消息内容匹配 (${state.deepResults.length})</div>`;
		for (const r of state.deepResults) {
			const el = document.createElement("div");
			el.className = "s-item deep-hit";
			const cwdName = r.cwd ? r.cwd.split(/[\\/]/).filter(Boolean).pop() : "?";
			el.innerHTML = `<div class="t"><span class="s-ic"><i data-lucide="search"></i></span><span class="pv">${escapeHtml(r.preview)}</span><span class="time">${timeAgo(r.mtime)}</span></div><div class="s"><span class="cwd"><i data-lucide="folder"></i> ${escapeHtml(cwdName)}</span></div>`;
			el.addEventListener("click", () => resumeSession(r.file));
			sec.appendChild(el);
		}
		sessionList.appendChild(sec);
	}
	if (list.length === 0) {
		const empty = document.createElement("div");
		empty.className = "side-empty";
		empty.innerHTML = (state.deepResults ?? []).length ? "无同名会话（上方为消息内容匹配）" : `无匹配「${escapeHtml(q)}」的会话`;
		sessionList.appendChild(empty);
		return;
	}
	const activeId = state.session?.sessionId;
	const isTaskS = (s) => !!state.meta?.[s.id]?.task || (state.session?.sessionId === s.id && state.session?.task);
	const mkItem = (s, nested) => {
		const el = document.createElement("div");
		el.className = "s-item" + (nested ? " nested" : "") + (activeId === s.id ? " active" : "");
		const isPinned = !!state.meta?.[s.id]?.pinned;
		const cwdName = s.cwd ? s.cwd.split(/[\\/]/).filter(Boolean).pop() : "?";
		el.innerHTML = `<div class="t">${isPinned ? '<span class="pin"><i data-lucide="pin"></i></span>' : ""}<span class="s-ic"><i data-lucide="message-circle"></i></span><span class="pv" title="${escapeHtml(sTitle(s))}">${escapeHtml(sTitle(s))}</span><span class="time">${timeAgo(s.mtime)}</span></div>`
			+ (nested ? "" : `<div class="s"><span class="cwd" title="${escapeHtml(s.cwd)}">📁 ${escapeHtml(cwdName)}</span></div>`);
		el.addEventListener("click", () => resumeSession(s.file));
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			showSessionCtx(e.clientX, e.clientY, s);
		});
		return el;
	};
	if (!q && state.sideTab === "projects") {
		// 「项目」tab：只显示绑定本地工作区的会话（与任务互不重合）
		const groups = new Map();
		for (const s of pinned(list)) {
			if (!s.cwd || isTaskS(s)) continue;
			if (!groups.has(s.cwd)) groups.set(s.cwd, []);
			groups.get(s.cwd).push(s);
		}
		for (const [cwd, items] of groups) {
			const name = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
			const collapsed = state.collapsed.has(cwd);
			const head = document.createElement("div");
			head.className = "proj-head" + (collapsed ? " folded" : "");
			head.innerHTML = `<span class="p-chev">${collapsed ? "▸" : "▾"}</span><span class="p-ic"><i data-lucide="folder"></i></span><span class="p-name" title="${escapeHtml(cwd)}">${escapeHtml(name)}</span>
				<span class="p-count">${items.length}</span><button class="p-new" title="在此项目开新会话">＋</button>`;
			head.querySelector(".p-name").addEventListener("click", () => {
				state.collapsed.has(cwd) ? state.collapsed.delete(cwd) : state.collapsed.add(cwd);
				renderSessionList();
			});
			head.querySelector(".p-new").addEventListener("click", async (e) => {
				e.stopPropagation();
				if (state.streaming) await window.openpi.abort();
				resetChat();
				await startSession(cwd);
				addSysLine(`— 新会话 · ${name} —`);
			});
			sessionList.appendChild(head);
			if (!collapsed) for (const s of items.slice(0, 8)) sessionList.appendChild(mkItem(s, true));
		}
			if (!groups.size) {
				sessionList.innerHTML = `<div class="side-empty">暂无项目会话；点输入框左下角「文件夹」选工作区，或「不在项目中工作」发起普通聊天</div>`;
			}
		} else {
			// 「任务」tab：只显示不在项目中的普通聊天（与项目互不重合）
			const pl = pinned(q ? list : list.filter(isTaskS));
			const pins = pl.filter((s) => state.meta?.[s.id]?.pinned);
			if (pins.length) {
				const gt = document.createElement("div");
				gt.className = "group-title";
				gt.textContent = "置顶";
				sessionList.appendChild(gt);
				for (const s of pins) sessionList.appendChild(mkItem(s, true));
			}
			const gt2 = document.createElement("div");
			gt2.className = "group-title";
			gt2.textContent = q ? "搜索结果" : "聊天";
			sessionList.appendChild(gt2);
			for (const s of (pins.length ? pl.filter((s) => !state.meta?.[s.id]?.pinned) : pl).slice(0, 40)) sessionList.appendChild(mkItem(s, true));
			if (!pl.length) sessionList.innerHTML = `<div class="side-empty">暂无普通聊天；点输入框左下角「文件夹」→「不在项目中工作」开始</div>`;
		}
}

/* ---- M5：侧栏 tab（项目 / 分组） ---- */
const tabProjects = $("tab-projects");
const tabFlat = $("tab-flat");
function setSideTab(t) {
	state.sideTab = t;
	localStorage.setItem("op-side-tab", t);
	tabProjects.classList.toggle("on", t === "projects");
	tabFlat.classList.toggle("on", t === "flat");
	renderSessionList();
}
tabProjects.addEventListener("click", () => setSideTab("projects"));
tabFlat.addEventListener("click", () => setSideTab("flat"));
setSideTab(localStorage.getItem("op-side-tab") || "projects");

/* ---- M5：会话右键菜单（重命名 / 置顶 / 删除） ---- */
const ctxMenu = $("ctx-menu");
function hideCtx() { ctxMenu.hidden = true; }
document.addEventListener("click", hideCtx);
document.addEventListener("scroll", hideCtx, true);
function showCtx(x, y, items) {
	ctxMenu.innerHTML = "";
	for (const it of items) {
		const b = document.createElement("button");
		b.className = "ctx-item" + (it.danger ? " danger" : "");
		b.textContent = it.label;
		b.addEventListener("click", () => { hideCtx(); it.fn(); });
		ctxMenu.appendChild(b);
	}
	ctxMenu.hidden = false;
	const r = ctxMenu.getBoundingClientRect();
	ctxMenu.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
	ctxMenu.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
}
function showSessionCtx(x, y, s) {
	const isPinned = !!state.meta?.[s.id]?.pinned;
	const isCurrent = state.session?.sessionId === s.id;
	showCtx(x, y, [
		{ label: "✏️ 重命名", fn: () => renameSession(s) },
		{ label: isPinned ? "📌 取消置顶" : "📌 置顶", fn: async () => {
			await window.openpi.sessionsMetaSet(s.id, { pinned: !isPinned });
			loadSessions();
		} },
		{ label: "🗑 删除会话", danger: true, fn: async () => {
			const ok = await miniConfirm("删除会话", `将「${sTitle(s).slice(0, 40)}」移入系统回收站？此操作可在回收站恢复。`);
			if (!ok) return;
			try {
				await window.openpi.sessionDelete(s.file);
				addSysLine("🗑 会话已移入回收站");
			} catch (err) { addSysLine(`删除失败: ${err.message ?? err}`, true); }
			loadSessions();
		} },
	]);
}
async function renameSession(s) {
	const name = await miniPrompt("重命名会话", sTitle(s));
	if (name == null) return;
	await window.openpi.sessionsMetaSet(s.id, { title: name });
	if (state.session?.sessionId === s.id) {
		try { await window.openpi.setName(name); } catch { /* 非致命 */ }
	}
	loadSessions();
}

/* ---- M5：迷你弹窗（输入 / 确认，Promise 化） ---- */
const miniMask = $("mini-mask"), miniInput = $("mini-input"), miniInput2 = $("mini-input2"), miniText = $("mini-text"), miniTitle = $("mini-title");
let miniResolve = null;
function miniOpen({ title, value = "", text = "", withInput = true, fields = null }) {
	miniTitle.textContent = title;
	miniText.textContent = text;
	miniText.hidden = !text;
	if (fields) {
		// 双输入模式（v0.29.1：git 身份表单等）
		miniInput.hidden = false;
		miniInput2.hidden = false;
		miniInput.value = "";
		miniInput2.value = "";
		miniInput.placeholder = fields[0] ?? "";
		miniInput2.placeholder = fields[1] ?? "";
		setTimeout(() => miniInput.focus(), 50);
	} else {
		miniInput2.hidden = true;
		miniInput.hidden = !withInput;
		miniInput.placeholder = "";
		miniInput.value = value;
		if (withInput) { miniInput.focus(); miniInput.select(); }
	}
	miniMask.hidden = false;
	return new Promise((res) => (miniResolve = res));
}
function miniDone(v) {
	if (!miniResolve) return;
	miniMask.hidden = true;
	const r = miniResolve;
	miniResolve = null;
	r(v);
}
const miniPrompt = (title, value) => miniOpen({ title, value });
const miniConfirm = (title, text) => miniOpen({ title, text, withInput: false });
$("mini-ok").addEventListener("click", () => {
	if (!miniInput2.hidden) return miniDone([miniInput.value.trim(), miniInput2.value.trim()]);
	miniDone(miniInput.hidden ? true : miniInput.value.trim() || null);
});
$("mini-cancel").addEventListener("click", () => miniDone(null));
miniMask.addEventListener("keydown", (e) => {
	if (e.key === "Escape") miniDone(null);
	if (e.key === "Enter" && !miniInput.hidden && miniInput2.hidden) miniDone(miniInput.value.trim() || null);
});

async function replayHistory() {
	const msgs = await window.openpi.getMessages();
	let shown = 0;
	for (const m of msgs) {
		if (!m.text) continue;
		if (m.role === "user") addUserMsg(m.text);
		else if (m.role === "assistant") {
			newAssistantBubble();
			state.cur.text = m.text;
			finalizeAssistant(null);
		} else continue;
		shown++;
	}
	return shown;
}

/**
 * 会话身份同步：SDK 首次落盘前 sessionId 不稳定（新会话首轮后可能变化）。
 * agent_settled 后拉一次实时 id：变了则更新本地 state；任务会话补打 task 标记。
 */
async function syncSessionIdentity() {
	try {
		const info = await window.openpi.agentInfo();
		if (info?.sessionId && state.session && info.sessionId !== state.session.sessionId) {
			if (state.session.task) {
				await window.openpi.sessionsMetaSet(info.sessionId, { task: true });
				state.meta = { ...state.meta, [info.sessionId]: { ...state.meta?.[info.sessionId], task: true } };
			}
			state.session.sessionId = info.sessionId;
		}
	} catch { /* 会话可能已释放 */ }
	loadSessions();
}

async function resumeSession(file) {
	if (state.streaming) await window.openpi.abort();
	chat.innerHTML = "";
	state.usageTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	renderUsage();
	state.ctx = null; // 恢复会话的上下文占用未知，等首条 usage 事件重算
	setStatus("恢复会话…");
	try {
		const info = await window.openpi.resume(file);
		const isTask = !!state.meta?.[info.sessionId]?.task; // 任务会话：恢复时不绑定项目
		state.session = { ...info, workspace: isTask ? null : info.workspace ?? null, task: isTask };
		// P48：回填历史用量（含成本）
		try {
			const u = await window.openpi.getUsage();
			if (u) { state.usageTotal = u; renderUsage(); }
		} catch { /* 旧版本主进程无此接口 */ }
		if (info.model) {
			// 同步模型下拉框
			const v = `${info.model.provider}/${info.model.id}`;
			if ([...modelSelect.options].some((o) => o.value === v)) modelSelect.value = v;
		}
		workspaceLabel.textContent = state.session.workspace || "不在项目中工作";
		setStatus(`已恢复 · ${info.model?.id ?? "无模型"}`);
		// 回放历史
		const shown = await replayHistory();
		if (shown) addSysLine(`— 已恢复 ${shown} 条历史消息 —`);
		else restoreWelcome();
		renderSessionList();
		refreshChatTab();
	} catch (err) {
		addSysLine(`恢复失败: ${err.message ?? err}`, true);
		setStatus("恢复失败");
	}
}

/* ================= P65：通知中心（渲染层收件箱：留痕 + 未读徽标，OS 通知之外的持久层） ================= */
const NOTIFS = []; // { ic, title, body, ts, unread }
let notifPanelOpen = false;
function pushNotif(ic, title, body = "") {
	NOTIFS.unshift({ ic, title: String(title || "").slice(0, 80), body: String(body || "").slice(0, 120), ts: Date.now(), unread: true });
	if (NOTIFS.length > 60) NOTIFS.length = 60; // 收件箱只留近 60 条
	renderNotifs();
}
function nTimeAgo(ts) {
	const s = Math.round((Date.now() - ts) / 1000);
	return s < 60 ? "刚刚" : s < 3600 ? `${Math.floor(s / 60)} 分钟前` : s < 86400 ? `${Math.floor(s / 3600)} 小时前` : `${Math.floor(s / 86400)} 天前`;
}
function renderNotifs() {
	const badge = $("notif-badge");
	const unread = NOTIFS.filter((n) => n.unread).length;
	badge.hidden = unread === 0;
	badge.textContent = unread > 9 ? "9+" : unread;
	if (!notifPanelOpen) return;
	const list = $("notif-list");
	if (!NOTIFS.length) {
		list.innerHTML = `<div class="n-empty">暂无通知。后台任务、子任务完成与异常都会留在这里。</div>`;
		return;
	}
	list.innerHTML = "";
	for (const n of NOTIFS) {
		const el = document.createElement("div");
		el.className = "n-item" + (n.unread ? " unread" : "");
		el.innerHTML = `<span class="n-ic"></span><div class="n-body"><div class="n-title"></div><div class="n-text"></div></div><span class="n-time"></span>`;
		el.querySelector(".n-ic").textContent = n.ic;
		el.querySelector(".n-title").textContent = n.title;
		el.querySelector(".n-text").textContent = n.body;
		el.querySelector(".n-time").textContent = nTimeAgo(n.ts);
		el.addEventListener("click", () => { n.unread = false; renderNotifs(); });
		list.appendChild(el);
	}
}
function toggleNotifPanel(force) {
	// force 语义：true=展开 / false=收起 / undefined=取反。面板 hidden=true 时取反应得展开（hidden→open）
	notifPanelOpen = force ?? $("notif-panel").hidden;
	$("notif-panel").hidden = !notifPanelOpen;
	if (notifPanelOpen) { NOTIFS.forEach((n) => (n.unread = false)); renderNotifs(); }
}
$("btn-notif").addEventListener("click", () => toggleNotifPanel());
$("notif-readall").addEventListener("click", () => { NOTIFS.forEach((n) => (n.unread = false)); renderNotifs(); });
$("notif-clear").addEventListener("click", () => { NOTIFS.length = 0; renderNotifs(); });
document.addEventListener("click", (e) => { // 点外面收起
	if (notifPanelOpen && !e.target.closest("#notif-panel, #btn-notif")) toggleNotifPanel(false);
});

/* ================= P65：全局命令面板（Ctrl+K：命令 / 会话 / 设置一站式） ================= */
const cmdk = $("cmdk"), cmdkInput = $("cmdk-input"), cmdkList = $("cmdk-list");
let ckItems = [], ckIdx = 0;
function cmdkCommands() {
	return [
		{ ic: "✏️", label: "新建会话", hint: "Ctrl+N", run: () => newSession() },
		{ ic: "🌓", label: "切换亮 / 暗主题", hint: "", run: () => $("btn-theme").click() },
		{ ic: "⚙️", label: "打开设置", hint: "", run: () => $("btn-settings").click() },
		{ ic: "🗂", label: "切换侧栏", hint: "", run: () => $("btn-sidebar").click() },
		{ ic: "📄", label: "文件面板", hint: "Ctrl+P", run: () => showDock("files") },
		{ ic: "🔍", label: "审核面板", hint: "Ctrl+Shift+G", run: () => toggleDock("review") },
		{ ic: "🖥", label: "预览面板", hint: "Ctrl+T", run: () => toggleDock("preview") },
		{ ic: "🔔", label: "打开通知中心", hint: "", run: () => toggleNotifPanel(true) },
	];
}
function openCmdk() {
	cmdk.hidden = false;
	cmdkInput.value = "";
	renderCmdk("");
	cmdkInput.focus();
}
function closeCmdk() { cmdk.hidden = true; }
function renderCmdk(q) {
	const ql = q.trim().toLowerCase();
	const cmds = cmdkCommands().filter((c) => !ql || c.label.toLowerCase().includes(ql));
	const sess = (state.sessions || [])
		.filter((s) => !ql || (s.preview || "").toLowerCase().includes(ql) || (s.cwd || "").toLowerCase().includes(ql))
		.slice(0, 8);
	ckItems = [
		...cmds.map((c) => ({ ...c, group: "命令" })),
		...sess.map((s) => ({ ic: "💬", label: s.preview?.slice(0, 60) || "（无预览）", hint: (s.cwd || "").split(/[\\/]/).pop() || "", run: () => resumeSession(s.file), group: "会话" })),
	];
	ckIdx = 0;
	if (!ckItems.length) { cmdkList.innerHTML = `<div class="ck-empty">没有匹配的命令或会话</div>`; return; }
	cmdkList.innerHTML = "";
	let lastGroup = "";
	ckItems.forEach((it, i) => {
		if (it.group !== lastGroup) {
			lastGroup = it.group;
			const g = document.createElement("div");
			g.className = "ck-group";
			g.textContent = it.group;
			cmdkList.appendChild(g);
		}
		const el = document.createElement("div");
		el.className = "ck-item" + (i === ckIdx ? " active" : "");
		el.innerHTML = `<span class="ck-ic"></span><span class="ck-label"></span><span class="ck-hint"></span>`;
		el.querySelector(".ck-ic").textContent = it.ic;
		el.querySelector(".ck-label").textContent = it.label;
		el.querySelector(".ck-hint").textContent = it.hint;
		el.addEventListener("click", () => runCmdk(i));
		el.addEventListener("mousemove", () => { if (ckIdx !== i) { ckIdx = i; paintCmdk(); } });
		cmdkList.appendChild(el);
	});
}
function paintCmdk() {
	[...cmdkList.querySelectorAll(".ck-item")].forEach((el, i) => el.classList.toggle("active", i === ckIdx));
	cmdkList.querySelectorAll(".ck-item")[ckIdx]?.scrollIntoView({ block: "nearest" });
}
function runCmdk(i) {
	const it = ckItems[i ?? ckIdx];
	if (!it) return;
	closeCmdk();
	try { it.run(); } catch (err) { addSysLine(`命令执行失败: ${err.message ?? err}`, true); }
}
cmdkInput.addEventListener("input", () => renderCmdk(cmdkInput.value));
cmdkInput.addEventListener("keydown", (e) => {
	if (e.key === "ArrowDown") { e.preventDefault(); ckIdx = Math.min(ckIdx + 1, ckItems.length - 1); paintCmdk(); }
	else if (e.key === "ArrowUp") { e.preventDefault(); ckIdx = Math.max(ckIdx - 1, 0); paintCmdk(); }
	else if (e.key === "Enter") { e.preventDefault(); runCmdk(); }
	else if (e.key === "Escape") { e.preventDefault(); closeCmdk(); }
});
$("cmdk-mask").addEventListener("click", closeCmdk);

/* ================= Pi 事件处理 ================= */
function handleEvent(e) {
	switch (e.type) {
		case "agent_start":
			setStreaming(true);
			setStatus("Agent 运行中…");
			break;

		case "turn_start":
			newAssistantBubble();
			break;

		case "message_update": {
			const a = e.assistantMessageEvent;
			if (a.type === "text_delta") appendText(a.delta);
			else if (a.type === "thinking_delta") appendThinking(a.delta);
			break;
		}

		case "message_end":
			if (e.message?.role === "assistant") finalizeAssistant(e.message);
			else if (e.message?.role === "user" && typeof e.message.text === "string" && e.message.text.startsWith("[子任务完成]"))
				pushNotif("🤝", "子任务完成", e.message.text.replace("[子任务完成]", "").trim().slice(0, 100)); // P64：worker 结论推送 → 通知中心留痕
			break;

		case "tool_execution_start":
			toolCard(e.toolCallId, e.toolName, e.args);
			if (e.toolName === "edit" || e.toolName === "write") trackTurnFile(e.args); // P39 本轮改动卡
			break;
		case "tool_execution_update":
			toolUpdate(e.toolCallId, e.partialResult);
			break;
		case "tool_execution_end":
			toolEnd(e.toolCallId, e.toolName, e.isError, e.result);
			if (e.toolName === "edit" || e.toolName === "write") scheduleReviewRefresh(); // 审核角标/面板自动刷新
			break;

		case "turn_end":
			finalizeAssistant(e.message);
			break;

		case "agent_end":
			setStatus(e.willRetry ? "出错，准备自动重试…" : "回合结束");
			break;

		case "update_state": // P33：更新状态推送
			renderUpdateCard(e.state);
			break;
		case "todo_update": // P35：任务清单（todo_write 维护）
			renderTodoBar(e.todos ?? []);
			break;
		case "plan_submit": // P35.1：结构化计划提交（plan_submit 工具）
			state.planDraft = e.plan ?? null;
			renderPlanBar();
			break;
		case "task_update": // P30：后台任务状态变更
			renderTasksBadge();
			if (dockTab === "tasks" && !dock.hidden) renderTasksPane();
			if (e.task?.status === "done") {
				pushNotif("✅", `后台任务完成`, e.task.title || "");
				if (document.hidden) window.openpi.notify(`✅ 后台任务完成`, `${e.task.title || ""}${e.task.workspace ? ` ｜ 沙箱产物：${e.task.workspace}` : ""}`).catch(() => {});
			} else if (e.task?.status === "error") {
				pushNotif("❌", `后台任务失败`, e.task.title || "");
				if (document.hidden) window.openpi.notify(`❌ 后台任务失败`, e.task.title || "").catch(() => {});
			}
			break;

		case "agent_settled":
			setStreaming(false);
			setStatus(`就绪 · ${state.session?.model?.id ?? ""}`);
			renderTurnCard(); // P39：回合结束 → 本轮改动卡（编辑过的文件汇总 + 回滚）
			// P35：计划模式下 AI 说完话 → 亮出批准条
			if (state.lastMode === "plan") { state.planSpoke = true; renderPlanBar(); }
			syncSessionIdentity(); // 会话文件已落盘：同步稳定后的 sessionId + task 标记，再刷新列表
			scheduleReviewRefresh();
			maybeAutoHandoff(); // P24：占用过阈值 → 上下文接力
			// P26：窗口不在前台时弹系统通知（跑长任务可切走，完成不必盯屏）；P65：通知中心总是留痕
			if (document.hidden) {
				const t = $("chat-tab-title")?.textContent || "会话";
				window.openpi.notify(`✅ ${t} · 任务完成`, "Agent 已就绪，点击返回查看结果").catch(() => {});
			} else pushNotif("✅", "任务完成", "Agent 已就绪");
			break;

		case "queue_update":
			state.queue = { steering: e.steering?.length ?? 0, followUp: e.followUp?.length ?? 0 };
			renderQueue();
			break;

		case "compaction_start":
			addSysLine(`🗜 上下文压缩中 (${e.reason})…`);
			break;
		case "compaction_end":
			if (e.result) addSysLine(`🗜 压缩完成: ${e.result.tokensBefore ?? "?"} tokens → 摘要+近期保留`);
			else if (e.errorMessage) addSysLine(`🗜 压缩失败: ${e.errorMessage}`, true);
			break;

		case "auto_retry_start":
			addSysLine(`⚠ 瞬时错误，${(e.delayMs / 1000).toFixed(0)}s 后自动重试 (${e.attempt}/${e.maxAttempts})`, true);
			break;
		case "auto_retry_end":
			addSysLine(e.success ? "✓ 重试成功" : `✗ 重试失败: ${e.finalError ?? ""}`, !e.success);
			break;

		case "thinking_level_changed":
			thinkingSelect.value = e.level;
			break;
	}
}

/* ================= 发送逻辑 ================= */
async function send() {
	const text0 = expandSkillRef(input.value.trim());
	if (!text0 && state.images.length === 0) return;
	input.value = "";
	autoGrow();
	const images = state.images.splice(0); // 取出并清空
	renderImageBar();
	// P61 坐坑 #89：智谱拒收 [text("")+image] 组合（HTTP 400/1210，实测复现）——纯贴图时补非空占位
	const text = text0 || (images.length ? "（见附图）" : "");
	await sendText(text, images);
}

/** 发送核心（send 与 P24 上下文接力共用）：streaming 时转 steer */
async function sendText(text, images = [], display = null) {
	if (!state.session) { addSysLine("会话未启动", true); return; }
	// P35：# 快捷记忆（向 Claude Code 取经）——# 开头的一句话不发给模型，直接固化进工作区 AGENTS.md
	if (text.startsWith("#")) {
		const memo = text.replace(/^#+\s*/, "").trim();
		if (!memo) { openMemoryModal(); return; } // 空内容 = 打开记忆管理
		try {
			await window.openpi.appendMemory(memo);
			addSysLine(`🧠 已记忆 → 工作区 AGENTS.md：${memo.slice(0, 60)}${memo.length > 60 ? "…" : ""}（后续会话自动生效）`);
			const chip = $("chip-agents");
			if (chip && !chip.hidden) chip.click?.(); // 触发刷新（若可见）
		} catch (err) { addSysLine(`记忆失败: ${err.message ?? err}`, true); }
		return;
	}
	if (state.streaming) {
		await window.openpi.steer(text, images);
		return;
	}
	addUserMsg(text || "（图片）", images, display);
	state.lastPrompt = { text, images }; // P39 失败重试
	state.turnFiles = new Set(); // P39 本轮改动卡归零
	state.turnCard = null;
	setStreaming(true);
	setStatus("发送中…");
	try {
		await window.openpi.prompt(text, images);
	} catch (err) {
		addSysLine(`发送失败: ${err.message ?? err}`, true);
		setStreaming(false);
	}
}

async function stop() {
	try { await window.openpi.abort(); setStatus("已请求中断…"); } catch { /* noop */ }
}

/* ================= P39：本轮改动卡 / 失败重试 / 命令允许清单（向 Cursor 取经） ================= */
function trackTurnFile(args) {
	try {
		const p = String(args?.path ?? args?.file_path ?? "");
		const ws = state.session?.workspace;
		if (!p || !ws) return;
		const np = p.replace(/\\/g, "/");
		const nws = String(ws).replace(/\\/g, "/").replace(/\/+$/, "");
		const rel = np.toLowerCase().startsWith(nws.toLowerCase() + "/") ? np.slice(nws.length + 1) : np;
		(state.turnFiles ??= new Set()).add(rel);
	} catch { /* 尽力而为 */ }
}

function renderTurnCard() {
	const files = [...(state.turnFiles ?? [])];
	if (!files.length || state.turnCard || state.streaming) return;
	state.turnCard = true;
	const el = document.createElement("div");
	el.className = "turn-card";
	el.innerHTML = `<div class="tc-head"><i data-lucide="file-diff"></i> 本轮改动 <b>${files.length}</b> 个文件（AI 修改前已自动快照，可回滚）</div>`
		+ `<div class="tc-files">${files.map((f) => `<span class="tc-file" title="${escapeHtml(f)}">${escapeHtml(f)}</span>`).join("")}</div>`
		+ `<div class="tc-actions"><button class="tc-btn tc-review">🔍 打开审核面板</button><button class="tc-btn tc-rollback">⏪ 全部回滚</button></div>`;
	el.querySelector(".tc-review").addEventListener("click", () => showDock("review"));
	el.querySelector(".tc-rollback").addEventListener("click", async (ev) => {
		const ok = await miniConfirm("回滚本轮改动", `以下 ${files.length} 个文件将恢复到 AI 首次修改前的快照（AI 新建的文件会被删除）：\n${files.slice(0, 12).join("\n")}${files.length > 12 ? `\n… 共 ${files.length} 个` : ""}`);
		if (!ok) return;
		let fail = 0;
		for (const f of files) {
			try { await window.openpi.checkpointRestore(f); addSysLine(`⏪ 已回滚: ${f}`); }
			catch (err) { fail++; addSysLine(`回滚失败 ${f}: ${err.message ?? err}`, true); }
		}
		ev.target.disabled = true;
		addSysLine(fail ? `回滚完成（${files.length - fail}/${files.length} 成功）` : `⏪ 本轮 ${files.length} 个文件已全部回滚`);
		updateReviewBadge();
		if (dockTab === "review" && !dock.hidden) refreshReview();
	});
	chat.appendChild(el);
	scrollBottom();
}

function mountRetryChip(c) {
	if (!state.lastPrompt) return;
	const btn = document.createElement("button");
	btn.className = "retry-chip";
	btn.textContent = "重试本轮";
	btn.addEventListener("click", async () => {
		if (state.streaming || !state.lastPrompt) return;
		btn.disabled = true;
		btn.textContent = "重试中…";
		setStreaming(true);
		setStatus("重试中…");
		try { await window.openpi.prompt(state.lastPrompt.text, state.lastPrompt.images); }
		catch (err) { addSysLine(`重试失败: ${err.message ?? err}`, true); setStreaming(false); }
	});
	c.bodyEl.appendChild(btn);
	scrollBottom();
}

/* ---- P39 命令允许清单（localStorage 持久化 → 主进程审批扩展） ---- */
const DEFAULT_ALLOWLIST = ["npm test", "npm run", "git status", "git diff", "git log", "ls", "dir", "node -v", "python --version"];
function getAllowlist() {
	try {
		const v = JSON.parse(localStorage.getItem("op-allowlist") ?? "");
		if (Array.isArray(v)) return v.map(String);
	} catch { /* 用默认 */ }
	return [...DEFAULT_ALLOWLIST];
}
function applyAllowlist() {
	window.openpi.setApprovalAllowlist(getAllowlist()).catch(() => {});
}
function openAllowModal() {
	const list = getAllowlist();
	$("allow-mask").hidden = false;
	const render = () => {
		$("allow-list").innerHTML = list.length
			? list.map((s, i) => `<span class="allow-item">${escapeHtml(s)}<button data-i="${i}" class="allow-del" title="删除">×</button></span>`).join("")
			: '<span class="dim small">（空清单 = 所有命令按当前档位正常审批）</span>';
	};
	render();
	$("allow-list").onclick = (e) => {
		const b = e.target.closest(".allow-del");
		if (b) { list.splice(Number(b.dataset.i), 1); render(); }
	};
	const add = () => {
		const v = $("allow-input").value.trim();
		if (v && !list.includes(v)) { list.push(v); $("allow-input").value = ""; render(); }
	};
	$("allow-add").onclick = add;
	$("allow-input").onkeydown = (e) => { if (e.key === "Enter") add(); };
	$("allow-save").onclick = () => {
		localStorage.setItem("op-allowlist", JSON.stringify(list));
		applyAllowlist();
		addSysLine(`⚙ 允许清单已更新（${list.length} 条）`);
		$("allow-mask").hidden = true;
	};
	$("allow-cancel").onclick = () => { $("allow-mask").hidden = true; };
	setTimeout(() => $("allow-input").focus(), 50);
}
$("allow-btn").addEventListener("click", openAllowModal);
applyAllowlist(); // 启动即生效（localStorage → 主进程）

function resetChat() {
	chat.innerHTML = "";
	restoreWelcome();
	state.usageTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	renderUsage();
	state.tools.clear();
	state.ctx = null; // 新会话上下文从零开始
	state.turnFiles = new Set();
	state.turnCard = null;
}

/** 欢迎屏（新会话空状态）：点示例任务直接填入输入框 */
function restoreWelcome() {
	if (document.getElementById("welcome")) return;
	const tpl = document.getElementById("welcome-tpl");
	if (!tpl) return;
	chat.appendChild(tpl.content.cloneNode(true));
	refreshIcons(); // P46：欢迎卡图标
}
chat?.addEventListener?.("click", (e) => {
	const btn = e.target.closest(".w-task");
	if (!btn) return;
	input.value = btn.dataset.q ?? "";
	autoGrow();
	input.focus();
});

/* ================= 启动流程 ================= */
function populateModels(models) {
	state.models = models;
	modelSelect.innerHTML = "";
	const groups = new Map();
	for (const m of models) {
		if (!groups.has(m.provider)) groups.set(m.provider, []);
		groups.get(m.provider).push(m);
	}
	for (const [provider, list] of groups) {
		const og = document.createElement("optgroup");
		og.label = provider;
		for (const m of list) {
			const o = document.createElement("option");
			o.value = `${m.provider}/${m.id}`;
			o.textContent = `${m.name} · ${m.contextWindow ? fmtWin(m.contextWindow) : "上下文未知"}`;
			og.appendChild(o);
		}
		modelSelect.appendChild(og);
	}
}

function selectedModel() {
	const [provider, ...rest] = modelSelect.value.split("/");
	return { provider, id: rest.join("/") };
}

async function startSession(workspace) {
	const { provider, id } = selectedModel();
	const isTask = workspace === null; // 任务模式：不在项目中工作
	setStatus(isTask ? "启动普通聊天…" : "启动会话…");
	try {
		const info = await window.openpi.start({ workspace, provider, id, thinkingLevel: thinkingSelect.value });
		state.session = { ...info, workspace: isTask ? null : (info.workspace ?? workspace), task: isTask }; // 主进程可能回退到默认工作区
		workspaceLabel.textContent = state.session.workspace || "不在项目中工作";
		workspaceLabel.title = state.session.workspace || "普通聊天，不绑定项目目录";
		setStatus(`就绪 · ${info.model?.id ?? "无模型"}`);
		if (isTask && info.sessionId) {
			// 打任务标记：会话列表据此分类（项目/任务互不重合）
			await window.openpi.sessionsMetaSet(info.sessionId, { task: true }).catch(() => {});
			state.meta = { ...state.meta, [info.sessionId]: { ...state.meta?.[info.sessionId], task: true } };
		}
		if (info.fallback) addSysLine(`⚠ ${info.fallback}`, true);
		state.sessions = await window.openpi.listSessions(); // 新会话文件立即入列（不等首轮 agent_settled）
		renderSessionList();
		refreshChatTab();
		refreshBranch();
	} catch (err) {
		addSysLine(`会话启动失败: ${err.message ?? err}`, true);
		setStatus("启动失败");
	}
}

function autoGrow() {
	input.style.height = "auto";
	input.style.height = Math.min(input.scrollHeight, 160) + "px";
}

/* ================= 事件绑定 ================= */
btnSend.addEventListener("click", () => (state.streaming ? stop() : send()));
$("btn-new-side").addEventListener("click", newSession);
/* P64⑧：外部会话导入 */
$("btn-import")?.addEventListener("click", async () => {
	const sources = await window.openpi.sessionsImportScan().catch(() => []);
	if (!sources.length) { addSysLine("未检测到可导入的外部会话（支持：Claude Code ~/.claude/projects）", true); return; }
	const names = sources.map((s) => `${s.kind}（${s.count} 个会话）`).join("、");
	const ok = await miniConfirm("导入外部会话", `检测到：${names}。转换后出现在会话列表（只读回看，可搜索）。继续？`);
	if (!ok) return;
	let total = 0;
	for (const s of sources) {
		try {
			const r = await window.openpi.sessionsImportDo(s.kind);
			total += r.imported ?? 0;
			addSysLine(`📥 ${s.kind}：新导入 ${r.imported}，已存在/无文本跳过 ${r.skipped}`);
		} catch (err) { addSysLine(`${s.kind} 导入失败: ${err.message ?? err}`, true); }
	}
	if (total > 0) loadSessions();
});
async function newSession() {
	resetChat();
	await startSession(state.session?.workspace);
	addSysLine("— 新会话已创建 —");
}
btnWorkspace.addEventListener("click", () => toggleWsPicker());

/* ---- 工作区选择器（ZCode 式）：搜索 / 最近项目 / 打开文件夹 / 不在项目中工作 ---- */
const wsPicker = $("ws-picker");
const wsSearch = $("ws-search");
const wsList = $("ws-list");
let wsPickOpen = false;
function toggleWsPicker() {
	if (wsPickOpen) { wsPicker.hidden = true; wsPickOpen = false; return; }
	const r = btnWorkspace.getBoundingClientRect();
	wsPicker.style.left = r.left + "px";
	wsPicker.style.bottom = window.innerHeight - r.top + 8 + "px";
	wsPicker.style.top = "auto";
	wsPicker.hidden = false;
	wsPickOpen = true;
	wsSearch.value = "";
	renderWsList("");
	wsSearch.focus();
}
function knownWorkspaces() {
	// 已知项目 = 会话历史里的工作区（去重，按最近使用排序）
	const seen = new Map();
	for (const s of state.sessions) {
		if (s.cwd && !seen.has(s.cwd)) seen.set(s.cwd, s.mtime);
	}
	if (state.session?.workspace && !seen.has(state.session.workspace)) seen.set(state.session.workspace, Date.now());
	return [...seen.entries()].map(([cwd, mtime]) => ({ cwd, mtime })).sort((a, b) => b.mtime - a.mtime);
}
function renderWsList(q) {
	const ql = q.trim().toLowerCase();
	const items = knownWorkspaces().filter((w) => !ql || w.cwd.toLowerCase().includes(ql));
	wsList.innerHTML = "";
	if (!items.length) wsList.innerHTML = `<div class="ws-empty">无匹配工作区，用「打开文件夹」选择</div>`;
	for (const w of items) {
		const name = w.cwd.split(/[\\/]/).filter(Boolean).pop() || w.cwd;
		const cur = state.session?.workspace === w.cwd;
		const el = document.createElement("button");
		el.className = "ws-item";
		el.innerHTML = `<span><i data-lucide="folder"></i></span><span class="ws-name" title="${escapeHtml(w.cwd)}"></span><span class="ws-path"></span>${cur ? '<span class="ws-check">✓</span>' : ""}`;
		el.querySelector(".ws-name").textContent = name;
		el.querySelector(".ws-path").textContent = w.cwd;
		el.addEventListener("click", async () => {
			wsPicker.hidden = true; wsPickOpen = false;
			if (cur) return; // 已在工作区里
			if (state.streaming) await window.openpi.abort();
			resetChat();
			await startSession(w.cwd);
			addSysLine(`— 工作区: ${name} —`);
		});
		wsList.appendChild(el);
	}
}
wsSearch.addEventListener("input", () => renderWsList(wsSearch.value));
$("ws-open-folder").addEventListener("click", async () => {
	wsPicker.hidden = true; wsPickOpen = false;
	const dir = await window.openpi.pickWorkspace();
	if (!dir) return;
	if (state.streaming) await window.openpi.abort();
	resetChat();
	await startSession(dir);
	addSysLine(`— 工作区: ${dir} —`);
});
$("ws-no-project").addEventListener("click", async () => {
	wsPicker.hidden = true; wsPickOpen = false;
	if (state.session?.workspace == null) return; // 已经是普通聊天
	if (state.streaming) await window.openpi.abort();
	resetChat();
	await startSession(null);
	addSysLine("— 普通聊天（不在项目中）—");
});
// 点弹层外关闭
document.addEventListener("click", (e) => {
	if (!wsPickOpen || wsPicker.contains(e.target) || btnWorkspace.contains(e.target)) return;
	wsPicker.hidden = true; wsPickOpen = false;
}, true);

/* ---- 主题切换（暗 ↔ 亮，记忆在 localStorage） ---- */
const themeBtn = $("btn-theme");
function applyTheme(t) {
	document.documentElement.dataset.theme = t;
	localStorage.setItem("op-theme", t); // 图标由 CSS 按 data-theme 切换（P46）
}
themeBtn.addEventListener("click", () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));
applyTheme(localStorage.getItem("op-theme") || "dark");

/* ---- 附件按钮（文件选择器 → 与粘贴同管道） ---- */
$("btn-attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (e) => {
	const files = [...e.target.files].filter((f) => /^image\//.test(f.type));
	if (files.length) ingestFiles(files);
	e.target.value = "";
});

/* ---- 分支 chip：工作区是 git 仓库时显示当前分支 ---- */
async function refreshBranch() {
	const chip = $("chip-branch");
	if (!state.session?.workspace) { chip.hidden = true; return; }
	try {
		const st = await window.openpi.gitStatus();
		const m = st.match(/^##\s+([^\s.\[\]]+)/m);
		const branch = m ? m[1] : "";
		if (branch && !/No HEAD|not a git|fatal/i.test(branch)) {
			$("branch-label").textContent = branch;
			chip.hidden = false;
		} else chip.hidden = true;
	} catch { chip.hidden = true; }
	refreshAgentsChip(); // P26：指令文件 chip 随分支 chip 一起刷新（独立容错）
}
$("chip-branch").addEventListener("click", () => toggleDock("review"));

/* ---- P27：Git 分支保护（保护分支 / 合并主分支） ---- */
$("review-protect").addEventListener("click", async () => {
	try {
		const r = await window.openpi.gitProtect();
		addSysLine(`🌿 ${r.msg ?? "已切到保护分支"}: ${r.branch}`);
	} catch (err) {
		addSysLine(`保护分支失败: ${err.message ?? err}`, true);
	}
	refreshReview();
});
$("review-mergeback").addEventListener("click", async () => {
	try {
		const r = await window.openpi.gitMergeBack();
		addSysLine(`⇥ 已合并 ${r.branch} → ${r.base}`);
	} catch (err) {
		addSysLine(`合并失败: ${err.message ?? err}`, true);
	}
	refreshReview();
});

/* ---- P26：AGENTS.md 指令文件 chip + dock 面板（pi 内核同款发现规则，零偏差） ---- */
const AGENTS_GENERATE_PROMPT = "请为本工作区生成（或更新）AGENTS.md，作为后续会话的项目指令：\n"
	+ "1. 快速摸底：目录结构、README、package.json/构建脚本、测试与 lint 命令、代码风格约定；\n"
	+ "2. 写入工作区根目录的 AGENTS.md：项目概述、常用命令（安装/构建/测试）、代码约定、目录要点、注意事项；\n"
	+ "3. 若已存在 AGENTS.md：在原基础上修订，保留仍有效的段落，不要推倒重来；\n"
	+ "4. 只写确认过的事实（命令必须与实际脚本核对），不要臆造。";

async function refreshAgentsChip() {
	const chip = $("chip-agents");
	try {
		const files = await window.openpi.agentsFiles();
		state.agentsFiles = files;
		if (files.length) {
			$("agents-label").textContent = `AGENTS×${files.length}`;
			chip.hidden = false;
		} else chip.hidden = true;
	} catch {
		chip.hidden = true;
	}
}

/* ---- P30：后台并行任务面板 ---- */
const TASK_STATUS_LABEL = { running: "运行中", done: "完成", error: "失败" };
function renderTasksBadge() {
	const el = $("tasks-cnt");
	if (!el) return;
	window.openpi.taskList().then((list) => {
		const n = (list ?? []).filter((t) => t.status === "running").length;
		el.textContent = String(n);
		el.hidden = !n;
	}).catch(() => { el.hidden = true; });
}
async function renderTasksPane() {
	const body = $("tasks-body");
	const list = await window.openpi.taskList().catch(() => []);
	if (!list.length) {
		body.innerHTML = '<div class="dim small" style="padding:12px">暂无后台任务。在下方输入描述，点「▶ 后台运行」把任务丢到后台并行跑，主会话继续可用。任务完成时若窗口最小化会弹系统通知。</div>';
	} else {
		body.innerHTML = "";
		for (const t of [...list].reverse()) {
			const row = document.createElement("div");
			row.className = "review-file";
			const dot = t.status === "running" ? "🟡" : t.status === "done" ? "🟢" : "🔴";
			const dur = ((t.endedAt ?? Date.now()) - t.startedAt) / 1000;
			row.innerHTML = `<span></span><span class="path"></span><span class="dim small task-meta"></span>`;
			row.querySelector("span").textContent = dot;
			row.querySelector(".path").textContent = t.title;
			const meta = [TASK_STATUS_LABEL[t.status] ?? t.status, `${t.toolCalls} 个工具调用`, dur < 60 ? `${Math.round(dur)}s` : `${Math.floor(dur / 60)}m${Math.round(dur % 60)}s`];
			if (t.error) meta.push(`错误：${t.error}`);
			row.querySelector(".task-meta").textContent = meta.join(" · ");
			if (t.workspace) { // P41：沙箱目录，点「📂」定位
				const openBtn = document.createElement("span");
				openBtn.className = "task-open dim small";
				openBtn.style.cssText = "cursor:pointer;text-decoration:underline;margin-left:8px";
				openBtn.innerHTML = '<i data-lucide="folder-open"></i> 任务文件夹'; refreshIcons();
				openBtn.addEventListener("click", (ev) => {
					ev.stopPropagation();
					window.openpi.showItemInFolder(t.workspace).catch(() => {});
				});
				row.querySelector(".task-meta").appendChild(openBtn);
			}
			row.title = t.lastText || t.title;
			const detail = document.createElement("pre");
			detail.className = "dim small hidden";
			detail.style.cssText = "white-space:pre-wrap;word-break:break-word;padding:8px 12px;margin:0;border-bottom:1px solid rgba(128,128,128,.2)";
			detail.textContent = t.lastText ? `最近输出：\n${t.lastText}` : "（暂无输出）";
			row.addEventListener("click", () => detail.classList.toggle("hidden"));
			body.appendChild(row);
			body.appendChild(detail);
		}
	}
	renderTasksBadge();
}
$("tasks-refresh")?.addEventListener("click", renderTasksPane);
$("task-go")?.addEventListener("click", async () => {
	const inp = $("task-input");
	const prompt = (inp.value || "").trim();
	if (!prompt) return;
	try {
		await window.openpi.taskStart(prompt);
		inp.value = "";
		addSysLine(`⚡ 已发起后台任务：${prompt.slice(0, 48)}`);
		renderTasksPane();
	} catch (err) {
		addSysLine(`✗ 后台任务发起失败：${err.message ?? err}`, true);
	}
});
$("task-input")?.addEventListener("keydown", (e) => {
	if (e.key === "Enter") $("task-go").click();
});

async function renderAgentsPane() {
	const body = $("agents-body");
	const files = state.agentsFiles ?? (await window.openpi.agentsFiles().catch(() => []));
	state.agentsFiles = files;
	body.innerHTML = "";
	if (!files.length) {
		body.innerHTML = '<div class="dim small" style="padding:12px">未发现 AGENTS.md / CLAUDE.md。<br><br>'
			+ '指令文件会在会话启动时注入系统提示词：全局 ~/.pi/agent/AGENTS.md + 工作区及父目录（AGENTS.override.md 优先）。<br><br>'
			+ '点击下方按钮让 Agent 摸底仓库后生成。</div>';
		return;
	}
	body.innerHTML = `<div class="git-sec-title">本会话加载的指令文件 (${files.length})</div>`
		+ files.map((f, i) => `<div class="review-file" data-i="${i}">`
			+ `<span class="path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>`
			+ `<span class="rv-actions"><button class="rv-btn rv-open" title="用系统默认编辑器打开">打开</button></span></div>`)
			.join("");
	body.querySelectorAll(".rv-open").forEach((btn, i) => {
		btn.addEventListener("click", () => window.openpi.openPath(files[i].path).catch(() => {}));
	});
}

$("chip-agents").addEventListener("click", () => toggleDock("agents"));
$("agents-refresh").addEventListener("click", async () => {
	await refreshAgentsChip();
	renderAgentsPane();
});
$("agents-generate").addEventListener("click", () => {
	if (!state.session) return setStatus("先启动会话再生成");
	closeDock();
	sendText(AGENTS_GENERATE_PROMPT);
});
btnSidebar.addEventListener("click", () => sidebar.classList.toggle("collapsed"));
sessionFilter.addEventListener("input", () => {
	renderSessionList();
	// P34：消息内容深搜（300ms 防抖，q≥2 触发）
	clearTimeout(state.deepTimer);
	const q = sessionFilter.value.trim();
	if (q.length < 2) {
		state.deepResults = [];
		renderSessionList();
		return;
	}
	state.deepTimer = setTimeout(async () => {
		try {
			state.deepResults = (await window.openpi.sessionsSearch(q)) ?? [];
		} catch {
			state.deepResults = [];
		}
		renderSessionList();
	}, 300);
});

/* ---- 快捷键：Ctrl+N 新对话 / Ctrl+K 搜索会话 / Ctrl+= 新窗口 / Ctrl+Shift+G 审核 / Ctrl+Alt+B 面板开关 / Ctrl+P 文件 / Ctrl+T 预览 ---- */
document.addEventListener("keydown", (e) => {
	if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "g") {
		e.preventDefault();
		toggleDock("review");
		return;
	}
	if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.key.toLowerCase() === "b") {
		e.preventDefault();
		$("btn-dock").click();
		return;
	}
	if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
	const k = e.key.toLowerCase();
	if (k === "n") { e.preventDefault(); newSession(); }
	else if (k === "k") { e.preventDefault(); openCmdk(); } // P65：Ctrl+K 升级为全局命令面板（含会话搜索，原会话过滤在面板内承接）
	else if (k === "=") { e.preventDefault(); window.openpi.newWindow(); }
	else if (k === "p") { e.preventDefault(); showDock("files"); filesFilter.focus(); filesFilter.select(); }
	else if (k === "t") { e.preventDefault(); toggleDock("preview"); }
});
modelSelect.addEventListener("change", async () => {
	if (!state.session) return;
	const { provider, id } = selectedModel();
	try {
		await window.openpi.setModel(provider, id);
		state.session.model = { provider, id };
		updateCtxBar(); // P38.8：窗口随模型变化，立即刷新仪表（用上次 usage）
		setStatus(`已切换模型 · ${provider}/${id}`);
	} catch (err) {
		addSysLine(`切换失败: ${err.message ?? err}`, true);
	}
});
thinkingSelect.addEventListener("change", () => window.openpi.setThinking(thinkingSelect.value));
/* ================= / 技能引用菜单（对标 ZCode slash 弹层） ================= */
const slashMenu = $("slash-menu");
const slashList = $("slash-list");
let slashItems = [];
let slashIdx = 0;

function activeSkills() {
	if (!skillsCache) return [];
	return [...(skillsCache.managed ?? []), ...(skillsCache.external ?? [])];
}
function slashToken() {
	const m = input.value.match(/^\/([a-z0-9_-]*)$/i);
	return m ? m[1].toLowerCase() : null;
}
function updateSlashMenu() {
	const tok = slashToken();
	if (tok === null) { slashMenu.hidden = true; return; }
	const q = tok;
	const all = activeSkills().filter(
		(s) => s.name.toLowerCase().includes(q) || (s.descriptionZh || s.description).toLowerCase().includes(q),
	);
	slashItems = all.slice(0, 30);
	slashIdx = 0;
	if (!slashItems.length) {
		slashList.innerHTML = `<div class="side-empty">无匹配技能（可在 设置 → 技能 安装）</div>`;
	} else {
		slashList.innerHTML = "";
		slashItems.forEach((s, i) => {
			const el = document.createElement("div");
			el.className = "slash-item" + (i === slashIdx ? " active" : "");
			el.innerHTML = `<b></b><span class="dim small"></span>`;
			el.querySelector("b").textContent = "/" + s.name;
			el.querySelector("span").textContent = s.descriptionZh || s.description;
			el.title = s.descriptionZh ? `中文：${s.descriptionZh}\n原文：${s.description}` : s.description;
			el.addEventListener("mousedown", (e) => { e.preventDefault(); pickSlash(i); });
			el.addEventListener("mousemove", () => { if (slashIdx !== i) { slashIdx = i; paintSlash(); } });
			slashList.appendChild(el);
		});
	}
	atMenu.hidden = true; // 与 @ 文件菜单互斥
	slashMenu.hidden = false;
}
function paintSlash() {
	[...slashList.querySelectorAll(".slash-item")].forEach((el, i) => el.classList.toggle("active", i === slashIdx));
	slashList.querySelectorAll(".slash-item")[slashIdx]?.scrollIntoView({ block: "nearest" });
}
function pickSlash(i) {
	const s = slashItems[i];
	if (!s) return;
	input.value = "/" + s.name + " ";
	slashMenu.hidden = true;
	autoGrow();
	input.focus();
}
/* ---- P27：@ 文件引用补全（工作区文件，git ls-files 优先，60s 缓存） ---- */
const atMenu = $("at-menu");
const atList = $("at-list");
let atItems = [];
let atIdx = 0;
let atToken = null; // { start, q }
let atCache = null;
let atCacheTs = 0;

function atTokenInfo() {
	const pos = input.selectionStart ?? input.value.length;
	const m = input.value.slice(0, pos).match(/(^|[\s(（【"'])@([^\s@]*)$/);
	return m ? { start: pos - m[2].length - 1, q: m[2].toLowerCase() } : null;
}
async function updateAtMenu() {
	const t = atTokenInfo();
	atToken = t;
	if (!t) {
		atMenu.hidden = true;
		return;
	}
	if (!atCache || Date.now() - atCacheTs > 60000) {
		atCache = await window.openpi.filesFlat().catch(() => []);
		atCacheTs = Date.now();
		if (atToken !== t) return; // 拉取期间 token 已变，丢弃
	}
	const q = t.q;
	atItems = (q ? atCache.filter((f) => f.toLowerCase().includes(q)) : atCache).slice(0, 12);
	atIdx = 0;
	if (!atItems.length) {
		atList.innerHTML = `<div class="side-empty">无匹配文件</div>`;
	} else {
		atList.innerHTML = "";
		atItems.forEach((f, i) => {
			const el = document.createElement("div");
			el.className = "slash-item" + (i === atIdx ? " active" : "");
			el.innerHTML = `<b class="mono"></b>`;
			el.querySelector("b").textContent = f;
			el.addEventListener("mousedown", (e) => { e.preventDefault(); pickAt(i); });
			el.addEventListener("mousemove", () => { if (atIdx !== i) { atIdx = i; paintAt(); } });
			atList.appendChild(el);
		});
	}
	slashMenu.hidden = true; // 与技能菜单互斥
	atMenu.hidden = false;
}
function paintAt() {
	[...atList.querySelectorAll(".slash-item")].forEach((el, i) => el.classList.toggle("active", i === atIdx));
	atList.querySelectorAll(".slash-item")[atIdx]?.scrollIntoView({ block: "nearest" });
}
function pickAt(i) {
	const f = atItems[i];
	if (!f || atToken === null) return;
	const pos = input.selectionStart ?? input.value.length;
	const insert = (f.includes(" ") ? `"${f}"` : f) + " ";
	input.value = input.value.slice(0, atToken.start) + insert + input.value.slice(pos);
	atMenu.hidden = true;
	autoGrow();
	input.focus();
}

/** 发送前把 "/技能名 ..." 展开成明确的技能引用指令（保证 Agent 必定感知） */
function expandSkillRef(text) {
	const m = text.match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i);
	if (!m) return text;
	const known = activeSkills().find((s) => s.name.toLowerCase() === m[1].toLowerCase());
	if (!known) return text;
	return `请使用「${known.name}」技能完成以下任务：\n${m[2] ?? ""}`;
}

input.addEventListener("keydown", (e) => {
	if (!atMenu.hidden && atItems.length) {
		if (e.key === "ArrowDown") { e.preventDefault(); atIdx = (atIdx + 1) % atItems.length; paintAt(); return; }
		if (e.key === "ArrowUp") { e.preventDefault(); atIdx = (atIdx - 1 + atItems.length) % atItems.length; paintAt(); return; }
		if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickAt(atIdx); return; }
		if (e.key === "Escape") { atMenu.hidden = true; return; }
	}
	if (!slashMenu.hidden && slashItems.length) {
		if (e.key === "ArrowDown") { e.preventDefault(); slashIdx = (slashIdx + 1) % slashItems.length; paintSlash(); return; }
		if (e.key === "ArrowUp") { e.preventDefault(); slashIdx = (slashIdx - 1 + slashItems.length) % slashItems.length; paintSlash(); return; }
		if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSlash(slashIdx); return; }
		if (e.key === "Escape") { slashMenu.hidden = true; return; }
	}
	if (e.key === "Enter" && !e.shiftKey) {
		e.preventDefault();
		send();
	}
});
input.addEventListener("input", () => { autoGrow(); updateSlashMenu(); updateAtMenu(); });
document.addEventListener("mousedown", (e) => {
	if (!slashMenu.hidden && !slashMenu.contains(e.target) && e.target !== input) slashMenu.hidden = true;
	if (typeof atMenu !== "undefined" && !atMenu.hidden && !atMenu.contains(e.target) && e.target !== input) atMenu.hidden = true;
});
window.openpi.onEvent(handleEvent);

/* ================= boot ================= */
(async function boot() {
	try {
		restoreWelcome();
		loadSessions();
		window.openpi.skillsList().then((r) => { skillsCache = r; }).catch(() => {}); // 供 / 技能菜单使用
		const info = await window.openpi.init();
		populateModels(info.models);
		setStatus(`已加载 ${info.models.length} 个可用模型 · Electron Node ${info.nodeVersion}`);
		if (info.models.length === 0) {
			addSysLine("未发现任何已配置供应商。请在 ~/.pi/agent/auth.json 配置 API Key，或在 models.json 添加自定义/本地模型。", true);
			return;
		}
		const prefer = info.models.findIndex((m) => `${m.provider}/${m.id}` === "zhipu/glm-5.3-flash");
		if (prefer >= 0) modelSelect.selectedIndex = prefer;
		await startSession(null);
	} catch (err) {
		setStatus("初始化失败");
		addSysLine(`初始化失败: ${err.message ?? err}`, true);
	}
})();

/* ================= 配置中心（L1 密钥 / L2 自定义供应商 / L4 本地模型） ================= */
const settingsMask = $("settings-mask");
const tip = (el, text, cls = "") => {
	el.textContent = text;
	el.className = "msg-tip " + cls;
	setTimeout(() => { if (el.textContent === text) { el.textContent = ""; el.className = "msg-tip"; } }, 6000);
};

function openSettings() {
	settingsMask.classList.remove("hidden");
	renderConfig();
	renderSkillsPage(); // 技能与电脑控制（轻量 IPC，每次打开都刷新）
}
$("btn-settings").addEventListener("click", openSettings);
$("btn-settings-close").addEventListener("click", () => settingsMask.classList.add("hidden"));
settingsMask.addEventListener("click", (e) => { if (e.target === settingsMask) settingsMask.classList.add("hidden"); });

document.querySelectorAll(".tab").forEach((t) =>
	t.addEventListener("click", () => {
		document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
		for (const p of document.querySelectorAll(".tab-pane")) p.classList.add("hidden");
		$("tab-" + t.dataset.tab).classList.remove("hidden");
	}),
);

let configCache = null;
async function renderConfig() {
	configCache = await window.openpi.configGet();
	renderKeyList();
	renderProviderList();
	renderPresetGrid();
}

/* ---- Tab1: API 密钥 ---- */
function renderKeyList() {
	const wrap = $("key-list");
	wrap.innerHTML = "";
	const rows = new Map();
	// 自定义/本地供应商（models.json）
	for (const [id, p] of Object.entries(configCache.providers)) {
		rows.set(id, { name: p.name, has: p.hasKey, keyTxt: p.apiKeyMasked || (p.hasKey ? "(auth.json)" : "未配置"), from: "自定义" });
	}
	// auth.json 里的额外条目（含内置供应商密钥）
	for (const [id, a] of Object.entries(configCache.authProviders)) {
		if (!rows.has(id)) rows.set(id, { name: id, has: !!a.keyMasked, keyTxt: a.keyMasked || "未配置", from: "内置" });
		else rows.get(id).keyTxt += ` · auth: ${a.keyMasked}`;
	}
	for (const [id, r] of rows) {
		const el = document.createElement("div");
		el.className = "kv-item";
		el.innerHTML = `<span class="dot ${r.has ? "" : "off"}"></span><span class="kv-name"></span>
			<span class="kv-key"></span><span class="spacer"></span><span class="kv-meta">${r.from} · ${r.has ? "已配置" : "未配置"}</span>`;
		el.querySelector(".kv-name").textContent = `${r.name} (${id})`;
		el.querySelector(".kv-key").textContent = r.keyTxt;
		el.addEventListener("click", () => { $("key-provider").value = id; $("key-value").focus(); });
		wrap.appendChild(el);
	}
}
$("btn-save-key").addEventListener("click", async () => {
	const id = $("key-provider").value.trim(), key = $("key-value").value.trim();
	if (!id || !key) return tip($("key-msg"), "需要 provider id 和密钥", "err");
	try {
		configCache = await window.openpi.configSaveKey(id, key);
		$("key-value").value = "";
		tip($("key-msg"), `✓ 已保存 ${id} 的密钥（auth.json, 0600）`, "ok");
		renderKeyList();
	} catch (e) { tip($("key-msg"), e.message ?? String(e), "err"); }
});

/* ---- Tab2: 自定义供应商 ---- */
function renderProviderList() {
	const wrap = $("provider-list");
	wrap.innerHTML = "";
	for (const [id, p] of Object.entries(configCache.providers)) {
		const el = document.createElement("div");
		el.className = "kv-item";
		el.innerHTML = `<span class="dot ${p.hasKey ? "" : "off"}"></span><span class="kv-name"></span>
			<span class="kv-meta"></span><span class="spacer"></span><span class="kv-key">${p.models.length} 模型</span>`;
		el.querySelector(".kv-name").textContent = `${p.name} (${id})`;
		el.querySelector(".kv-meta").textContent = `${p.baseUrl} · ${p.api}`;
		el.title = "点击载入到下方表单";
		el.addEventListener("click", () => fillProviderForm(p));
		wrap.appendChild(el);
	}
}
function fillProviderForm(p) {
	$("fp-id").value = p.id; $("fp-name").value = p.name === p.id ? "" : p.name;
	$("fp-baseurl").value = p.baseUrl; $("fp-api").value = p.api; $("fp-key").value = "";
	$("fp-models").value = p.models.map((m) => (m.name && m.name !== m.id ? `${m.id} | ${m.name}` : m.id)).join("\n");
	$("fp-devrole").checked = !!p.compat?.supportsDeveloperRole === false;
	$("fp-effort").checked = !!p.compat?.supportsReasoningEffort === false;
}
function parseModelsText(txt) {
	return txt.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
		const [id, name] = l.split("|").map((s) => s.trim());
		return name ? { id, name } : { id };
	});
}
$("btn-save-provider").addEventListener("click", async () => {
	const id = $("fp-id").value.trim();
	if (!id) return tip($("fp-msg"), "需要供应商 ID", "err");
	const compat = {};
	if ($("fp-devrole").checked) compat.supportsDeveloperRole = false;
	if ($("fp-effort").checked) compat.supportsReasoningEffort = false;
	try {
		configCache = await window.openpi.configSaveProvider(id, {
			name: $("fp-name").value.trim(),
			baseUrl: $("fp-baseurl").value.trim(),
			api: $("fp-api").value,
			apiKey: $("fp-key").value.trim() || undefined,
			models: parseModelsText($("fp-models").value),
			compat: Object.keys(compat).length ? compat : undefined,
		});
		tip($("fp-msg"), `✓ 已保存 ${id}（models.json）· 新会话生效`, "ok");
		renderProviderList(); renderKeyList();
	} catch (e) { tip($("fp-msg"), e.message ?? String(e), "err"); }
});
$("btn-del-provider").addEventListener("click", async () => {
	const id = $("fp-id").value.trim();
	if (!id || !confirm(`确定删除供应商 ${id}？`)) return;
	configCache = await window.openpi.configDeleteProvider(id);
	tip($("fp-msg"), `已删除 ${id}`, "ok");
	renderProviderList(); renderKeyList();
});
$("btn-test-endpoint").addEventListener("click", async () => {
	const id = $("fp-id").value.trim();
	const el = $("fp-msg");
	tip(el, "测试中…");
	const r = await window.openpi.configTest({
		baseUrl: $("fp-baseurl").value.trim(),
		apiKey: $("fp-key").value.trim() || undefined,
		providerId: id || undefined,
	});
	if (!r.ok) return tip(el, `✗ 连接失败（${r.ms}ms）: ${r.error}`, "err");
	tip(el, `✓ 连通 · ${r.ms}ms · ${r.count} 个模型`, "ok");
	// 表单模型列表为空时自动填充远端模型
	if (!$("fp-models").value.trim() && r.sample?.length) {
		$("fp-models").value = r.sample.join("\n");
	}
});

/* ---- Tab3: 本地模型预设 ---- */
function renderPresetGrid() {
	const grid = $("preset-grid");
	grid.innerHTML = "";
	for (const [key, p] of Object.entries(configCache.presets)) {
		const b = document.createElement("button");
		b.className = "preset-card";
		b.innerHTML = `<b>${p.label}</b><span>${p.baseUrl}</span><div class="kv-meta" style="margin-top:4px">${p.hint}</div>`;
		b.addEventListener("click", async () => {
			$("fp-id").value = key;
			$("fp-name").value = p.label;
			$("fp-baseurl").value = p.baseUrl;
			$("fp-api").value = "openai-completions";
			$("fp-key").value = "";
			$("fp-models").value = "";
			$("fp-devrole").checked = true; $("fp-effort").checked = true;
			document.querySelector('.tab[data-tab="providers"]').click();
			tip($("preset-msg"), `已载入 ${p.label} 预设 → 表单已填充，点「测连通」拉取已装模型`, "ok");
			// 自动测连通拉模型列表
			const r = await window.openpi.configTest({ baseUrl: p.baseUrl, apiKey: p.apiKey });
			if (r.ok && r.count) {
				$("fp-models").value = r.sample.join("\n") + (r.count > r.sample.length ? `\n（共 ${r.count} 个，已填前 ${r.sample.length} 个，可手动补充）` : "");
				tip($("preset-msg"), `✓ ${p.label} 在线 · 发现 ${r.count} 个模型，已填充 → 点「保存供应商」`, "ok");
			} else if (!r.ok) {
				tip($("preset-msg"), `${p.label} 未连通: ${r.error} —— 请确认服务已启动，然后手动「测连通」`, "err");
			}
		});
		grid.appendChild(b);
	}
}

/* ---- 重载模型目录 ---- */
$("btn-reload-models").addEventListener("click", async () => {
	const el = $("key-msg");
	try {
		const { models } = await window.openpi.refreshModels();
		populateModels(models);
		tip(el, `✓ 模型目录已重载：${models.length} 个可用`, "ok");
	} catch (e) { tip(el, e.message ?? String(e), "err"); }
});

/* ================= M2：上下文进度条 / 会话树 / 压缩 / 导出 / 改名 / 扩展UI模态 ================= */
const HANDOFF_PCT = 0.8; // P24 上下文接力阈值（pi 原生压缩触发线 = 1-16384/窗口 ≈ 87%@128k，接力必须赶在它前面）
/* P38.8：显式上下文仪表（原来只有 3px 细线，数字藏在悬停提示里） */
const ctxWrap = document.createElement("span");
ctxWrap.id = "ctx-wrap";
const ctxTrack = document.createElement("span");
ctxTrack.id = "ctx-track";
const ctxBar = document.createElement("span");
ctxBar.id = "ctx-bar";
const ctxText = document.createElement("span");
ctxText.id = "ctx-text";
ctxText.className = "dim mono";
ctxTrack.appendChild(ctxBar);
ctxWrap.append(ctxTrack, ctxText);
$("statusbar").prepend(ctxWrap);
const fmtWin = (n) => (n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M` : `${Math.round(n / 1000)}k`);

function updateCtxBar(usage) {
	if (usage) state.lastUsage = usage;
	const u = state.lastUsage;
	const model = state.models.find((m) => state.session?.model && m.provider === state.session.model.provider && m.id === state.session.model.id);
	const win = model?.contextWindow || state.session?.model?.contextWindow || 0;
	const used = u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) : 0;
	if (!win || !used) {
		ctxBar.style.width = "0";
		ctxText.textContent = win ? `上下文 0 / ${fmtWin(win)}` : "";
		ctxWrap.title = win ? `上下文窗口 ${fmtWin(win)} · 压缩触发线 ${Math.round((1 - 16384 / win) * 100)}% · 接力线 ${HANDOFF_PCT * 100}%` : "";
		state.ctx = null;
		return;
	}
	const pct = Math.min(100, (used / win) * 100);
	ctxBar.style.width = pct.toFixed(1) + "%";
	ctxBar.style.background = pct >= 90 ? "#f87171" : pct >= 70 ? "#eab308" : "#22c55e";
	ctxText.textContent = `上下文 ${(used / 1000).toFixed(1)}k / ${fmtWin(win)} · ${pct.toFixed(0)}%`;
	ctxWrap.title = `上下文: ${(used / 1000).toFixed(1)}k / ${fmtWin(win)} (${pct.toFixed(1)}%) · 压缩触发线 ${Math.round((1 - 16384 / win) * 100)}% · 接力线 ${HANDOFF_PCT * 100}%`;
	state.ctx = { pct, used, win };
}

/* ---- P24：上下文接力（占用过阈值 → 压缩摘要 → 新会话继续） ---- */
async function maybeAutoHandoff() {
	const mode = localStorage.getItem("op-handoff") ?? "auto";
	if (mode === "off" || state.handoffBusy || state.streaming || !state.session) return;
	const pct = state.ctx?.pct ?? 0;
	if (pct < HANDOFF_PCT * 100) return;
	if (mode === "ask") {
		const ok = await uiModal({ kind: "confirm", title: "上下文接力", message: `上下文已用 ${Math.round(pct)}%（接力线 ${HANDOFF_PCT * 100}%）。现在压缩出交接摘要并开启新会话继续吗？` });
		if (!ok) { state.ctx.pct = 0; return; } // 本会话内不再重复问
	}
	await doHandoff(pct);
}

async function doHandoff(pct) {
	state.handoffBusy = true;
	const oldId = state.session.sessionId;
	const rawTitle = String(state.meta?.[oldId]?.title || $("chat-tab-title").textContent || "会话");
	const mN = rawTitle.match(/ · 接力(\d+)$/);
	const base = rawTitle.replace(/ · 接力\d+$/, "");
	setStreaming(false);
	setStatus(`🔄 上下文接力（${Math.round(pct)}%）：生成交接摘要…`);
	try {
		const r = await window.openpi.handoff({ thinkingLevel: thinkingSelect.value });
		if (!r.summary) throw new Error("无法生成交接摘要（会话内容太少或压缩失败），已保留原会话");
		state.session = { ...r, workspace: r.workspace ?? state.session.workspace, task: state.session.task };
		state.ctx = null; // 新会话从零开始，防接力链风暴
		state.usageTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		renderUsage();
		workspaceLabel.textContent = state.session.workspace || "不在项目中工作";
		const nTitle = `${base} · 接力${(mN ? Number(mN[1]) : 0) + 1}`;
		if (r.sessionId) {
			const patch = { title: nTitle, ...(state.session.task ? { task: true } : {}) };
			state.meta = { ...state.meta, [r.sessionId]: { ...(state.meta?.[r.sessionId] ?? {}), ...patch } };
			await window.openpi.sessionsMetaSet(r.sessionId, patch).catch(() => {});
		}
		loadSessions();
		refreshChatTab();
		addSysLine(`🔄 上下文已用 ${Math.round(pct)}% → 已接力到新会话（原会话已归档，侧栏可回看）`);
		await sendText(
			`【自动接力】上一会话上下文接近用尽（${Math.round(pct)}%），已自动切换到本会话。以下是上一会话的交接摘要：\n\n${r.summary}\n\n请基于以上摘要继续完成任务：先用一两句话确认当前状态与下一步，然后直接继续执行。`,
			[],
			`【自动接力】交接摘要已注入新会话（${r.summary.length} 字，原会话 ${r.tokensBefore ?? "?"} tokens）`,
		);
	} catch (e) {
		addSysLine(`上下文接力失败: ${e.message ?? e}`, true);
		setStatus(`就绪 · ${state.session?.model?.id ?? ""}`);
	} finally {
		state.handoffBusy = false;
	}
}

/* ---- M2 工具按钮 ---- */
const m2bar = document.createElement("div");
m2bar.id = "m2bar";
m2bar.innerHTML = `
	<button id="btn-compact" class="m2btn" title="手动压缩上下文（生成摘要，释放窗口空间）">🗜</button>
	<button id="btn-tree" class="m2btn" title="会话树（分支导航）">🌳</button>
	<button id="btn-export" class="m2btn" title="导出会话为 HTML">📤</button>
	<button id="btn-rename" class="m2btn" title="重命名会话">✏</button>`;
document.querySelector("#statusbar .spacer")?.before(m2bar) ?? $("statusbar").appendChild(m2bar);

$("btn-compact").addEventListener("click", async () => {
	if (state.streaming) return addSysLine("请等回合结束后再压缩", true);
	addSysLine("🗜 手动压缩中…");
	try {
		const r = await window.openpi.compact();
		addSysLine(`🗜 压缩完成: ${r.tokensBefore ?? "?"} → ${r.tokensAfter ?? "?"} tokens`);
	} catch (e) { addSysLine(`压缩失败: ${e.message ?? e}`, true); }
});

$("btn-export").addEventListener("click", async () => {
	try {
		const p = await window.openpi.exportHtml();
		addSysLine(`📤 已导出 HTML: ${p}`);
	} catch (e) { addSysLine(`导出失败: ${e.message ?? e}`, true); }
});

$("btn-rename").addEventListener("click", async () => {
	const name = await uiModal({ kind: "input", title: "重命名会话", placeholder: "输入新名称（留空取消）" });
	if (!name) return;
	const shown = await window.openpi.setName(name);
	addSysLine(`✏ 会话已改名: ${shown ?? name}`);
	loadSessions();
});

/* ---- 会话树面板 ---- */
$("btn-tree").addEventListener("click", async () => {
	if (!state.session) return addSysLine("会话未启动", true);
	let tree;
	try { tree = await window.openpi.tree(); } catch (e) { return addSysLine(`获取树失败: ${e.message ?? e}`, true); }
	openTreeModal(tree);
});

function openTreeModal(tree) {
	const mask = document.createElement("div");
	mask.className = "modal-mask";
	const typeIcon = (n) => (n.type === "message" ? (n.role === "user" ? "👤" : n.role === "assistant" ? "🤖" : "🧠") : n.type === "compaction" ? "🗜" : n.type === "branch_summary" ? "🌿" : n.type === "label" ? "🏷" : "·");
	const render = (nodes, depth) => nodes.map((n) => `
		<div class="tree-node" data-id="${n.id}" style="margin-left:${depth * 18}px">
			<span class="t-icon">${typeIcon(n)}</span>
			<span class="t-label">${n.label ? `🏷 ${n.label}` : ""}</span>
			<span class="t-preview">${escapeHtml(n.preview) || `<i>${n.type}</i>`}</span>
		</div>${render(n.children, depth + 1)}`).join("");
	mask.innerHTML = `<div class="modal" style="width:min(680px,92vw)">
		<div class="modal-head"><span>会话树 · 点击节点切换分支（同文件内导航）</span><div class="spacer"></div><button class="icon-btn tree-close">✕</button></div>
		<div class="tab-pane">${render(tree, 0)}</div>
	</div>`;
	document.body.appendChild(mask);
	mask.querySelector(".tree-close").addEventListener("click", () => mask.remove());
	mask.addEventListener("click", (e) => { if (e.target === mask) mask.remove(); });
	mask.querySelectorAll(".tree-node").forEach((el) =>
		el.addEventListener("click", async () => {
			const id = el.dataset.id;
			mask.remove();
			try {
				const r = await window.openpi.navigateTree(id);
				if (r.cancelled) return addSysLine("树导航已取消", true);
				addSysLine("🌿 已切换分支，重放历史…");
				resetChat();
				await replayHistory();
				// pi 行为：导航到用户消息节点时，该消息被撤回编辑器
				if (r.editorText) {
					input.value = r.editorText;
					autoGrow();
					addSysLine("— 该节点的用户消息已撤回输入框，可修改后重新发送 —");
				}
			} catch (e) { addSysLine(`导航失败: ${e.message ?? e}`, true); }
		}),
	);
}

/* ---- 扩展 UI 模态（confirm/select/input） ---- */
function uiModal(req) {
	return new Promise((resolve) => {
		const mask = document.createElement("div");
		mask.className = "modal-mask";
		mask.style.zIndex = 200;
		let bodyHtml = "";
		if (req.kind === "confirm") {
			bodyHtml = `<div class="ui-msg">${escapeHtml(req.message ?? "")}</div>
				<div class="form-row"><button class="btn primary ui-ok">允许</button><button class="btn danger ui-no">拒绝</button></div>`;
		} else if (req.kind === "select") {
			bodyHtml = `<div class="ui-select">${(req.options ?? []).map((o, i) => `<div class="kv-item ui-opt" data-v="${escapeHtml(o)}">${i + 1}. ${escapeHtml(o)}</div>`).join("")}</div>`;
		} else {
			bodyHtml = `<input class="input ui-in" style="width:100%" placeholder="${escapeHtml(req.placeholder ?? "")}" />
				<div class="form-row"><button class="btn primary ui-ok">确定</button></div>`;
		}
		mask.innerHTML = `<div class="modal" style="width:min(520px,90vw)">
			<div class="modal-head"><span>${escapeHtml(req.title ?? "")}</span><div class="spacer"></div><button class="icon-btn ui-x">✕</button></div>
			<div class="tab-pane">${bodyHtml}</div>
		</div>`;
		document.body.appendChild(mask);
		const done = (v) => { mask.remove(); resolve(v); };
		mask.querySelector(".ui-x").addEventListener("click", () => done(req.kind === "confirm" ? false : undefined));
		mask.addEventListener("click", (e) => { if (e.target === mask) done(req.kind === "confirm" ? false : undefined); });
		mask.querySelector(".ui-ok")?.addEventListener("click", () => done(req.kind === "confirm" ? true : mask.querySelector(".ui-in").value));
		mask.querySelector(".ui-no")?.addEventListener("click", () => done(false));
		mask.querySelectorAll(".ui-opt").forEach((o) => o.addEventListener("click", () => done(o.dataset.v)));
		mask.querySelector(".ui-in")?.focus();
	});
}

/* ---- M2 事件处理 ---- */
function handleM2Event(e) {
	if (e.type === "message_end" && e.message?.role === "assistant" && e.message.usage) updateCtxBar(e.message.usage);
	else if (e.type === "ui_request") {
		uiModal(e).then((v) => window.openpi.uiRespond(e.id, v));
	} else if (e.type === "ui_notify") {
		addSysLine(`${e.level === "error" ? "✗" : e.level === "warning" ? "⚠" : "ℹ"} ${e.message}`, e.level === "error");
		if (e.level === "error" || e.level === "warning") pushNotif(e.level === "error" ? "❗" : "⚠️", e.level === "error" ? "运行异常" : "警告", e.message);
	}
}
// 第二订阅：M2 事件（不覆盖主分发）
window.openpi.onEvent(handleM2Event);

/* ================= M3：新窗口并行 + 内核版本检查 ================= */
// 顶栏已精简：预览/审核由 Dock 标签、分支 chip 与快捷键承接，新窗口走 Ctrl+= 快捷键
$("btn-check-updates").addEventListener("click", async () => {
	const el = $("update-info");
	el.textContent = "检查中…";
	try {
		const r = await window.openpi.checkUpdates();
		el.textContent = r.hasUpdate === null
			? `内核 ${r.local ?? "?"}（无法获取最新版，可能离线）`
			: r.hasUpdate
				? `有更新: ${r.local} → ${r.latest}（npm i -D @earendil-works/pi-coding-agent 后重启）`
				: `内核已是最新: ${r.local}`;
	} catch (e) { el.textContent = `检查失败: ${e.message ?? e}`; }
});

/* ================= M3.5：审批三档 / Git 面板 / 图片输入 ================= */

/* ---- 审批模式 ---- */
$("approval-select").addEventListener("change", async (e) => {
	try {
		if (e.target.value === "goal") {
			// P63：目标模式先填目标+验收标准，确认后才真正切换
			$("goal-bar").hidden = false;
			$("goal-text").focus();
			return; // 等 btn-goal-start 确认后再切
		}
		const real = await window.openpi.setApprovalMode(e.target.value);
		if (typeof real === "string" && real !== e.target.value) e.target.value = real; // 主进程纠偏则回滚显示
		const cur = e.target.value;
		const names = { readonly: "只读", "auto-edit": "自动编辑", "full-auto": "全自动", plan: "计划模式（只读探索，批准后执行）" };
		addSysLine(`🛡 审批模式：${names[cur]}`);
		// P35：进入计划模式时记住来源档位，批准后切回
		if (cur === "plan") {
			state.planPrevMode = state.lastMode || "auto-edit";
			state.planSpoke = false;
		}
		state.lastMode = cur;
		renderPlanBar();
	} catch (err) {
		e.target.value = state.lastMode || "auto-edit"; // 失败回滚 select，保持与主进程一致
		addSysLine(`切换失败: ${err.message ?? err}`, true);
	}
});

/* ---- P63：目标模式输入条 ---- */
$("btn-goal-start").addEventListener("click", async () => {
	const text = $("goal-text").value.trim();
	if (!text) { addSysLine("请先填写目标与验收标准再锁定", true); return; }
	try {
		await window.openpi.setApprovalMode("goal", text);
		$("goal-bar").hidden = true;
		state.lastMode = "goal";
		addSysLine("🎯 目标模式已锁定：AI 将自主迭代到验收标准全部满足（危险命令仍会请求确认）");
	} catch (err) {
		$("approval-select").value = state.lastMode || "auto-edit";
		addSysLine(`切换失败: ${err.message ?? err}`, true);
	}
});
$("btn-goal-cancel").addEventListener("click", () => {
	$("goal-bar").hidden = true;
	$("approval-select").value = state.lastMode || "auto-edit";
});

/* ---- P35：任务清单条 + 计划批准 ---- */
function renderTodoBar(todos) {
	state.todos = todos;
	const bar = $("todo-bar");
	if (!todos.length) { bar.hidden = true; return; }
	bar.hidden = false;
	const done = todos.filter((t) => t.status === "done").length;
	$("todo-progress").textContent = `☑ 任务清单 ${done}/${todos.length}`;
	const list = $("todo-list");
	list.innerHTML = "";
	for (const t of todos) {
		const el = document.createElement("div");
		el.className = `todo-item ${t.status}`;
		const ic = t.status === "done" ? "☑" : t.status === "in_progress" ? "◐" : "○";
		el.innerHTML = `<span class="todo-ic">${ic}</span><span class="todo-txt"></span>`;
		el.querySelector(".todo-txt").textContent = t.status === "in_progress" ? (t.activeForm || t.content) : t.content;
		list.appendChild(el);
	}
}
$("todo-collapse").addEventListener("click", () => {
	const list = $("todo-list");
	list.hidden = !list.hidden;
	$("todo-collapse").textContent = list.hidden ? "▸" : "▾";
});

function renderPlanBar() {
	const mode = $("approval-select").value;
	// 计划卡片：plan 模式 + 有结构化计划草稿 + AI 已说完话时亮出；离开 plan 立即隐藏
	const bar = $("plan-bar");
	const show = mode === "plan" && !state.streaming && state.planSpoke;
	bar.hidden = !show;
	if (show && state.planDraft) {
		const p = state.planDraft;
		$("plan-goal").textContent = p.goal || "";
		$("plan-steps-count").textContent = p.steps?.length ? `（${p.steps.length} 步）` : "";
		const steps = $("plan-steps");
		steps.innerHTML = "";
		(p.steps ?? []).forEach((s, i) => {
			const el = document.createElement("label");
			el.className = "plan-step";
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.className = "plan-step-cb";
			const txt = document.createElement("span");
			txt.className = "plan-step-txt";
			txt.textContent = `${i + 1}. ${s.title}${s.detail ? ` — ${s.detail}` : ""}`;
			el.appendChild(cb);
			el.appendChild(txt);
			steps.appendChild(el);
		});
		$("plan-risks").textContent = p.risks ? `⚠ 风险：${p.risks}` : "";
		$("plan-risks").hidden = !p.risks;
	}
}
state.planSpoke = false;
state.planPrevMode = "auto-edit";
state.lastMode = "auto-edit";
state.planDraft = null;
$("btn-plan-approve").addEventListener("click", async () => {
	const prev = state.planPrevMode || "auto-edit";
	$("approval-select").value = prev;
	await window.openpi.setApprovalMode(prev);
	state.planSpoke = false;
	state.planDraft = null;
	renderPlanBar();
	addSysLine(`📋 计划已批准，切回「${{ readonly: "只读", "auto-edit": "自动编辑", "full-auto": "全自动" }[prev]}」开始执行`);
	sendText("计划已批准，按计划开始执行。");
});
$("btn-plan-dismiss").addEventListener("click", () => {
	state.planSpoke = false;
	renderPlanBar();
	addSysLine("📋 继续在计划模式下讨论，需要修改计划可直接补充要求");
});

/* ---- P35.1：记忆管理（发空 # 打开） ---- */
async function openMemoryModal() {
	$("memory-mask").hidden = false;
	await refreshMemoryList();
}
async function refreshMemoryList() {
	const items = await window.openpi.listMemory().catch(() => []);
	const list = $("memory-list");
	list.innerHTML = "";
	$("memory-empty").hidden = items.length > 0;
	for (const it of items) {
		const row = document.createElement("div");
		row.className = "memory-item";
		const txt = document.createElement("div");
		txt.className = "memory-txt";
		const t = document.createElement("span");
		t.className = "dim small";
		t.textContent = it.ts;
		const c = document.createElement("div");
		c.textContent = it.text;
		txt.appendChild(t);
		txt.appendChild(c);
		const del = document.createElement("button");
		del.className = "icon-btn memory-del";
		del.title = "删除这条记忆";
		del.textContent = "🗑";
		del.dataset.text = it.text;
		row.appendChild(txt);
		row.appendChild(del);
		list.appendChild(row);
	}
}
$("memory-close").addEventListener("click", () => { $("memory-mask").hidden = true; });
$("memory-mask").addEventListener("click", (e) => { if (e.target === $("memory-mask")) $("memory-mask").hidden = true; });
$("memory-list").addEventListener("click", async (e) => {
	const btn = e.target.closest(".memory-del");
	if (!btn) return;
	const r = await window.openpi.deleteMemory(btn.dataset.text).catch(() => null);
	if (r?.removed) { addSysLine(`🧠 已删除 ${r.removed} 条记忆`); await refreshMemoryList(); }
	else addSysLine("删除失败或条目已不存在", true);
});

/* ---- P24：上下文接力模式 ---- */
$("handoff-select").value = localStorage.getItem("op-handoff") ?? "auto";
$("handoff-select").addEventListener("change", (e) => {
	localStorage.setItem("op-handoff", e.target.value);
	const names = { auto: "自动接力", ask: "接力前询问", off: "手动（仅顶栏 🗜 压缩）" };
	addSysLine(`🔄 上下文接力：${names[e.target.value]}（自动=占用 ${HANDOFF_PCT * 100}% 时压缩摘要并开新会话继续）`);
});

/* ---- 图片输入：粘贴 / 拖拽（P38.6：贴图自动压缩） ---- */
const IMG_MAX_EDGE = 2048;          // 最长边超过则等比缩小
const IMG_COMPRESS_OVER = 1.5 * 1024 * 1024; // 原始体积超此值即使不缩也重编码
const fmtMB = (n) => (n / 1024 / 1024).toFixed(1) + "MB";
/** canvas 压缩：返回 jpeg base64；不值得压（小图且体积达标）返回 null */
function compressImage(dataURL, force) {
	return new Promise((resolve) => {
		const im = new Image();
		im.onload = () => {
			try {
				const edge = Math.max(im.naturalWidth, im.naturalHeight);
				const scale = Math.min(1, IMG_MAX_EDGE / edge);
				if (scale >= 1 && !force) return resolve(null);
				const cv = document.createElement("canvas");
				cv.width = Math.max(1, Math.round(im.naturalWidth * scale));
				cv.height = Math.max(1, Math.round(im.naturalHeight * scale));
				const ctx = cv.getContext("2d");
				ctx.fillStyle = "#fff"; // 透明底（PNG 截图）转白底，JPEG 不支持透明
				ctx.fillRect(0, 0, cv.width, cv.height);
				ctx.drawImage(im, 0, 0, cv.width, cv.height);
				const out = cv.toDataURL("image/jpeg", 0.85);
				resolve(out.slice(out.indexOf(",") + 1));
			} catch { resolve(null); }
		};
		im.onerror = () => resolve(null); // 解码失败（如 HEIC）保留原图
		im.src = dataURL;
	});
}
function fileToImage(file) {
	return new Promise((resolve, reject) => {
		if (!/^image\//.test(file.type)) return reject(new Error("仅支持图片"));
		if (file.size > 30 * 1024 * 1024) return reject(new Error("图片超过 30MB"));
		const r = new FileReader();
		r.onload = async () => {
			const dataURL = String(r.result);
			const base64 = dataURL.slice(dataURL.indexOf(",") + 1);
			let out = { data: base64, mimeType: file.type, saved: 0 };
			if (file.type !== "image/gif") { // GIF 走 canvas 会丢动画，保留原图
				const c = await compressImage(dataURL, file.size > IMG_COMPRESS_OVER);
				if (c && c.length < base64.length) out = { data: c, mimeType: "image/jpeg", saved: base64.length - c.length };
			}
			resolve(out);
		};
		r.onerror = () => reject(new Error("读取失败"));
		r.readAsDataURL(file);
	});
}
function renderImageBar() {
	const bar = $("img-bar");
	bar.innerHTML = "";
	bar.hidden = state.images.length === 0;
	state.images.forEach((img, idx) => {
		const wrap = document.createElement("div");
		wrap.className = "img-chip";
		const im = document.createElement("img");
		im.src = `data:${img.mimeType};base64,${img.data}`;
		const x = document.createElement("span");
		x.className = "img-x";
		x.textContent = "×";
		x.title = "移除";
		x.addEventListener("click", () => { state.images.splice(idx, 1); renderImageBar(); });
		wrap.appendChild(im); wrap.appendChild(x);
		bar.appendChild(wrap);
	});
}
async function ingestFiles(files) {
	warnIfNoVision(); // P37 待办①：贴图到无视觉模型时提示
	let savedTotal = 0;
	for (const f of files) {
		try {
			const img = await fileToImage(f);
			savedTotal += img.saved ?? 0;
			state.images.push(img);
		}
		catch (e) { addSysLine(`图片添加失败: ${e.message ?? e}`, true); }
	}
	if (savedTotal > 1024 * 512) addSysLine(`🖼 已自动压缩图片，节省 ${fmtMB(savedTotal)}（最长边 2048px，利于识别与速度）`);
	renderImageBar();
}
/** P37 待办①：当前会话模型的 input 标记不含 image → 贴图前提示，防静默丢弃 */
function warnIfNoVision() {
	const m = state.session?.model;
	if (!m || !Array.isArray(m.input) || m.input.includes("image")) return;
	addSysLine(`⚠ 当前模型 ${m.name ?? m.id} 不支持图片输入，图片可能被忽略——请切换多模态模型（右下角模型选择器）`, true);
}

$("input").addEventListener("paste", (e) => {
	const files = [...(e.clipboardData?.files ?? [])].filter((f) => /^image\//.test(f.type));
	if (files.length) { e.preventDefault(); ingestFiles(files); }
});
document.addEventListener("dragover", (e) => { e.preventDefault(); });
document.addEventListener("drop", (e) => {
	e.preventDefault();
	const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /^image\//.test(f.type));
	if (files.length) ingestFiles(files);
});

/* ================= P0：右侧 Dock（标签坞：审核/预览）+ Codex 式审核面板 ================= */
const GIT_STATUS_COLOR = { M: "var(--warn, #e5c07b)", A: "#98c379", "?": "#61afef", D: "#e06c75", R: "#c678dd" };
const dock = $("dock");
const dockPanes = { review: $("dock-pane-review"), preview: $("dock-pane-preview"), terminal: $("dock-pane-terminal"), files: $("dock-pane-files"), tasks: $("dock-pane-tasks") };
let dockTab = null; // 当前打开的 pane：review | preview | terminal | files | null
let dockLastTab = "review"; // 关闭后再打开时恢复的标签

function showDock(tab) {
	dockTab = tab;
	dockLastTab = tab;
	dock.hidden = false;
	for (const [k, el] of Object.entries(dockPanes)) el.hidden = k !== tab;
	document.querySelectorAll(".dock-tab").forEach((b) => b.classList.toggle("on", b.dataset.pane === tab));
	if (tab === "review") refreshReview();
	if (tab === "preview") loadPreview();
	if (tab === "terminal") {
		$("term-cwd").textContent = state.session?.workspace ?? "—";
		$("term-cwd").title = state.session?.workspace ?? "";
	}
	if (tab === "files") initFilesPane();
	if (tab === "agents") renderAgentsPane();
	if (tab === "tasks") renderTasksPane();
}
function toggleDock(tab) {
	if (!dock.hidden && dockTab === tab) closeDock();
	else showDock(tab);
}
function closeDock() {
	dock.hidden = true;
	dockTab = null;
	document.querySelectorAll(".dock-tab").forEach((b) => b.classList.remove("on"));
}
document.querySelectorAll(".dock-tab").forEach((b) => b.addEventListener("click", () => showDock(b.dataset.pane)));
$("dock-close").addEventListener("click", closeDock);
// 顶栏已精简：审核入口 = Dock 标签 / 分支 chip / Ctrl+Shift+G
/* 右上角：显示/隐藏侧边面板（对标 Codex Ctrl+Alt+B） */
$("btn-dock").addEventListener("click", () => (dock.hidden ? showDock(dockLastTab) : closeDock()));

/* ---- 审核徽标：Agent 改文件后自动刷新（角标计数 / 面板内容） ---- */
let reviewTimer = null;
function scheduleReviewRefresh() {
	clearTimeout(reviewTimer);
	reviewTimer = setTimeout(() => {
		if (dockTab === "review" && !dock.hidden) refreshReview();
		else updateReviewBadge();
	}, 600);
}
async function updateReviewBadge() {
	if (!state.session?.workspace) { $("review-cnt").hidden = true; return; }
	try {
		const st = await window.openpi.gitStatus();
		const n = st.split("\n").filter((l) => l.trim() && !l.startsWith("##")).length;
		const cnt = $("review-cnt");
		cnt.textContent = n > 99 ? "99+" : String(n);
		cnt.hidden = n === 0;
	} catch { $("review-cnt").hidden = true; }
}

/* ---- 审核 pane：变更列表 + 逐文件 diff + 还原 / 提交 ---- */
let reviewFiles = [];
/** P34：三段式 diff——已采纳段（只读）+ 待处理段（✓采纳/↩撤销）；untracked 走纯文本 */
function renderDiffHunks(diffText, filePath) {
	const lines = diffText.split("\n");
	const blocks = [];
	let cur = null;
	let head = [];
	for (const l of lines) {
		if (l.startsWith("@@")) {
			if (cur) blocks.push(cur);
			cur = [l];
		} else if (cur) cur.push(l);
		else head.push(l);
	}
	if (cur) blocks.push(cur);
	if (!blocks.length) return `<pre class="git-pre">${escapeHtml(diffText) || "（无变更）"}</pre>`;
	return head.map((l) => `<div class="hunk-filehead">${escapeHtml(l)}</div>`).join("")
		+ blocks.map((h, i) => {
			const body = h.slice(1).join("\n");
			return `<div class="hunk" data-file="${escapeHtml(filePath)}" data-h="${i}">`
				+ `<div class="hunk-head"><code class="mono">${escapeHtml(h[0])}</code><span class="rv-actions"><button class="rv-btn hunk-stage" title="采纳：暂存此块，commit 时将包含它">✓ 采纳此块</button><button class="rv-btn hunk-revert" title="只撤销这一块的改动，其余块保留">↩ 撤销此块</button></span></div>`
				+ `<pre class="git-pre">${escapeHtml(body)}</pre></div>`;
		}).join("");
}
function renderStagedHunks(diffText, filePath) {
	const lines = diffText.split("\n");
	const blocks = [];
	let cur = null;
	let head = [];
	for (const l of lines) {
		if (l.startsWith("@@")) {
			if (cur) blocks.push(cur);
			cur = [l];
		} else if (cur) cur.push(l);
		else head.push(l);
	}
	if (cur) blocks.push(cur);
	if (!blocks.length) return "";
	return `<div class="hunk-filehead staged-tag">✓ 已采纳（将进入下次提交）</div>`
		+ head.map((l) => `<div class="hunk-filehead">${escapeHtml(l)}</div>`).join("")
		+ blocks.map((h) => `<div class="hunk staged"><div class="hunk-head"><code class="mono">${escapeHtml(h[0])}</code></div><pre class="git-pre">${escapeHtml(h.slice(1).join("\n"))}</pre></div>`).join("");
}
async function refreshReview() {
	const body = $("review-body");
	if (!state.session?.workspace) {
		body.innerHTML = '<div class="dim small" style="padding:12px">当前会话无工作区</div>';
		$("review-branch").textContent = "—";
		$("review-cnt").hidden = true;
		return;
	}
	try {
		const st = await window.openpi.gitStatus();
		const lines = st.split("\n").filter((l) => l.trim());
		$("review-branch").textContent = (lines.find((l) => l.startsWith("##")) ?? "## (无分支)").replace(/^##\s*/, "");
		$("review-mergeback").hidden = !($("review-branch").textContent || "").startsWith("openpi/");
		reviewFiles = lines.filter((l) => !l.startsWith("##")).map((l) => ({ st: l.slice(0, 2), path: l.slice(3) }));
		const ckFiles = new Set(((await window.openpi.checkpointList().catch(() => [])) ?? []).map((c) => c.file));
		updateReviewBadge();
		if (!reviewFiles.length) {
			body.innerHTML = '<div class="dim small" style="padding:12px">✓ 工作区干净，没有待审阅的变更。</div>';
			return;
		}
		body.innerHTML = `<div class="git-sec-title">变更 (${reviewFiles.length}) — 点击展开 diff</div>` + reviewFiles.map((f, i) => {
			const untracked = f.st.trim().startsWith("?");
			return `<div class="review-file" data-i="${i}">`
				+ `<span class="git-st" style="color:${GIT_STATUS_COLOR[f.st.trim()[0]] ?? "#999"}">${f.st.trim() || "??"}</span>`
				+ `<span class="path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>`
				+ `<span class="rv-actions">`
				+ (ckFiles.has(f.path) ? `<button class="rv-btn ck-restore" title="回滚 AI 对此文件的改动（恢复到 AI 首次修改前）">⏪</button>` : "")
				+ `<button class="rv-btn rv-open" title="用系统默认程序打开">打开</button>`
				+ `<button class="rv-btn danger rv-discard" title="${untracked ? "删除新文件（移入回收站，可恢复）" : "还原此文件的改动"}">还原</button></span></div>`
				+ `<pre class="git-pre" id="rv-diff-${i}" hidden></pre>`;
		}).join("");
		body.querySelectorAll(".review-file").forEach((el) => {
			const i = Number(el.dataset.i);
			const f = reviewFiles[i];
			const pre = body.querySelector(`#rv-diff-${i}`);
			el.addEventListener("click", async (ev) => {
				if (ev.target.closest(".rv-btn")) return; // 按钮事件单独处理
				if (!pre.hidden) { pre.hidden = true; el.classList.remove("active"); return; }
				body.querySelectorAll(".review-file.active").forEach((x) => x.classList.remove("active"));
				el.classList.add("active");
				pre.hidden = false;
				if (f.st.trim().startsWith("?")) {
					pre.textContent = "加载 diff…";
					try { pre.textContent = await window.openpi.gitDiffFile(f.path, true); }
					catch (e) { pre.textContent = String(e.message ?? e); }
				} else {
					try {
						const [d, stagedDiff] = await Promise.all([
							window.openpi.gitDiffFile(f.path, false),
							window.openpi.gitDiffStaged(f.path).catch(() => ""),
						]);
						pre.outerHTML = renderStagedHunks(stagedDiff, f.path) + renderDiffHunks(d, f.path);
					} catch (e) { pre.textContent = String(e.message ?? e); }
				}
			});
			el.querySelector(".rv-open").addEventListener("click", (ev) => {
				ev.stopPropagation();
				window.openpi.openWorkspaceFile(f.path).catch(() => {});
			});
			el.querySelector(".rv-discard").addEventListener("click", async (ev) => {
				ev.stopPropagation();
				const untracked = f.st.trim().startsWith("?");
				const ok = await miniConfirm("还原改动", untracked
					? `新文件「${f.path}」将移入系统回收站（可恢复）。确定？`
					: `「${f.path}」的未提交改动将被还原，无法撤销。确定？`);
				if (!ok) return;
				try {
					await window.openpi.gitDiscard(f.path);
					addSysLine(`↩ 已还原: ${f.path}`);
				} catch (e) { addSysLine(`还原失败: ${e.message ?? e}`, true); }
				refreshReview();
			});
			const ckBtn = el.querySelector(".ck-restore");
			if (ckBtn) ckBtn.addEventListener("click", async (ev) => {
				ev.stopPropagation();
				const ok = await miniConfirm("回滚 AI 改动", `「${f.path}」将恢复到 AI 首次修改前的快照。确定？`);
				if (!ok) return;
				try {
					await window.openpi.checkpointRestore(f.path);
					addSysLine(`⏪ 已回滚 AI 改动: ${f.path}`);
				} catch (err) { addSysLine(`回滚失败: ${err.message ?? err}`, true); }
				refreshReview();
			});
		});
	} catch (e) {
		const msg = String(e.message ?? e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, "");
		body.innerHTML = `<div class="dim small" style="padding:12px">🔍 ${escapeHtml(msg)}${/git 仓库/.test(msg) ? "——可先在终端执行 <code class='mono'>git init</code> 后重试" : ""}</div>`;
		$("review-cnt").hidden = true;
	}
}

$("review-refresh").addEventListener("click", refreshReview);
// P33：块级撤销 —— 事件委托挂在 #review-body 上（hunk 块随 diff 异步渲染，直接绑定会空绑）
$("review-body").addEventListener("click", async (ev) => {
	const btn = ev.target.closest(".hunk-revert");
	if (!btn) return;
	ev.stopPropagation();
	const wrap = btn.closest(".hunk");
	const file = wrap?.dataset.file;
	const h = Number(wrap?.dataset.h);
	const ok = await miniConfirm("撤销此块", `将只撤销「${file}」diff 第 ${h + 1} 块的改动，其余块保留。确定？`);
	if (!ok) return;
	try {
		await window.openpi.gitRevertHunk(file, h);
		addSysLine(`↩ 已撤销块: ${file} (第 ${h + 1} 块)`);
	} catch (e) { addSysLine(`撤销块失败: ${e.message ?? e}`, true); }
	refreshReview();
});
// P34：块级采纳（暂存进 index；commit 时只包含已采纳块）
$("review-body").addEventListener("click", async (ev) => {
	const btn = ev.target.closest(".hunk-stage");
	if (!btn) return;
	ev.stopPropagation();
	const wrap = btn.closest(".hunk");
	const file = wrap?.dataset.file;
	const h = Number(wrap?.dataset.h);
	try {
		await window.openpi.gitStageHunk(file, h);
		addSysLine(`✓ 已采纳块: ${file} (第 ${h + 1} 块) —— commit 时将包含`);
	} catch (e) { addSysLine(`采纳块失败: ${e.message ?? e}`, true); }
	refreshReview();
});
$("review-commit-btn").addEventListener("click", async () => {
	const msgEl = $("review-msg");
	const msg = msgEl.value.trim();
	if (!msg) { msgEl.placeholder = "请填写提交信息！"; msgEl.focus(); return; }
	try {
		const si = await window.openpi.gitStagedInfo().catch(() => ({ staged: false }));
		if (si.staged) {
			const go = await miniConfirm("提交已采纳块", "index 中已有采纳的块：本次只提交这些块，未采纳的改动保留在工作区。继续？");
			if (!go) return;
		}
		try {
			await window.openpi.gitCommit(msg);
			addSysLine(`🌿 已提交: ${msg}` + (si.staged ? "（仅已采纳块）" : ""));
			msgEl.value = "";
			refreshReview();
			refreshBranch();
		} catch (e) {
			const em = String(e.message ?? e);
			// git 身份未配置（实测踩到）：弹表单补配后自动重试（v0.29.1）
			if (em.includes("GIT_IDENTITY_MISSING")) {
				addSysLine("提交失败：git 还不知道你是谁（需要配置用户身份）", true);
				const ie = await miniOpen({
					title: "配置 git 身份（本仓库）",
					text: "提交记录需要作者信息。只写入当前仓库，不影响全局配置。",
					fields: ["姓名，如：张三", "邮箱，如：me@example.com"],
				});
				if (ie && ie[0] && ie[1]) {
					try {
						await window.openpi.gitSetIdentity(ie[0], ie[1]);
						addSysLine(`🪪 已写入本仓库身份: ${ie[0]} <${ie[1]}>`);
						await window.openpi.gitCommit(msg);
						addSysLine(`🌿 已提交: ${msg}` + (si.staged ? "（仅已采纳块）" : ""));
						msgEl.value = "";
						refreshReview();
						refreshBranch();
					} catch (e3) { addSysLine(`提交失败: ${e3.message ?? e3}`, true); }
				}
			} else addSysLine(`提交失败: ${em}`, true);
		}
	} catch (e) { addSysLine(`提交失败: ${e.message ?? e}`, true); }
});

/* ================= P1：终端 pane（工作区内独立执行） ================= */
const termOut = $("term-out");
const termIn = $("term-in");
let termRunningId = null;
window.openpi.onTerm((ev) => {
	if (ev.type === "data") termAppend(ev.text, ev.stream === "stderr" ? "term-err" : "");
	else {
		termAppend(`\n[进程退出 · 码 ${ev.code}]\n`, "term-exit");
		termRunningId = null;
		$("term-stop").hidden = true;
	}
});
function termAppend(text, cls = "") {
	// 欢迎行只在有内容时移除
	termOut.querySelector(".dim")?.remove();
	const el = document.createElement("div");
	el.className = "term-line" + (cls ? " " + cls : "");
	el.textContent = text.replace(/\n$/, "");
	termOut.appendChild(el);
	termOut.scrollTop = termOut.scrollHeight;
}
/* ---- 终端历史（↑↓ 翻阅，localStorage 持久化，跨会话可用） ---- */
const termHist = {
	list: [],
	idx: -1,
	draft: "", // 翻历史前未提交的输入
};
try { termHist.list = JSON.parse(localStorage.getItem("openpi-term-hist") ?? "["); } catch { termHist.list = []; }
termHist.idx = termHist.list.length;
function termHistPush(cmd) {
	if (termHist.list[termHist.list.length - 1] === cmd) { termHist.idx = termHist.list.length; return; }
	termHist.list.push(cmd);
	if (termHist.list.length > 100) termHist.list.shift();
	termHist.idx = termHist.list.length;
	try { localStorage.setItem("openpi-term-hist", JSON.stringify(termHist.list)); } catch { /* 忽略 */ }
}
function termHistNav(dir /* -1 上一条 | +1 下一条 */) {
	if (!termHist.list.length) return;
	if (dir < 0) {
		if (termHist.idx === termHist.list.length) termHist.draft = termIn.value; // 记住正在输入的
		if (termHist.idx > 0) termHist.idx--;
	} else {
		if (termHist.idx >= termHist.list.length) return;
		termHist.idx++;
	}
	termIn.value = termHist.idx >= termHist.list.length ? termHist.draft : termHist.list[termHist.idx];
	termIn.setSelectionRange(termIn.value.length, termIn.value.length);
}

async function termExec(cmd) {
	if (termRunningId) { termAppend("⚠ 已有命令在运行，先 ■ 终止或等它结束", "term-err"); return; }
	termHistPush(cmd);
	termHist.idx = termHist.list.length;
	termAppend(`› ${cmd}`, "term-cmd");
	termRunningId = "pending"; // 先占位，防止并发；exit 事件可能先于 invoke 返回
	$("term-stop").hidden = false;
	try {
		const id = await window.openpi.termRun(cmd);
		if (termRunningId === "pending") termRunningId = id; // exit 已先到时保持 null
	} catch (e) {
		termAppend(String(e.message ?? e), "term-err");
		termRunningId = null;
		$("term-stop").hidden = true;
	}
}
termIn.addEventListener("keydown", (e) => {
	if (e.key === "ArrowUp") { e.preventDefault(); termHistNav(-1); return; }
	if (e.key === "ArrowDown") { e.preventDefault(); termHistNav(1); return; }
	if (e.key === "Enter") {
		e.preventDefault();
		const cmd = termIn.value.trim();
		if (!cmd) return;
		termIn.value = "";
		termHist.draft = "";
		termExec(cmd);
	} else if (e.key === "c" && e.ctrlKey && termRunningId) {
		e.preventDefault();
		window.openpi.termKill(termRunningId);
	}
});
$("term-stop").addEventListener("click", () => termRunningId && window.openpi.termKill(termRunningId));
$("term-clear").addEventListener("click", () => { termOut.innerHTML = ""; });

/* ================= P1：文件 pane（工作区文件树 + 只读预览） ================= */
const filesTree = $("files-tree");
const filesFilter = $("files-filter");
const filesViewWrap = $("files-view-wrap");
const filesView = $("files-view");
const fstate = {
	expanded: new Set([""]), // 已展开目录（rel 路径，"" = 根）
	entries: new Map(), // relDir -> [{name, dir}]
	loadedSearch: null, // 搜索结果缓存
};
async function loadDir(rel) {
	if (fstate.entries.has(rel)) return fstate.entries.get(rel);
	const list = await window.openpi.fsList(rel).catch(() => []);
	fstate.entries.set(rel, list);
	return list;
}
async function initFilesPane() {
	filesFilter.value = "";
	fstate.loadedSearch = null;
	filesViewWrap.hidden = true;
	if (!state.session?.workspace) {
		filesTree.innerHTML = `<div class="side-empty">普通聊天不绑定项目，无文件树可看。选个工作区再试。</div>`;
		return;
	}
	window.openpi.fsWatch().catch(() => {}); // 开启工作区文件监听（幂等）
	fstate.entries.delete(""); // 强制刷新根目录，不信任旧缓存
	await loadDir("");
	renderFilesTree();
}
/* ---- 文件树自动刷新：Agent / 终端 / 外部改动文件 → fs:changed → 失效缓存 + 保留展开状态重染 ---- */
let fsRefreshTimer = null;
window.openpi.onFsChanged((_relPath) => {
	scheduleReviewRefresh(); // 顺手让审核角标也保持新鲜（bash 工具改文件也走这里）
	if (fsRefreshTimer) return; // 主进程已 500ms 防抖，这里再合并同批发送的多条事件
	fsRefreshTimer = setTimeout(async () => {
		fsRefreshTimer = null;
		const dirs = ["", ...fstate.expanded];
		for (const d of dirs) fstate.entries.delete(d); // 失效缓存（含已删目录）
		if (dockTab !== "files" || fstate.loadedSearch) return; // 面板没开/在搜索态：下次打开自动重新加载
		await Promise.all(dirs.map((d) => loadDir(d)));
		renderFilesTree();
	}, 600);
});
function fNodeEl(name, rel, isDir, depth) {
	const el = document.createElement("div");
	el.className = "f-node";
	el.style.paddingLeft = 8 + depth * 14 + "px";
	const isOpen = isDir && fstate.expanded.has(rel);
	el.innerHTML = `<span class="f-chev">${isDir ? (isOpen ? "▾" : "▸") : ""}</span><span class="f-ic">${isDir ? "📁" : "📄"}</span><span class="f-name"></span>`;
	el.querySelector(".f-name").textContent = name;
	el.title = rel;
	el.addEventListener("click", async () => {
		if (!isDir) return openFileView(rel);
		if (fstate.expanded.has(rel)) fstate.expanded.delete(rel);
		else { fstate.expanded.add(rel); await loadDir(rel); }
		renderFilesTree();
	});
	return el;
}
function renderFilesTree() {
	const render = (rel, depth, container) => {
		for (const ent of fstate.entries.get(rel) ?? []) {
			const childRel = rel ? `${rel}/${ent.name}` : ent.name;
			container.appendChild(fNodeEl(ent.name, childRel, ent.dir, depth));
			if (ent.dir && fstate.expanded.has(childRel)) render(childRel, depth + 1, container);
		}
	};
	filesTree.innerHTML = "";
	render("", 0, filesTree);
	if (!filesTree.children.length) filesTree.innerHTML = '<div class="dim small" style="padding:12px">空目录</div>';
}
async function openFileView(rel) {
	try {
		const r = await window.openpi.fsRead(rel);
		const ext = rel.toLowerCase().split(".").pop();
		const previewable = ["html", "htm", "png", "jpg", "jpeg", "gif", "svg", "webp", "pdf"].includes(ext);
		$("fv-preview").hidden = !previewable;
		$("fv-preview").dataset.rel = previewable ? rel : "";
		$("fv-path").textContent = rel + (r.truncated ? "（已截断，仅前 256KB）" : r.binary ? "（二进制文件，无法预览）" : "");
		filesView.textContent = r.binary ? "(binary)" : r.content || "（空文件）";
		filesViewWrap.hidden = false;
	} catch (e) {
		addSysLine(`读取失败: ${e.message ?? e}`, true);
	}
}
$("fv-back").addEventListener("click", () => { filesViewWrap.hidden = true; });
$("fv-preview").addEventListener("click", (e) => {
	const rel = e.currentTarget.dataset.rel;
	if (rel && state.session?.workspace) {
		navToPreviewFile(state.session.workspace.replace(/[\\/]+$/, "") + "\\" + rel); // P42：办公类先转换
		showDock("preview");
	}
});
filesFilter.addEventListener("input", async () => {
	const q = filesFilter.value.trim().toLowerCase();
	if (!q) { fstate.loadedSearch = null; renderFilesTree(); return; }
	const results = (await window.openpi.fsSearch(q).catch(() => []));
	fstate.loadedSearch = results;
	filesTree.innerHTML = "";
	if (!results.length) { filesTree.innerHTML = '<div class="dim small" style="padding:12px">无匹配文件</div>'; return; }
	for (const r of results) {
		const el = fNodeEl(r.name, r.path, r.dir, 0);
		const nameEl = el.querySelector(".f-name");
		nameEl.textContent = `${r.name}`;
		const dirEl = document.createElement("span");
		dirEl.className = "dim small";
		dirEl.style.marginLeft = "6px";
		dirEl.style.overflow = "hidden";
		dirEl.style.textOverflow = "ellipsis";
		dirEl.textContent = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
		el.appendChild(dirEl);
		filesTree.appendChild(el);
	}
});

/* ================= P19：预览 pane = 内置浏览器（网址 / 本地生成物 / dev server） ================= */
const pvWebview = $("pv-webview");
const pvUrl = $("pv-url");
const pvSize = $("pv-size");
const pvChips = $("pv-chips");
const chatTab = $("chat-tab");
const chatTabTitle = $("chat-tab-title");

/** 网址/路径规范化：补协议；Windows 绝对路径→file://；相对名→拼到当前工作区 */
function normalizeUrl(raw) {
	const s = (raw ?? "").trim();
	if (!s) return null;
	if (/^(https?|file):\/\//i.test(s)) return s;
	if (/^about:blank$/i.test(s)) return "about:blank";
	if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(s)) return "http://" + s;
	if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) return "http://" + s;
	if (/^[a-zA-Z]:[\\/]/.test(s)) {
		return "file:///" + encodeURI(s.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F");
	}
	// 相对路径：像路径（含分隔符或已知扩展名）才拼到当前工作区，否则当域名
	const pathish = /[/\\]/.test(s) || /\.(html?|png|jpe?g|gif|svg|webp|pdf|md|txt|css|js|json|mp4)$/i.test(s);
	if (state.session?.workspace && !s.startsWith("/") && pathish) {
		return normalizeUrl(state.session.workspace.replace(/[\\/]+$/, "") + "\\" + s);
	}
	return "https://" + s;
}

/** 内置浏览器导航：非 about:blank 时记入历史 chips */
/* P42：预览一个本地生成物路径（办公类先转缓存 HTML），失败不动预览区 */
async function navToPreviewFile(f) {
	const src = await previewSrcFor(f);
	if (!src) return;
	navTo(src);
}
function navTo(raw) {
	const url = normalizeUrl(raw);
	if (!url) return;
	if (url !== "about:blank") rememberPvUrl(url);
	state.previewUrl = url;
	pvUrl.value = url;
	if (pvWebview.getAttribute("src") !== url) pvWebview.setAttribute("src", url);
}

function rememberPvUrl(url) {
	state.previewUrls = [url, ...(state.previewUrls ?? []).filter((u) => u !== url)].slice(0, 8);
	renderPvChips();
}

function renderPvChips() {
	const list = state.previewUrls ?? [];
	pvChips.hidden = !list.length;
	pvChips.innerHTML = "";
	for (const u of list) {
		const b = document.createElement("button");
		b.className = "pv-chip mono";
		const label = u.replace(/^https?:\/\//, "").replace(/^file:\/\//, "");
		b.textContent = label.length > 42 ? label.slice(0, 41) + "…" : label;
		b.title = u;
		b.addEventListener("click", () => navTo(u));
		pvChips.appendChild(b);
	}
}

pvUrl.addEventListener("keydown", (e) => {
	if (e.key === "Enter") { e.preventDefault(); navTo(pvUrl.value); pvUrl.blur(); }
});
$("pv-back").addEventListener("click", () => { try { pvWebview.goBack(); } catch { } });
$("pv-fwd").addEventListener("click", () => { try { pvWebview.goForward(); } catch { } });
function syncNavBtns() {
	try {
		$("pv-back").disabled = !pvWebview.canGoBack();
		$("pv-fwd").disabled = !pvWebview.canGoForward();
	} catch { }
}
pvWebview.addEventListener("did-navigate", () => {
	pvUrl.value = pvWebview.getURL?.() ?? "";
	syncNavBtns();
});
pvWebview.addEventListener("did-navigate-in-page", syncNavBtns);

function loadPreview() {
	if (!state.previewUrl) return;
	navToPreviewFile(state.previewUrl); // P42：办公类重转换（源文件可能已更新）
}
$("pv-refresh").addEventListener("click", () => { try { pvWebview.reload(); } catch { loadPreview(); } });
$("pv-open").addEventListener("click", () => state.previewUrl && window.openpi.openExternal(state.previewUrl));
pvSize.addEventListener("change", () => {
	pvWebview.style.width = pvSize.value === "fill" ? "100%" : pvSize.value;
	pvWebview.style.margin = pvSize.value === "fill" ? "0" : "0 auto";
});

/** 从 Agent 文本/工具输出里探测本地开发服务器 + 可预览生成物（html/图片/pdf） */
const PV_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:\/[^\s"'`<>）】]*)?/gi;
const PV_FILE_RE = /[A-Za-z]:[\\/][^\s"'`<>（）】]*?\.(?:html?|png|jpe?g|gif|svg|webp|pdf|docx|xlsx|xlsm|csv|md|markdown)\b/gi;
const PV_NATIVE_RE = /\.(?:html?|png|jpe?g|gif|svg|webp|pdf)$/i; // webview 原生能看；其余（docx/xlsx/md）先转缓存 HTML
/* P42：本地文件路径 → 预览 URL（原生类型直接 file://，办公类先经主进程转换） */
async function previewSrcFor(f) {
	if (PV_NATIVE_RE.test(f)) return f;
	const r = await window.openpi.convertPreview(f).catch((err) => ({ error: String(err?.message ?? err) }));
	if (r?.error) {
		addSysLine(`⚠ 预览转换失败：${r.error}`, true);
		return null;
	}
	return r.path;
}
function maybeDetectPreview(chunk) {
	if (!chunk || typeof chunk !== "string") return;
	const fm = chunk.match(PV_FILE_RE); // 生成物优先：路径更具体
	if (fm) {
		const f = fm[0].replace(/[.,;:)）】]+$/, "");
		if (state.previewUrl !== f) {
			const first = !state.previewUrl;
			navToPreviewFile(f); // P42：办公类先转换再加载
			addSysLine(`🌐 检测到生成物 ${f} — 已在预览打开`);
			if (first && !state.previewAutoOpened) {
				state.previewAutoOpened = true;
				showDock("preview");
			}
		}
		return;
	}
	const m = chunk.match(PV_RE);
	if (!m) return;
	const url = m[0].replace(/[.,;:)）]+$/, "");
	if (state.previewUrl === url) return;
	if (!state.previewUrl) {
		addSysLine(`🌐 检测到本地服务 ${url} — 已自动打开预览`);
		navTo(url);
		// 预览被动打开：服务首次出现时自动弹出 Dock 预览
		if (!state.previewAutoOpened) {
			state.previewAutoOpened = true;
			showDock("preview");
		}
	} else {
		rememberPvUrl(url); // 多个服务：记入历史 chips，不抢当前页面
	}
}


/** 顶栏预览按钮亮绿点（检测到服务） */

/* ================= P20：技能管理 + 电脑控制 ================= */
let skillsCache = null;
async function renderSkillsPage() {
	skillsCache = await window.openpi.skillsList().catch(() => null);
	if (!skillsCache) return;
	renderCuSection();
	renderSkillList();
	renderOfficeSection();
	renderMcpSection();
}

function renderCuSection() {
	const on = !!skillsCache.cuInstalled;
	$("cu-toggle").checked = on;
	$("cu-status").textContent = on
		? "● 已连接并可用 —— 9 个工具：screenshot / click / drag / type / key / scroll / clipboard / windows+focus / wait（新会话生效）"
		: "○ 未启用";
	$("cu-status").className = "dim small " + (on ? "ok-text" : "");
}

/* ---- P25：内置办公技能状态卡 ---- */
async function renderOfficeSection() {
	const card = $("office-card");
	if (!card) return;
	const r = await window.openpi.skillsOfficeScan().catch(() => null);
	if (!r?.available) { card.classList.add("hidden"); return; }
	card.classList.remove("hidden");
	$("office-msg").textContent = "";
	const wrap = $("office-skills");
	wrap.innerHTML = "";
	for (const s of r.skills) {
		const row = document.createElement("div");
		row.className = "checkbox-row";
		row.innerHTML = s.installed
			? `<span><b class="ok-text">✓</b> <b></b></span><i class="dim small"></i>`
			: `<span><b>○</b> <b></b></span><i class="dim small"></i>`;
		row.querySelectorAll("b")[1].textContent = s.name;
		row.querySelector("i").textContent = (s.dismissed ? "已忽略（删除后不复活） · " : "") + s.zh;
		wrap.appendChild(row);
	}
}
$("btn-office-reinstall")?.addEventListener("click", async () => {
	if (!confirm("覆盖重装全部内置办公技能？你对这些技能目录的手动修改将被内置版本覆盖。")) return;
	try {
		const r = await window.openpi.skillsOfficeReinstall();
		tip($("office-msg"), `✓ 已重装：${r.installed.join("、")}`, "ok");
		skillsCache = await window.openpi.skillsList();
		renderSkillList();
		renderOfficeSection();
	} catch (err) {
		tip($("office-msg"), err.message, "err");
	}
});

/* ---- P28：MCP 服务器状态卡（设置页） ---- */
async function renderMcpSection() {
	const wrap = $("mcp-list");
	try {
		const r = await window.openpi.mcpStatus();
		if (!r.status.length) {
			wrap.innerHTML = `<span class="dim small">未配置。在 ~/.pi/agent/mcp.json 写入 mcpServers（支持 stdio：command/args/env，或 http：url/headers）。</span>`;
			return;
		}
		wrap.innerHTML = r.status.map((s) => s.ok
			? `<div><b style="color:#3fb950">●</b> <b></b> <span class="dim small"></span></div>`
			: `<div><b style="color:#f85149">✖</b> <b></b> <span class="err-text small"></span></div>`)
			.join("");
		const rows = wrap.querySelectorAll(":scope > div");
		r.status.forEach((s, i) => {
			const el = rows[i];
			el.querySelectorAll("b")[1].textContent = `${s.name}（${s.mode}）`;
			if (s.ok) el.querySelector("span").textContent = `已连接 · ${s.toolCount} 个工具`;
			else el.querySelector("span").textContent = s.error ?? "连接失败";
		});
	} catch (err) {
		wrap.innerHTML = `<span class="err-text small">状态获取失败：${err.message ?? err}</span>`;
	}
}
/* ---- P51：Hooks 配置 ---- */
$("btn-hooks-sample")?.addEventListener("click", async () => {
	try {
		const r = await window.openpi.hooksSample();
		$("hooks-msg").textContent = `已就绪：${r.path}（重启应用生效）`;
	} catch (err) { $("hooks-msg").textContent = `失败: ${err.message ?? err}`; }
});
$("btn-hooks-open")?.addEventListener("click", () => window.openpi.hooksOpen().catch(() => {}));

$("btn-audit-open")?.addEventListener("click", () => window.openpi.auditOpen().catch(() => {}));

/* ---- P47：联网检索设置（Tavily key） ---- */
(async () => {
	try {
		const s = (await window.openpi.settingsGet()) ?? {};
		if (s.web?.tavilyKey) $("tavily-key").value = s.web.tavilyKey;
	} catch { /* 主进程旧版本 */ }
})();
/* ---- P49：自动压缩开关 ---- */
(async () => {
	try {
		const r = (await window.openpi.getAutoCompact()) ?? {};
		$("auto-compact-toggle").checked = r.enabled !== false;
	} catch { /* 旧版本主进程 */ }
})();
$("auto-compact-toggle")?.addEventListener("change", async (e) => {
	const on = e.target.checked;
	try {
		await window.openpi.setAutoCompact(on);
		addSysLine(on ? "已开启自动压缩上下文" : "已关闭自动压缩上下文（接近上限时将不再自动压缩，请注意手动🗜）");
	} catch (err) {
		e.target.checked = !on;
		addSysLine(`保存失败: ${err.message ?? err}`, true);
	}
});

$("btn-web-save")?.addEventListener("click", async () => {
	const key = $("tavily-key").value.trim();
	const msg = $("web-msg");
	try {
		await window.openpi.settingsSet({ web: { tavilyKey: key } });
		msg.textContent = "已保存。新会话/重启后全局生效（当前会话的 worker 已同步）";
		msg.style.color = "var(--ok, #7ec97e)";
	} catch (err) {
		msg.textContent = `保存失败: ${err.message ?? err}`;
		msg.style.color = "var(--err, #ff7a7a)";
	}
});

/* ---- P61：生图 API 设置（baseUrl/model/key，默认智谱免配置） ---- */
(async () => {
	try {
		const s = (await window.openpi.settingsGet()) ?? {};
		if (s.image?.baseUrl) $("image-baseurl").value = s.image.baseUrl;
		if (s.image?.model) $("image-model").value = s.image.model;
		if (s.image?.apiKey) $("image-key").value = s.image.apiKey;
	} catch { /* 主进程旧版本 */ }
})();
$("btn-image-save")?.addEventListener("click", async () => {
	const msg = $("image-msg");
	try {
		await window.openpi.settingsSet({
			image: {
				baseUrl: $("image-baseurl").value.trim(),
				model: $("image-model").value.trim(),
				apiKey: $("image-key").value.trim(),
			},
		});
		msg.textContent = "已保存。新会话生效；留空的字段回落默认（智谱 CogView-4）";
		msg.style.color = "var(--ok, #7ec97e)";
	} catch (err) {
		msg.textContent = `保存失败: ${err.message ?? err}`;
		msg.style.color = "var(--err, #ff7a7a)";
	}
});

/* ---- P33：自动更新卡 ---- */
let updateState = null;
function renderUpdateCard(s) {
	if (!s) return;
	updateState = s;
	const $ = (id) => document.getElementById(id);
	if (!$("update-line")) return;
	$("update-line").textContent = `当前版本 v${s.current}` + (s.version && s.version !== s.current ? ` · 发现 v${s.version}` : "");
	$("update-hint").textContent = s.configured ? "更新源已配置（~/.pi/agent/updater.json）" : "未配置更新源 —— 点「配置更新源」创建模板并填写";
	$("btn-update-download").hidden = s.status !== "available";
	$("btn-update-install").hidden = s.status !== "ready";
	const prog = $("update-progress");
	prog.hidden = s.status !== "downloading";
	if (s.status === "downloading") $("update-progress-fill").style.width = `${s.progress}%`;
	const msg = $("update-msg");
	msg.textContent =
		s.status === "checking" ? "正在检查…" :
		s.status === "up-to-date" ? "已是最新版 ✓" :
		s.status === "downloading" ? `下载中 ${s.progress}%` :
		s.status === "ready" ? "新版已下载，点「重启并安装」完成升级" :
		s.status === "error" ? `⚠ ${s.error ?? "更新失败"}` : "";
	msg.style.color = s.status === "error" ? "var(--red, #ff6b6b)" : "";
	$("btn-update-check").disabled = s.status === "checking" || s.status === "downloading";
}
async function updateSnapshotRender() {
	try {
		renderUpdateCard(await window.openpi.updateSnapshot());
	} catch {
		/* 非主窗口等场景忽略 */
	}
}
$("btn-update-check")?.addEventListener("click", async () => {
	renderUpdateCard({ ...(updateState ?? { current: "…", configured: true }), status: "checking" });
	const r = await window.openpi.updateCheck().catch((err) => ({ ok: false, error: String(err.message ?? err) }));
	if (!r.ok) renderUpdateCard({ ...(updateState ?? { current: "…" }), status: "error", error: r.error });
	// ok 时状态由 update_state 事件推送
});
$("btn-update-download")?.addEventListener("click", () => window.openpi.updateDownload().catch(() => {}));
$("btn-update-install")?.addEventListener("click", () => window.openpi.updateInstall().catch(() => {}));
$("btn-update-config")?.addEventListener("click", () => window.openpi.updateOpenConfig().catch(() => {}));
// 设置页打开时刷新更新卡
$("btn-settings")?.addEventListener("click", () => setTimeout(updateSnapshotRender, 50));

$("btn-mcp-reconnect")?.addEventListener("click", async () => {
	const msg = $("mcp-msg");
	try {
		const r = await window.openpi.mcpReconnect();
		const okN = r.status.filter((s) => s.ok).length;
		tip(msg, `✓ 已重连 ${okN}/${r.status.length}，共 ${r.toolCount} 个工具（新会话生效）`, okN ? "ok" : "err");
	} catch (err) {
		tip(msg, err.message ?? err, "err");
	}
	renderMcpSection();
});

$("cu-toggle")?.addEventListener("change", async (e) => {
	try {
		const r = await window.openpi.computerUseSet(e.target.checked);
		skillsCache.cuInstalled = r.installed;
		renderCuSection();
	} catch (err) {
		e.target.checked = !e.target.checked;
		alert("操作失败: " + err.message);
	}
});

const SKILL_GROUP_LABEL = { managed: "已安装", disabled: "已停用", external: "外部来源" };
function renderSkillList() {
	const q = ($("skill-search").value || "").trim().toLowerCase();
	const wrap = $("skill-list");
	wrap.innerHTML = "";
	let total = 0;
	for (const group of ["managed", "disabled", "external"]) {
		const list = (skillsCache[group] ?? []).filter(
			(s) => !q || s.name.toLowerCase().includes(q) || (s.descriptionZh || s.description).toLowerCase().includes(q),
		);
		total += list.length;
		if (!list.length) continue;
		const h = document.createElement("div");
		h.className = "skill-group dim small";
		h.textContent = `${SKILL_GROUP_LABEL[group]} ${list.length}`;
		wrap.appendChild(h);
		for (const s of list) wrap.appendChild(skillRow(s, group));
	}
	$("skill-count").textContent = total ? `共 ${total} 个` : "";
	if (!total) wrap.innerHTML = `<div class="side-empty">${q ? "无匹配技能" : "还没有技能，点右上「＋ 新建」创建一个"}</div>`;
}

function skillRow(s, group) {
	const el = document.createElement("div");
	el.className = "skill-item";
	el.innerHTML = `<span class="skill-ic">🧩</span><div class="skill-txt"><b></b><p class="dim small"></p></div>`;
	el.querySelector("b").textContent = s.name;
	const desc = s.descriptionZh || s.description;
	el.querySelector("p").textContent = desc.length > 110 ? desc.slice(0, 109) + "…" : desc;
	if (s.descriptionZh) el.querySelector("b").title = s.description; // 悬停看英文原文
	el.querySelector(".skill-txt").title = s.dir;
	if (group !== "external") {
		const sw = document.createElement("label");
		sw.className = "switch";
		sw.innerHTML = `<input type="checkbox" ${group === "managed" ? "checked" : ""}/><span class="slider"></span>`;
		sw.querySelector("input").addEventListener("change", async (e) => {
			try {
				await window.openpi.skillsToggle(s.name, e.target.checked);
				skillsCache = await window.openpi.skillsList();
				renderSkillList();
			} catch (err) {
				e.target.checked = !e.target.checked;
				alert("操作失败: " + err.message);
			}
		});
		el.appendChild(sw);
		const del = document.createElement("button");
		del.className = "icon-btn skill-del";
		del.title = "删除（移到回收站）";
		del.textContent = "🗑";
		del.addEventListener("click", async () => {
			if (!confirm(`删除技能「${s.name}」？目录将移入回收站。`)) return;
			await window.openpi.skillsDelete(s.name);
			skillsCache = await window.openpi.skillsList();
			renderSkillList();
		});
		el.appendChild(del);
	} else {
		const badge = document.createElement("span");
		badge.className = "badge-dim small";
		badge.textContent = "外部";
		el.appendChild(badge);
	}
	return el;
}

$("btn-skill-refresh")?.addEventListener("click", renderSkillsPage);
$("skill-search")?.addEventListener("input", renderSkillList);
$("btn-skill-new")?.addEventListener("click", () => {
	$("skill-new-form").classList.toggle("hidden");
	$("skill-new-name").focus();
});
$("btn-skill-create")?.addEventListener("click", async () => {
	const name = $("skill-new-name").value.trim();
	const desc = $("skill-new-desc").value.trim();
	try {
		await window.openpi.skillsCreate(name, desc);
		$("skill-new-form").classList.add("hidden");
		$("skill-new-name").value = "";
		$("skill-new-desc").value = "";
		skillsCache = await window.openpi.skillsList();
		renderSkillList();
	} catch (err) {
		tip($("skill-new-msg"), err.message, "err");
	}
});
$("btn-skill-install")?.addEventListener("click", async () => {
	const url = $("skill-install-url").value.trim();
	if (!url) return tip($("skill-install-msg"), "请填 GitHub 地址", "err");
	const btn = $("btn-skill-install");
	btn.disabled = true;
	btn.textContent = "下载中…";
	tip($("skill-install-msg"), "正在从 GitHub 下载…");
	try {
		const r = await window.openpi.skillsInstall(url);
		tip($("skill-install-msg"), `✓ 安装完成：${r.installed.join("、") || "无新增（同名已存在）"}${r.found > r.installed.length ? `（仓库内共 ${r.found} 个技能）` : ""}`, "ok");
		$("skill-install-url").value = "";
		skillsCache = await window.openpi.skillsList();
		renderSkillList();
	} catch (err) {
		tip($("skill-install-msg"), err.message, "err");
	} finally {
		btn.disabled = false;
		btn.textContent = "⬇ 安装";
	}
});

/** 当前会话标题 tab */
function refreshChatTab() {
	if (!state.session) { chatTab.hidden = true; return; }
	const id = state.session.sessionId;
	const s = state.sessions.find((x) => x.id === id);
	chatTabTitle.textContent = (id && state.meta?.[id]?.title) || sTitle(s ?? { preview: "", id }) || "新会话";
	chatTab.hidden = false;
}
$("chat-tab-close").addEventListener("click", newSession);

/* P46：初始图标渲染（app.js 在 body 末尾加载，DOM 已就绪） */
/* P67：minimap 对话轨道 + 设置全局搜索（模块见文末） */
refreshIcons();

/* ================= P67-1：minimap 对话轨道 ================= */
const minimap = $("minimap"), mmSegs = $("minimap-segs"), mmVp = $("minimap-vp");
let mmRebuildTimer = null, mmDragging = false;
const mmSegClass = (el) => {
	if (el.classList.contains("user")) return "t-user";
	if (el.classList.contains("assistant")) return el.querySelector(".tool, .work") ? "t-tool" : "t-assistant";
	return "t-sys";
};
function mmRebuild() {
	mmRebuildTimer = null;
	if (!chat || chat.hidden) { minimap.hidden = true; return; }
	const scrollable = chat.scrollHeight > chat.clientHeight + 60;
	minimap.hidden = !scrollable;
	if (!scrollable) return;
	mmSegs.innerHTML = "";
	const chatRect = chat.getBoundingClientRect();
	const H = chat.scrollHeight;
	for (const el of chat.children) {
		if (el.hidden || el.classList.contains("empty-hide")) continue;
		const r = el.getBoundingClientRect();
		if (r.height < 4) continue;
		const top = ((r.top - chatRect.top + chat.scrollTop) / H) * 100;
		const h = Math.max(0.6, (r.height / H) * 100);
		if (top >= 100) continue;
		const seg = document.createElement("div");
		seg.className = "mm-seg " + mmSegClass(el);
		seg.style.top = top + "%";
		seg.style.height = h + "%";
		seg.title = (el.querySelector(".who")?.textContent ?? el.textContent ?? "").trim().slice(0, 60);
		mmSegs.appendChild(seg);
	}
	mmVpUpdate();
}
function mmVpUpdate() {
	if (minimap.hidden) return;
	mmVp.hidden = false;
	mmVp.style.top = (chat.scrollTop / chat.scrollHeight) * 100 + "%";
	mmVp.style.height = Math.max(4, (chat.clientHeight / chat.scrollHeight) * 100) + "%";
}
function mmSchedule() { if (!mmRebuildTimer) mmRebuildTimer = setTimeout(mmRebuild, 250); }
new MutationObserver(mmSchedule).observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
chat.addEventListener("scroll", mmVpUpdate, { passive: true });
window.addEventListener("resize", mmSchedule);
/* 点击/拖动轨道 → 按比例跳转 */
const mmJump = (e) => {
	const rect = minimap.getBoundingClientRect();
	const ratio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
	chat.scrollTop = ratio * (chat.scrollHeight - chat.clientHeight);
};
minimap.addEventListener("mousedown", (e) => { mmDragging = true; mmJump(e); e.preventDefault(); });
window.addEventListener("mousemove", (e) => { if (mmDragging) mmJump(e); });
window.addEventListener("mouseup", () => { mmDragging = false; });

/* ================= P67-2：设置全局搜索 ================= */
const ssInput = $("settings-search"), ssPop = $("settings-search-pop");
let ssItems = [], ssIdx = 0;
const ssTabs = () => [...document.querySelectorAll("#settings .tab")];
function ssIndex() {
	const idx = [];
	for (const tab of ssTabs()) {
		const pane = $("tab-" + tab.dataset.tab);
		if (!pane) continue;
		idx.push({ tab: tab.dataset.tab, tabLabel: tab.textContent.trim(), el: pane, title: tab.textContent.trim(), text: pane.textContent.replace(/\s+/g, " ") });
	}
	for (const card of document.querySelectorAll("#settings .tab-pane > div[id$='-card'], #settings .tab-pane > .cu-card, #settings .tab-pane > .kv-list, #settings .tab-pane > .form-grid, #settings .tab-pane > .preset-grid")) {
		const pane = card.closest(".tab-pane");
		if (!pane) continue;
		const tabBtn = ssTabs().find((t) => "tab-" + t.dataset.tab === pane.id);
		idx.push({ tab: pane.id.replace("tab-", ""), tabLabel: tabBtn?.textContent.trim() ?? "", el: card, title: card.querySelector("b")?.textContent?.trim() ?? card.id, text: card.textContent.replace(/\s+/g, " ") });
	}
	return idx;
}
function ssSnip(text, q) {
	const at = text.toLowerCase().indexOf(q);
	if (at < 0) return text.slice(0, 60);
	return (at > 0 ? "…" + text.slice(Math.max(0, at - 16), at) : "") + text.slice(at, at + 46) + "…";
}
function ssRender(q) {
	q = q.trim().toLowerCase();
	if (!q) { ssPop.hidden = true; ssItems = []; return; }
	const matches = ssIndex().filter((it) => (it.title + " " + it.text).toLowerCase().includes(q)).slice(0, 14);
	ssItems = matches;
	ssIdx = 0;
	ssPop.innerHTML = "";
	if (!matches.length) {
		ssPop.innerHTML = `<div class="ss-empty">没有匹配的设置项</div>`;
	} else {
		matches.forEach((it, i) => {
			const b = document.createElement("button");
			b.className = "ss-item" + (i === 0 ? " active" : "");
			b.innerHTML = `<span class="ss-tab"></span><span class="ss-title"></span><span class="ss-snip"></span>`;
			b.querySelector(".ss-tab").textContent = it.tabLabel;
			b.querySelector(".ss-title").textContent = it.title;
			b.querySelector(".ss-snip").textContent = ssSnip(it.text, q);
			b.addEventListener("click", () => ssGo(it));
			ssPop.appendChild(b);
		});
	}
	ssPop.hidden = false;
}
function ssGo(it) {
	ssTabs().find((t) => t.dataset.tab === it.tab)?.click();
	ssPop.hidden = true;
	ssInput.value = "";
	const el = it.el;
	setTimeout(() => {
		el.scrollIntoView({ block: "center", behavior: "smooth" });
		el.classList.remove("flash-hl");
		void el.offsetWidth; // 重启动画
		el.classList.add("flash-hl");
		setTimeout(() => el.classList.remove("flash-hl"), 1900);
	}, 60);
}
ssInput.addEventListener("input", () => ssRender(ssInput.value));
ssInput.addEventListener("keydown", (e) => {
	if (ssPop.hidden) return;
	const items = [...ssPop.querySelectorAll(".ss-item")];
	if (!items.length) return;
	if (e.key === "ArrowDown") { e.preventDefault(); ssIdx = Math.min(ssIdx + 1, items.length - 1); }
	else if (e.key === "ArrowUp") { e.preventDefault(); ssIdx = Math.max(ssIdx - 1, 0); }
	else if (e.key === "Enter") { e.preventDefault(); ssItems[ssIdx] && ssGo(ssItems[ssIdx]); return; }
	else if (e.key === "Escape") { ssPop.hidden = true; ssInput.value = ""; return; }
	else return;
	items.forEach((x, i) => x.classList.toggle("active", i === ssIdx));
	items[ssIdx]?.scrollIntoView({ block: "nearest" });
});
ssInput.addEventListener("blur", () => setTimeout(() => { ssPop.hidden = true; }, 200));

/* ================= P68：流式跟随 + 回底按钮 + lightbox + 消息操作条 ================= */
const sdBtn = $("scroll-down");
chat.addEventListener("scroll", () => {
	const gap = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
	state.stick = gap < 80; // 拉到接近底部 = 恢复跟随
	sdBtn.hidden = gap < 300;
	sdBtn.classList.toggle("live", !!state.cur && gap >= 300);
}, { passive: true });
sdBtn.addEventListener("click", () => scrollBottom(true));

/* 图片 lightbox：点击聊天中任意 img（排除头像）全屏放大，Esc/点击关闭 */
chat.addEventListener("click", (e) => {
	const img = e.target.closest?.("img");
	if (!img) return;
	$("lightbox-img").src = img.src;
	$("lightbox").hidden = false;
});
$("lightbox").addEventListener("click", () => { $("lightbox").hidden = true; });
window.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !$("lightbox").hidden) $("lightbox").hidden = true;
});

/* 消息操作条：finalize 后 hover 浮出「复制/引用」（复制全文原文，引用预填输入框） */
function mountMsgActs(c, text) {
	if (!text || !c.root) return;
	const main = c.root.querySelector(".msg-main");
	if (!main || main.querySelector(".msg-acts")) return;
	const acts = document.createElement("div");
	acts.className = "msg-acts";
	const bCopy = document.createElement("button");
	bCopy.className = "ma-btn"; bCopy.dataset.act = "copy"; bCopy.textContent = "❐ 复制"; bCopy.title = "复制全文";
	bCopy.addEventListener("click", async (e) => {
		const btn = e.currentTarget;
		try { await navigator.clipboard.writeText(text); btn.textContent = "已复制"; }
		catch { btn.textContent = "复制失败"; }
		setTimeout(() => { btn.textContent = "❐ 复制"; }, 1500);
	});
	const bQuote = document.createElement("button");
	bQuote.className = "ma-btn"; bQuote.dataset.act = "quote"; bQuote.textContent = "❝ 引用"; bQuote.title = "引用到输入框";
	bQuote.addEventListener("click", () => {
		const head = text.length > 160 ? text.slice(0, 160) + "…" : text;
		input.value = `> ${head.replace(/\n+/g, " ")}\n\n`;
		input.focus();
	});
	acts.append(bCopy, bQuote);
	main.appendChild(acts);
}
