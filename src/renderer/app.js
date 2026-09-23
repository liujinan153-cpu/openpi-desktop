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
	subagentCards: new Map(), // P72 交付1：worker.id → 聊天流内嵌协作卡 rec
	usageTotal: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	workerFeeds: new Map(), // P76 交付2：worker.id → { worker, entries[], rowByTcid }（dock「子智能体」页数据源）
	swSelected: null, // P76：当前选中的 worker id（默认跟随最新）
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
			n.parentElement?.closest("pre, .fcard, .thinking, .work-list, .steps-body, .subagent-card, .sysline")
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
	// P75：segStart=当前交付段在 c.text 中的起点（工具卡出现时，此前文本定级为「中间叙述」入过程区）
	state.cur = { root: el, bodyEl: body, cursor, text: "", segStart: 0, thinkingEl: null, thinkingText: "", startTs: Date.now() };
	state.turnAssistantEls = state.turnAssistantEls ?? [];
	state.turnAssistantEls.push(el); // P75 修复：追踪本轮 assistant 气泡，自动重试时折叠失败尝试（防「一问两答」观感）
}

/** P72 交付2：过程时间线——同一条消息内连续工具调用聚进一个可折叠容器（「⚙ 处理中 · N 个步骤」）。
    明细就是现有工具卡本身，聚合条只是它们的可折叠容器头；streaming 中默认展开，消息完成后折叠（见 collapseTools）。 */
function ensureStepsGroup(c) {
	if (c.stepsGroup) return c.stepsGroup;
	const wrap = document.createElement("div");
	wrap.className = "steps-group";
	const head = document.createElement("button");
	head.type = "button";
	head.className = "steps-head";
	head.classList.add("live"); // P75：流式期间轮次条脉冲（collapseTools 完成时撤下）
	head.innerHTML = `<span class="sg-ic"><i data-lucide="settings"></i></span><span class="sg-tx"></span><span class="chev">⌄</span>`;
	const body = document.createElement("div");
	body.className = "steps-body";
	head.addEventListener("click", () => {
		wrap.classList.toggle("collapsed");
		head.querySelector(".chev").textContent = wrap.classList.contains("collapsed") ? "›" : "⌄";
	});
	wrap.append(head, body);
	c.bodyEl.appendChild(wrap);
	c.stepsGroup = wrap;
	c.stepsTx = head.querySelector(".sg-tx");
	c.stepsBody = body;
	c.stepsCount = 0;
	return wrap;
}

	/** P75：轮次折叠条（升级 P72 steps-group 收起 + 旧 work 条）——消息完成后定格
	    「已工作 2分47秒 · N 个步骤」并默认收起（对标 ChatGPT Desktop：用时条在上、交付正文在下） */
	function collapseTools(c) {
		// P72 交付2/P75：工具卡已被 .steps-group 聚合 → 折叠聚合条本身，不再另起 work 条
		if (c.stepsGroup) {
			const gsecs = Math.max(1, Math.round((Date.now() - (c.startTs ?? Date.now())) / 1000));
			c.stepsTx.textContent = P72.turnBarLabel(c.stepsCount ?? 0, gsecs, true);
			c.stepsGroup.querySelector(".steps-head").classList.remove("live"); // P75：撤流式脉冲
			c.stepsGroup.classList.add("collapsed"); // 轮次完成默认收起（点击条展开过程区）
			c.stepsGroup.querySelector(".chev").textContent = "›";
			c.bodyEl.before(c.stepsGroup); // P75：轮次条移到交付正文上方
			return;
		}
		const tools = [...c.bodyEl.querySelectorAll(":scope > .tool")];
		if (!tools.length) return;
		const secs = Math.max(1, Math.round((Date.now() - (c.startTs ?? Date.now())) / 1000));
		const wrap = document.createElement("div");
		wrap.className = "work";
		const bar = document.createElement("button");
		bar.className = "work-bar";
		bar.innerHTML = `<span class="w-ic"><i data-lucide="settings"></i></span><span class="w-tx">${P72.turnBarLabel(tools.length, secs, true)}</span><span class="chev">›</span>`;
		const list = document.createElement("div");
		list.className = "work-list";
		list.classList.add("hidden");
		bar.addEventListener("click", () => {
			list.classList.toggle("hidden");
			bar.querySelector(".chev").textContent = list.classList.contains("hidden") ? "›" : "⌄";
		});
		wrap.append(bar, list);
		c.bodyEl.before(wrap); // P75：与轮次条同位（交付正文上方）
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

	/** 流式期间: 交付段文本 + 光标（避免每 token 重排版），结束后整体转 Markdown。
	    P75：bodyEl 只渲染「交付段」（最后一次工具调用之后的文本）；轮次条+过程区置顶，不被清空吞掉 */
	function renderStreamingBody() {
		const c = state.cur;
		if (!c) return;
		c.bodyEl.textContent = ""; // 清空重建（steps-group 引用保留在 c 上，随后挂回——顺带修掉文本 delta 吞工具卡的隐患）
		if (c.stepsGroup) c.bodyEl.appendChild(c.stepsGroup); // P75：轮次条+过程区置于交付正文之上
		c.bodyEl.appendChild(document.createTextNode((c.text ?? "").slice(c.segStart ?? 0)));
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
	let text = (c.text ?? "").slice(c.segStart ?? 0); // P75：交付区只吃最终段（中间叙述已在过程区）
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
	const hasWork = !!c.root.querySelector(".work") || !!c.stepsGroup; // P72：steps-group 聚合条也算工作痕迹
	const hasThinking = !!c.thinkingEl && c.bodyEl.contains(c.thinkingEl);
	if (!text && hasWork) c.root.classList.add("toolonly");
	else if (!text && !hasThinking && !hasWork) c.root.remove(); // 完全空轮次直接移除
	if (state.streaming) c.root.dataset.p75Done = "1"; // P75：实时轮次内完结的消息可被下一张工具卡收编为中间叙述（恢复的历史消息不标记）
	mountMsgActs(c, c.text || text); // P68：hover 复制/引用操作条（P75：复制仍给全文，含中间叙述）
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

/** P75：工具卡出现 → 此前的文本段定级为「中间叙述」，转为过程区段落（流式期间过程区实时可见）。
    注：SDK 单条消息内 text→tool 交错时才走本函数；每消息独立气泡的场景由 demotePrevNarration 收编 */
function flushNarration(c) {
	const seg = (c.text ?? "").slice(c.segStart ?? 0);
	c.segStart = (c.text ?? "").length; // 之后的文本 = 交付段
	if (!seg.trim()) return;
	ensureStepsGroup(c);
	const el = document.createElement("div");
	el.className = "proc-text";
	el.textContent = seg;
	c.stepsBody.appendChild(el); // 时序：紧随其后的工具卡排在本段之后
}

/** P75：SDK 每条 assistant 消息独立成气泡（message_end 先于 tool_execution_start）——
    工具卡开新气泡时，把上一条已完结的纯文本消息（同轮中间叙述）收编进本气泡过程区并移除原气泡；
    最后一消息的交付文本不会被走到（其后无工具卡），保持始终可见 */
function demotePrevNarration(root, c) {
	let prev = root.previousElementSibling;
	while (prev && (prev.classList.contains("sysline") || prev.dataset?.worker)) prev = prev.previousElementSibling; // 跳过系统行/子代理协作卡
	if (!prev || !prev.classList.contains("assistant") || prev.dataset.p75Done !== "1") return;
	const body = prev.querySelector(".body");
	if (!body || body.classList.contains("empty-hide") || body.querySelector(".steps-group, .work, .tool")) return;
	const clone = body.cloneNode(true);
	clone.querySelector(".thinking")?.remove(); // 思考条不进过程区（P66 行为不变）
	clone.querySelector(".msg-acts, .retry-chip")?.remove();
	const text = clone.textContent.trim();
	if (!text) return;
	const el = document.createElement("div");
	el.className = "proc-text";
	el.textContent = text;
	c.stepsBody.appendChild(el); // 时序：本工具卡之前
	prev.remove();
}

/** P75：工具卡标题带对象——edit/write 类「已编辑 <basename>」，bash/run 类「已运行命令」，其余保持工具名 */
function toolTitle(name, args) {
	const n = String(name ?? "");
	const p = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
	if ((n === "write" || n === "apply_patch") && p) {
		const base = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
		if (base) return `已创建 ${base}`; // 严格对标截图：新建文件「已创建 x.ts」
	}
	if (n === "edit" && p) {
		const base = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
		if (base) return `已编辑 ${base}`;
	}
	if (n === "bash" || n === "powershell" || n === "run_cmd" || n === "run") return "已运行命令";
	return n;
}

// P75 严格对标截图：连续的工具卡合并成一条组行（「编辑了文件运行了命令 ›」），点击展开逐条；
// 合并类别：edit/write/apply_patch=「编辑了文件」，bash/powershell/run_cmd/run=「运行了命令」；其余工具不合并
function toolMergeCat(name) {
	const n = String(name ?? "");
	if (n === "edit" || n === "write" || n === "apply_patch") return "edit";
	if (n === "bash" || n === "powershell" || n === "run_cmd" || n === "run") return "run";
	return "";
}
function mergeGroupLabel(cats) {
	return [...cats].map((c) => (c === "edit" ? "编辑了文件" : "运行了命令")).join("");
}
function appendToolToSteps(c, card, name) {
	const cat = toolMergeCat(name);
	const body = c.stepsBody;
	if (!cat) { body.appendChild(card); return; }
	const last = body.lastElementChild;
	if (last && last.classList?.contains("tool-merge")) {
		// 连续同类段：并入现有组（跨 edit/run 混合也可，如截图「编辑了文件运行了命令」）
		last.querySelector(".tm-body").appendChild(card);
		if (!last.dataset.cats.includes(cat)) last.dataset.cats += `,${cat}`;
		last.querySelector(".tm-tx").textContent = mergeGroupLabel(new Set(last.dataset.cats.split(",")));
		return;
	}
	const wrap = document.createElement("div");
	wrap.className = "tool-merge";
	wrap.dataset.cats = cat;
	const head = document.createElement("button");
	head.type = "button";
	head.className = "tm-head";
	head.innerHTML = `<span class="tm-ic"><i data-lucide="${cat === "edit" ? "file-pen" : "terminal"}"></i></span><span class="tm-tx">${mergeGroupLabel(new Set([cat]))}</span><span class="chev">›</span>`;
	head.addEventListener("click", () => {
		const open = wrap.classList.toggle("open");
		head.querySelector(".chev").textContent = open ? "⌄" : "›";
	});
	const tmBody = document.createElement("div");
	tmBody.className = "tm-body";
	tmBody.appendChild(card);
	wrap.append(head, tmBody);
	body.appendChild(wrap);
	refreshIcons();
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
	// P75：标题带对象（edit/write 带 basename，bash/run「已运行命令」）
	head.innerHTML = `<span class="name"><i data-lucide="wrench"></i> ${escapeHtml(toolTitle(name, args))}</span>
		<span class="arg-preview">${escapeHtml(String(args?.path ?? args?.command ?? argStr).replace(/\s+/g, " ").slice(0, 80))}</span>
		<span class="st run">运行中…</span>`;
	const argsEl = document.createElement("div");
	argsEl.className = "args";
	argsEl.textContent = argStr.slice(0, 2000);
	const outEl = document.createElement("div");
	outEl.className = "out";
	card.append(head, argsEl, outEl);
	const c = ensureBubble();
	flushNarration(c); // P75：先落中间叙述段再挂工具卡（保持时序；单消息内 text→tool 交错场景）
	ensureStepsGroup(c); // P72 交付2：连续工具调用聚合进时间线容器
	demotePrevNarration(c.root, c); // P75：上一条纯文本消息收编为中间叙述（SDK 每消息独立气泡）
	appendToolToSteps(c, card, name); // P75 严格对标截图：连续工具卡并组（「编辑了文件运行了命令 ›」）
	c.stepsCount = (c.stepsCount ?? 0) + 1;
	// P75：流式期间轮次条强制展开（用户中途手折 → 新步骤到来重新展开）
	c.stepsGroup.classList.remove("collapsed");
	c.stepsGroup.querySelector(".chev").textContent = "⌄";
	renderStreamingBody(); // P75：叙述段已入过程区 → 交付区立即重渲染避免重复
	c.stepsTx.textContent = P72.turnBarLabel(c.stepsCount, 0, false);
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

/* ================= P72 交付1：Subagent 协作卡（聊天流内嵌） ================= */
/* 数据源：主进程 worker_update 事件（agent-host.mjs 推送 worker 快照：id/role/task/status/steps/model/started/endedAt）。
   卡片按事件到达时序插入聊天流（触发它的用户消息之后、worker 结论消息之前），状态变化原位更新。 */
function clearSubagentCards() {
	for (const rec of state.subagentCards.values()) if (rec.timer) clearInterval(rec.timer);
	state.subagentCards.clear();
}

function renderSubagentCard(w) {
	if (!w?.id) return;
	let rec = state.subagentCards.get(w.id);
	if (!rec) {
		removeWelcome();
		rec = buildSubagentCard(w);
		state.subagentCards.set(w.id, rec);
		chat.appendChild(rec.root);
		pinLiveBar(); // 卡片别盖住钉底的活性指示条
		refreshIcons();
		scrollBottom();
	} else {
		rec.worker = w;
	}
	updateSubagentCard(rec, w);
}

function buildSubagentCard(w) {
	const root = document.createElement("div");
	root.className = "subagent-card";
	root.dataset.worker = w.id;
	root.innerHTML = `
		<button type="button" class="sa-head">
			<span class="sa-ic"><i data-lucide="bot"></i></span>
			<span class="sa-status"></span>
			<span class="sa-stats"></span>
			<span class="chev">⌄</span>
		</button>
		<div class="sa-body">
			<div class="sa-node">
				<div class="sa-avatar">✦</div>
				<div class="sa-role">主 Agent</div>
				<div class="sa-task">派发子任务</div>
			</div>
			<div class="sa-wire" aria-hidden="true"></div>
			<div class="sa-node sa-child">
				<div class="sa-avatar">◇</div>
				<div class="sa-role"></div>
				<div class="sa-task"></div>
				<div class="sa-badges"><span class="sa-model hidden"></span><span class="sa-spin"></span></div>
			</div>
		</div>`;
	const rec = {
		root, worker: w,
		status: root.querySelector(".sa-status"),
		stats: root.querySelector(".sa-stats"),
		chev: root.querySelector(".sa-head .chev"),
		role: root.querySelector(".sa-child .sa-role"),
		task: root.querySelector(".sa-child .sa-task"),
		model: root.querySelector(".sa-model"),
		spin: root.querySelector(".sa-spin"),
		timer: setInterval(() => { if (rec.worker) rec.stats.textContent = P72.subagentStats(rec.worker); }, 1000), // 耗时跳动，完成后定格
		manual: false, // 用户手动展开过 → 不再自动折叠
	};
	rec.role.textContent = w.role ?? "worker";
	rec.task.textContent = w.task ?? "";
	rec.task.classList.toggle("hidden", !w.task);
	root.querySelector(".sa-head").addEventListener("click", () => {
		if (!root.classList.contains("finished")) return; // 运行中头部只读；完成后可点击折叠/展开回看
		rec.manual = true;
		root.classList.toggle("collapsed");
		rec.chev.textContent = root.classList.contains("collapsed") ? "›" : "⌄";
	});
	// P76：点协作卡的 worker 节点 → 打开 dock「子智能体」页并选中该 worker（可选联动，从简实现）
	root.querySelector(".sa-child").addEventListener("click", () => {
		showDock("subagents");
		selectWorker(w.id);
	});
	return rec;
}

function updateSubagentCard(rec, w) {
	const st = P72.subagentStatus(w.status);
	rec.status.textContent = st.label;
	rec.status.className = `sa-status ${st.cls}`;
	rec.root.dataset.status = w.status ?? "";
	rec.model.textContent = w.model ?? "";
	rec.model.classList.toggle("hidden", !w.model); // 模型徽标：主进程拿得到才显示，拿不到不造假
	rec.stats.textContent = P72.subagentStats(w);
	rec.spin.classList.toggle("hidden", P72.subagentTerminal(w.status));
	if (P72.subagentTerminal(w.status)) {
		if (rec.timer) { clearInterval(rec.timer); rec.timer = null; } // 耗时定格
		rec.root.classList.add("finished");
		// P72 折叠策略：完成/取消默认折叠，失败保持展开（用户要看原因）；手动展开过的不动
		if (!rec.manual && P72.subagentShouldAutoCollapse(w.status)) {
			rec.root.classList.add("collapsed");
			rec.chev.textContent = "›";
		}
		scrollBottom();
	}
}

/* ================= P76 交付2：dock「子智能体」页（worker 动作流水） ================= */
/* 数据源：主进程 worker_activity 事件（agent-host.mjs #runWorker 订阅转发，p76-activity.mjs 构造摘要）。
   左列 worker 列表（新 worker 插头部），右列选中 worker 的动作流水；页不可见时只存数据，切进来一次性渲染。 */
const swListEl = $("sw-list");
const swFeedEl = $("sw-feed");
const SW_ICONS = { "编辑": "file-pen", "运行": "terminal", "读取": "file-text", "搜索": "search" };

function swFeedVisible() {
	return typeof dockTab === "string" && dockTab === "subagents" && !dock.hidden;
}

function swTitleIcon(title) {
	const head = String(title ?? "").split(" ")[0];
	return SW_ICONS[head] ?? "wrench";
}

function fmtMs(ms) {
	const n = Number(ms);
	if (!Number.isFinite(n) || n < 0) return "";
	return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

/** 会话切换清空（resumeSession / resetChat 与 clearSubagentCards 同点调用） */
function clearWorkerFeeds() {
	state.workerFeeds.clear();
	state.swSelected = null;
	renderSwList();
	renderSwFeed();
	updateSwBadge();
}

function updateSwBadge() {
	let n = 0;
	for (const f of state.workerFeeds.values()) if (f.worker?.status === "running") n++;
	const el = $("subagents-cnt");
	if (!el) return;
	el.textContent = n > 99 ? "99+" : String(n);
	el.hidden = n === 0;
}

/** worker_update → 数据层登记（新 worker 入 Map；列表/徽标刷新；新 worker 默认选中） */
function trackWorkerInFeed(w) {
	if (!w?.id || !swListEl) return;
	let feed = state.workerFeeds.get(w.id);
	const isNew = !feed;
	if (feed) {
		feed.worker = w;
		// worker 终态：仍在转的行（没等到 tool_end 的）把 spinner 摘掉，不假转
		if (P72.subagentTerminal(w.status)) {
			for (const en of feed.entries) {
				if (en.ok != null || !en.el) continue;
				en.el.querySelector(".sw-flag").innerHTML = `<span class="sw-ms">—</span>`;
			}
		}
	} else {
		state.workerFeeds.set(w.id, { worker: w, entries: [], rowByTcid: new Map() });
	}
	renderSwList();
	updateSwBadge();
	if (isNew) selectWorker(w.id); // 默认选最新的 worker
}

function renderSwList() {
	if (!swListEl) return;
	swListEl.innerHTML = "";
	if (!state.workerFeeds.size) {
		swListEl.innerHTML = `<div class="sw-pad dim small">暂无 worker</div>`;
		return;
	}
	for (const [id, f] of [...state.workerFeeds].reverse()) { // 新 worker 插列表头
		const st = P72.subagentStatus(f.worker.status);
		const item = document.createElement("button");
		item.type = "button";
		item.className = "sw-item";
		item.dataset.worker = id;
		item.innerHTML = `<span class="sw-dot ${st.cls}"></span><span class="sw-role">${escapeHtml(f.worker.role ?? "worker")}</span>`
			+ `<span class="sw-st ${st.cls}">${escapeHtml(st.label)}</span>`
			+ `<span class="sw-meta">${escapeHtml(P72.subagentStats(f.worker))}</span>`;
		item.addEventListener("click", () => selectWorker(id));
		swListEl.appendChild(item);
	}
}

function selectWorker(id) {
	state.swSelected = id;
	for (const el of swListEl.querySelectorAll(".sw-item")) el.classList.toggle("on", el.dataset.worker === id);
	renderSwFeed();
}

/** dock 页打开/切换 worker 时整区重绘；平时只在页可见时增量追加 */
function renderSubagentsPane() {
	renderSwList();
	renderSwFeed();
}

function renderSwFeed() {
	if (!swFeedEl) return;
	swFeedEl.innerHTML = "";
	const feed = state.workerFeeds.get(state.swSelected);
	if (!feed) {
		swFeedEl.innerHTML = `<div class="sw-pad dim small sw-empty">暂无子智能体。在对话中派发子任务后，这里实时展示每个 worker 的动作流水。</div>`;
		return;
	}
	if (!feed.entries.length) {
		swFeedEl.innerHTML = `<div class="sw-pad dim small">（暂无动作记录）</div>`;
		return;
	}
	for (const en of feed.entries) swFeedEl.appendChild(swRow(feed, en));
	swFeedEl.scrollTop = swFeedEl.scrollHeight;
}

/** 一行动作：[图标][标题][detail][右侧 徽标/耗时]；运行中带 spinner，tool_end 原位补 ✓/✗+耗时 */
function swRow(feed, en) {
	const row = document.createElement("div");
	row.className = "sw-row";
	const det = en.detail ? `<span class="sw-detail">${escapeHtml(en.detail)}</span>` : "";
	const flag = en.ok != null ? swEndFlag(en, en.ok, en.ms) : `<span class="sw-spin"></span>`; // 重绘时已结束的行直接带徽标
	if (en.ok != null) row.classList.add("ended");
	row.innerHTML = `<span class="sw-ic"><i data-lucide="${swTitleIcon(en.title)}"></i></span>`
		+ `<span class="sw-title">${escapeHtml(en.title)}</span>${det}`
		+ `<span class="sw-flag">${flag}</span>`;
	en.el = row; // 持有引用：tool_end 到达时原位补徽标；FIFO 淘汰时顺带移除 DOM
	feed.rowByTcid.set(en.toolCallId, row);
	return row;
}

function swEndFlag(en, ok, ms) {
	const t = fmtMs(ms ?? en.ms);
	return ok ? `<span class="sw-ok">✓</span>${t ? `<span class="sw-ms">${escapeHtml(t)}</span>` : ""}`
		: `<span class="sw-bad">✗</span>${t ? `<span class="sw-ms">${escapeHtml(t)}</span>` : ""}`;
}

/** worker_activity 事件入口：tool 存数据+增量渲染；tool_end 找原行补徽标 */
function handleWorkerActivity(e) {
	const feed = state.workerFeeds.get(String(e?.id ?? ""));
	if (!feed) return;
	if (e.kind === "tool_end") {
		const tcid = String(e.toolCallId ?? "");
		const en = feed.entries.findLast?.((x) => x.toolCallId === tcid && x.ok == null);
		if (en) { en.ok = !!e.ok; en.ms = e.ms ?? null; }
		const row = feed.rowByTcid.get(tcid);
		if (row) {
			row.querySelector(".sw-flag").innerHTML = swEndFlag(en ?? { ms: e.ms }, !!e.ok, e.ms);
			row.classList.add("ended");
		}
		return;
	}
	const en = { kind: e.kind ?? "tool", title: e.title ?? "", detail: e.detail ?? "", toolCallId: String(e.toolCallId ?? ""), ts: e.ts ?? Date.now(), ok: null, ms: null, el: null };
	feed.entries.push(en);
	if (feed.entries.length > 300) { // 每 worker 上限 300 条 FIFO（含 DOM 同步淘汰）
		const old = feed.entries.shift();
		if (old?.el) old.el.remove();
	}
	if (swFeedVisible() && state.swSelected === String(e.id ?? "")) {
		swFeedEl.querySelector(".sw-pad")?.remove();
		swFeedEl.appendChild(swRow(feed, en));
		swFeedEl.scrollTop = swFeedEl.scrollHeight; // 流水对标 tail：新动作贴底
		refreshIcons();
	}
}
/* ================= 用量与状态 ================= */
function renderUsage() {
	const u = state.usageTotal;
	usageEl.textContent = `in ${fmt(u.input)} (cache ${fmt(u.cacheRead)}) · out ${fmt(u.output)}` +
		(u.cost > 0.0005 ? ` · $${u.cost.toFixed(u.cost < 1 ? 3 : 2)}` : ""); // P48：已知单价模型才有成本
	usageEl.title = `本会话累计\n输入 ${u.input ?? 0} tok（cache 读 ${u.cacheRead ?? 0} / 写 ${u.cacheWrite ?? 0}）\n输出 ${u.output ?? 0} tok\n成本约 $${(u.cost ?? 0).toFixed(4)}（按模型单价估算）`;
	// P72b：composer 状态条「⚡ 12.3k tok」会话累计指示（k 缩写；无数据隐藏，不显示百分比——context 上限另见 ctx 仪表）
	const tokTotal = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
	const tokEl = $("tok-indicator");
	tokEl.hidden = !tokTotal;
	tokEl.textContent = `⚡ ${P72.fmtTokCompact(tokTotal)} tok`;
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
		// UI v3.1：置顶分区置顶展示（跨项目），置顶项不再重复出现在各项目组内
		const projPins = list.filter((s) => s.cwd && !isTaskS(s) && state.meta?.[s.id]?.pinned);
		if (projPins.length) {
			const gt = document.createElement("div");
			gt.className = "group-title";
			gt.textContent = "置顶";
			sessionList.appendChild(gt);
			for (const s of projPins) sessionList.appendChild(mkItem(s, false));
		}
		const groups = new Map();
		for (const s of pinned(list)) {
			if (!s.cwd || isTaskS(s) || state.meta?.[s.id]?.pinned) continue;
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
			if (!groups.size && !projPins.length) {
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
	refreshIcons(); // 修复：项目头里的 folder 图标是动态插入的，重渲染后必须重扫才转成 SVG（否则永远不显示）
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
	clearSubagentCards(); // P72：换会话时旧协作卡连同计时器一起清理
	state.usageTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	clearWorkerFeeds(); // P76：dock「子智能体」页流水与列表随会话一起清空
	renderUsage();
	state.ctx = null; // 恢复会话的上下文占用未知，等首条 usage 事件重算
	setStatus("恢复会话…");
	try {
		const info = await window.openpi.resume(file);
		const isTask = !!state.meta?.[info.sessionId]?.task; // 任务会话：恢复时不绑定项目
		state.session = { ...info, workspace: isTask ? null : info.workspace ?? null, task: isTask };
		if (typeof onSessionSwitched === "function") onSessionSwitched(); // P72b：切会话刷新改动审阅面板（面板开着才拉）
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
		syncWelcomeTitle(); // UI v3.1：欢迎页标题随工作区
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

		case "agent_recovering":
			setStreaming(false);
			setStatus("Agent 进程恢复中…");
			break;

		case "agent_recovered":
			setStreaming(false);
			setStatus(`已恢复 · ${state.session?.model?.id ?? ""}`);
			if (state.lastPrompt) {
				const c = newAssistantBubble();
				appendText("Agent 进程已恢复；刚才中断的请求没有自动重放，以避免重复执行工具。\n\n");
				mountRetryChip(c);
			}
			break;

		case "agent_recovery_failed":
			setStreaming(false);
			setStatus("Agent 恢复失败");
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

		case "worker_update": // P72 交付1：worker 生命周期 → 聊天流内嵌协作卡（派发/运行/完成/失败/取消原位更新）
			renderSubagentCard(e.worker);
			trackWorkerInFeed(e.worker); // P76：同步 dock「子智能体」页左列表 + 徽标
			break;
		case "worker_activity": // P76 交付2：worker 动作流水（start 行 / end 补 ✓✗+耗时）
			handleWorkerActivity(e);
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
		case "auto_retry_start":
			addSysLine(`⚠ 瞬时错误，${(e.delayMs / 1000).toFixed(0)}s 后自动重试 (${e.attempt}/${e.maxAttempts})`, true);
			discardFailedAttempt(); // P75 修复：移除本轮已渲染的失败尝试气泡——一次问答只留一个回答气泡（对标 ChatGPT）
			break;
		case "auto_retry_end":
			addSysLine(e.success ? "✓ 重试成功" : `✗ 重试失败: ${e.finalError ?? ""}`, !e.success);
			break;
			addSysLine(e.success ? "✓ 重试成功" : `✗ 重试失败: ${e.finalError ?? ""}`, !e.success);
			break;

		case "thinking_level_changed":
			thinkingSelect.value = e.level;
			break;
	}
}

// P75 修复：瞬时错误自动重试时，移除本轮已渲染的失败尝试气泡（一次问答只留一个回答气泡，对标 ChatGPT）。
// 失败尝试的内容不保留——「⚠ 瞬时错误 / ✓ 重试成功」系统行已足够解释发生了什么。
function discardFailedAttempt() {
	const els = state.turnAssistantEls ?? [];
	state.turnAssistantEls = [];
	for (const el of els) {
		try { el?.remove(); } catch { /* 已被移除 */ }
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
	state.turnAssistantEls = []; // P75 修复：新一轮的 assistant 气泡追踪归零（自动重试时按本轮折叠移除）
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
	clearSubagentCards(); // P72：协作卡计时器清干净，避免跨会话泄漏
	clearWorkerFeeds(); // P76：协作卡与 dock 流水一起清干净，避免跨会话泄漏
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
	syncWelcomeTitle(); // UI v3.1：标题带工作区名（Codex 式）
	refreshIcons(); // P46：欢迎卡图标
}
/* UI v3.1：欢迎页标题随工作区变化（无工作区 = 通用文案） */
function syncWelcomeTitle() {
	const h1 = document.querySelector("#welcome h1");
	if (!h1) return;
	const ws = (workspaceLabel.textContent || "").trim();
	const generic = !ws || ws === "不在项目中工作" || ws === "选择文件夹";
	h1.textContent = generic ? "今天想做点什么？" : `想在 ${ws} 中做点什么？`;
}
chat?.addEventListener?.("click", (e) => {
	const btn = e.target.closest(".w-task");
	if (!btn) return;
	input.value = btn.dataset.q ?? "";
	autoGrow();
	input.focus();
});

/* ================= 启动流程 ================= */
/* P76 交付3：会话模型下拉 —— localStorage op-model-pins 勾选的进「★ 常用」段，其余进「其他」；
   一个都没勾 = 维持原行为（按供应商分组全量展示）。末尾追加「⚙ 管理展示列表…」入口
   （放最后不占 selectedIndex=0，兼容 e2e-m3 等既有用法；change 监听里对 __manage__ 特判）。 */
const MODEL_PINS_KEY = "op-model-pins";
function opPinsGet() {
	try { return JSON.parse(localStorage.getItem(MODEL_PINS_KEY) ?? "[]"); }
	catch { return []; }
}
function opPinsSet(arr) {
	try { localStorage.setItem(MODEL_PINS_KEY, JSON.stringify(arr)); } catch { /* 隐身模式等场景尽力而为 */ }
}
function mkModelOption(m, pinned) {
	const o = document.createElement("option");
	o.value = `${m.provider}/${m.id}`;
	o.textContent = `${pinned ? "★ " : ""}${m.name} · ${m.contextWindow ? fmtWin(m.contextWindow) : "上下文未知"}`; // ★ 前缀保持「 · 窗口」结尾（e2e-p385 场景⑦ $ 锚点）
	return o;
}
function appendManageOption() {
	const o = document.createElement("option");
	o.value = "__manage__";
	o.textContent = "⚙ 管理展示列表…";
	modelSelect.appendChild(o);
}
function populateModels(models) {
	state.models = models;
	modelSelect.innerHTML = "";
	const byValue = new Map(models.map((m) => [`${m.provider}/${m.id}`, m]));
	const pins = opPinsGet().filter((v) => byValue.has(v)); // 过滤掉已失效的模型
	if (!pins.length) {
		const groups = new Map(); // 原行为：按供应商分组全量展示
		for (const m of models) {
			if (!groups.has(m.provider)) groups.set(m.provider, []);
			groups.get(m.provider).push(m);
		}
		for (const [provider, list] of groups) {
			const og = document.createElement("optgroup");
			og.label = provider;
			for (const m of list) og.appendChild(mkModelOption(m, false));
			modelSelect.appendChild(og);
		}
	} else {
		const ogP = document.createElement("optgroup");
		ogP.label = "★ 常用";
		for (const v of pins) ogP.appendChild(mkModelOption(byValue.get(v), true));
		const ogO = document.createElement("optgroup");
		ogO.label = "其他";
		for (const m of models) {
			if (pins.includes(`${m.provider}/${m.id}`)) continue;
			ogO.appendChild(mkModelOption(m, false));
		}
		modelSelect.append(ogP, ogO);
	}
	appendManageOption();
}

/* P76 交付3：管理弹窗（轻量多选，勾选即存 localStorage 并刷新下拉） */
function openModelPinsModal() {
	const mask = $("model-pins-mask"), list = $("model-pins-list");
	if (!mask || !list) return;
	const pins = opPinsGet();
	list.innerHTML = "";
	for (const m of state.models) {
		const v = `${m.provider}/${m.id}`;
		const row = document.createElement("label");
		row.className = "mp-row";
		row.innerHTML = `<input type="checkbox" ${pins.includes(v) ? "checked" : ""} /><span class="mp-name"></span><span class="mp-provider"></span>`;
		row.querySelector(".mp-name").textContent = m.name;
		row.querySelector(".mp-provider").textContent = `${m.provider}/${m.id}`;
		row.querySelector("input").addEventListener("change", (e) => {
			const cur = opPinsGet();
			const next = e.target.checked ? [...cur, v] : cur.filter((x) => x !== v);
			opPinsSet(next);
			populateModels(state.models); // 勾选即时生效
		});
		list.appendChild(row);
	}
	mask.classList.remove("hidden");
}
$("btn-model-pins-close")?.addEventListener("click", () => $("model-pins-mask").classList.add("hidden"));
$("model-pins-mask")?.addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.classList.add("hidden"); });

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
		syncWelcomeTitle(); // UI v3.1：欢迎页标题随工作区
		if (typeof onSessionSwitched === "function") onSessionSwitched(); // P72b：切会话刷新改动审阅面板（面板开着才拉）
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
	if (!sources.length) { addSysLine("未检测到可导入的外部会话（支持：Claude Code / Codex / OpenCode）", true); return; }
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

/* ---- 主题切换（暗 ↔ 亮，记忆在 localStorage；P74 扩展三档：跟随系统/浅色/深色） ---- */
const themeBtn = $("btn-theme");
const mqDark = matchMedia("(prefers-color-scheme: dark)"); // P74：跟随系统档监听系统深浅色变化
function resolveTheme(t) { return t === "system" ? (mqDark.matches ? "dark" : "light") : t; }
function applyTheme(t) {
	localStorage.setItem("op-theme", t); // 图标由 CSS 按 data-theme 切换（P46）；CSS 只认 light/dark，system 在此解析
	document.documentElement.dataset.theme = resolveTheme(t);
}
themeBtn.addEventListener("click", () => {
	const cur = localStorage.getItem("op-theme") || "dark";
	applyTheme(resolveTheme(cur) === "light" ? "dark" : "light"); // system 档下从生效色开始切换到手动档
});
mqDark.addEventListener?.("change", () => { // P74：system 档下系统切换深浅色时实时跟随
	if ((localStorage.getItem("op-theme") || "dark") === "system") applyTheme("system");
});
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
const TASK_STATUS_LABEL = { running: "运行中", done: "完成", error: "失败", cancelled: "已取消" };
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
			if (t.status === "running") { // P69：取消通道（.abort worker session → 状态变 cancelled）
				const cancelBtn = document.createElement("span");
				cancelBtn.className = "task-cancel dim small";
				cancelBtn.style.cssText = "cursor:pointer;text-decoration:underline;margin-left:8px;color:var(--red)";
				cancelBtn.textContent = "✕ 取消";
				cancelBtn.addEventListener("click", async (ev) => {
					ev.stopPropagation();
					cancelBtn.textContent = "取消中…";
					const r = await window.openpi.taskCancel(t.id).catch((err) => ({ ok: false, error: err.message ?? String(err) }));
					addSysLine(r?.ok ? `⏹ 后台任务已取消：${t.title}` : `任务取消失败：${r?.error ?? "未知"}`, !r?.ok);
					renderTasksPane();
				});
				row.querySelector(".task-meta").appendChild(cancelBtn);
			}
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
	if (modelSelect.value === "__manage__") { // P76：管理入口不触发切模型，恢复上次选择并弹管理窗
		const cur = state.session?.model ? `${state.session.model.provider}/${state.session.model.id}` : null;
		if (cur && [...modelSelect.options].some((o) => o.value === cur)) modelSelect.value = cur;
		openModelPinsModal();
		return;
	}
	if (!state.session) return; // P76 改写时保留原守卫
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
	renderSubagentsPage(); // P73：子智能体 + 全局指令（轻量 IPC，每次打开都刷新）
	renderP74Pages(); // P74：常规（外观回显）/信息（版本号）/扩展（内置能力 + MCP 动态行）
}
$("btn-settings").addEventListener("click", openSettings);
/* P76：关设置弹窗时连带关掉模型展示管理弹窗（两处关闭路径共用） */
function closeModelPinsModal() { $("model-pins-mask")?.classList.add("hidden"); }
$("btn-settings-close").addEventListener("click", () => { settingsMask.classList.add("hidden"); closeModelPinsModal(); });
$("btn-settings-back")?.addEventListener("click", () => { settingsMask.classList.add("hidden"); closeModelPinsModal(); }); // UI v3.1：全页版左上返回
/* UI v3.1：Esc 关全页设置（护栏：模型展示管理/全自动确认等上层弹窗开着时先让位） */
document.addEventListener("keydown", (e) => {
	if (e.key !== "Escape") return;
	if (settingsMask.classList.contains("hidden")) return;
	if (!$("model-pins-mask")?.classList.contains("hidden")) return;
	if (!$("fa-confirm-mask")?.classList.contains("hidden")) return;
	settingsMask.classList.add("hidden");
	closeModelPinsModal();
});
settingsMask.addEventListener("click", (e) => { if (e.target === settingsMask) { settingsMask.classList.add("hidden"); closeModelPinsModal(); } });

document.querySelectorAll(".tab").forEach((t) =>
	t.addEventListener("click", () => {
		document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
		for (const p of document.querySelectorAll(".tab-pane")) p.classList.add("hidden");
		$("tab-" + t.dataset.tab).classList.remove("hidden");
		if (t.dataset.tab === "extensions") renderExtensionsPage(); // P74：扩展页切到该 tab 时按需刷新（MCP 状态实时）
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
/* P76 交付1：测试错误人话（HTTP 状态映射 + 原始错误前 80 字兜底） */
function humanizeTestError(err) {
	const raw = String(err ?? "").trim();
	const map = [
		[/HTTP 401/, "401 密钥无效"],
		[/HTTP 403/, "403 无权限（检查密钥/白名单）"],
		[/HTTP 404/, "404 端点路径不对（Base URL 少 /v1？）"],
		[/HTTP 429/, "429 限流/欠费"],
		[/HTTP 5\d\d/, "服务端错误，稍后再试"],
		[/ECONNREFUSED|连接被拒/i, "连不上：服务未启动或地址不对"],
		[/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, "域名解析失败：检查网络/地址"],
		[/ETIMEDOUT|TimeoutError|aborted/i, "超时：网络不通或服务无响应"],
	];
	for (const [re, msg] of map) if (re.test(raw)) return `${msg}（${raw.slice(0, 80)}）`;
	return raw.slice(0, 80) || "未知错误";
}
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
	if (!rows.size) { // P76 交付4：空态三步指引
		const empty = document.createElement("div");
		empty.className = "side-empty";
		empty.innerHTML = `还没有任何密钥，三步完成：<br>① 下方输入 provider id（如 zhipu）→ ② 贴上 API Key 点「保存密钥」→ ③ 回到这行点「⚡ 测试」，绿灯即完成`;
		wrap.appendChild(empty);
		return;
	}
	for (const [id, r] of rows) {
		const el = document.createElement("div");
		el.className = "kv-item";
		el.innerHTML = `<span class="dot ${r.has ? "" : "off"}"></span><span class="kv-name"></span>
			<span class="kv-key"></span><span class="spacer"></span><span class="kv-meta">${r.from} · ${r.has ? "已配置" : "未配置"}</span>
			${r.has ? `<span class="kv-test-tip"></span><button class="kv-test-btn" data-p76="key-test">⚡ 测试</button>` : ""}`; // P76 交付1：已配 key 的行加「⚡ 测试」
		el.querySelector(".kv-name").textContent = `${r.name} (${id})`;
		el.querySelector(".kv-key").textContent = r.keyTxt;
		el.addEventListener("click", () => { $("key-provider").value = id; $("key-value").focus(); });
		const testBtn = el.querySelector(".kv-test-btn");
		if (testBtn) {
			testBtn.addEventListener("click", async (e) => {
				e.stopPropagation(); // 不触发行点击（行点击会聚焦 key 输入框）
				const tipEl = el.querySelector(".kv-test-tip");
				testBtn.disabled = true;
				const old = testBtn.textContent;
				testBtn.textContent = "测试中…";
				tipEl.textContent = ""; tipEl.className = "kv-test-tip";
				try {
					const res = await window.openpi.configTest({ providerId: id }); // 主进程自动取真实密钥
					if (res.ok) { tipEl.textContent = `✓ 连通 · ${res.ms}ms · ${res.count} 个模型`; tipEl.classList.add("ok"); }
					else { tipEl.textContent = `✗ ${humanizeTestError(res.error)}`; tipEl.classList.add("err"); }
				} catch (err) {
					tipEl.textContent = `✗ ${humanizeTestError(err.message ?? err)}`; tipEl.classList.add("err");
				} finally {
					testBtn.disabled = false;
					testBtn.textContent = old;
				}
			});
		}
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

/* P76 交付2：一键拉取模型列表 —— models:probe 探测 → 回填表单 → saveProvider 持久化（保留已有显示名映射） */
$("btn-fetch-models").addEventListener("click", async () => {
	const el = $("fp-msg");
	const btn = $("btn-fetch-models");
	const api = $("fp-api").value;
	// anthropic / google 端点无 OpenAI 兼容 /models：直接给人话，不打网络请求
	if (api === "anthropic-messages" || api === "google-generative-ai") {
		return tip(el, "该供应商不支持自动拉取，请手动填写模型 ID", "err");
	}
	const id = $("fp-id").value.trim();
	const prevNames = new Map(parseModelsText($("fp-models").value).filter((m) => m.name).map((m) => [m.id, m.name])); // 先留档显示名映射
	btn.disabled = true;
	const old = btn.textContent;
	btn.textContent = "拉取中…";
	try {
		const r = await window.openpi.modelsProbe({
			providerId: id || undefined,
			baseUrl: $("fp-baseurl").value.trim() || undefined,
			apiKey: $("fp-key").value.trim() || undefined,
		});
		if (!r.ok) return tip(el, `✗ 拉取失败：${humanizeTestError(r.error)}`, "err");
		if (!r.models.length) return tip(el, "✗ 端点通了但没返回模型，请手动填写模型 ID", "err");
		$("fp-models").value = r.models.join("\n"); // 表单自动填充
		if (id) { // 已有 ID 才落盘；否则提示先保存供应商
			configCache = await window.openpi.configSaveProvider(id, {
				name: $("fp-name").value.trim(),
				baseUrl: $("fp-baseurl").value.trim(),
				api,
				apiKey: $("fp-key").value.trim() || undefined,
				models: r.models.map((mid) => (prevNames.has(mid) ? { id: mid, name: prevNames.get(mid) } : { id: mid })),
			});
			renderProviderList(); renderKeyList();
			tip(el, `✓ 拉到 ${r.models.length} 个模型，已填充并保存`, "ok");
		} else {
			tip(el, `✓ 拉到 ${r.models.length} 个模型，已填充 → 填供应商 ID 后点「保存供应商」`, "ok");
		}
	} catch (e) {
		tip(el, `✗ 拉取失败：${e.message ?? e}`, "err");
	} finally {
		btn.disabled = false;
		btn.textContent = old;
	}
});

/* ---- Tab3: 本地模型预设 ---- */
/* ---- Tab3: 本地模型预设 ---- */
function renderPresetGrid() {
	const grid = $("preset-grid");
	grid.innerHTML = "";
	for (const [key, p] of Object.entries(configCache.presets)) {
		const b = document.createElement("button");
		b.className = "preset-card";
		b.innerHTML = `<b>${p.label}</b><span>${p.baseUrl}</span><div class="kv-meta" style="margin-top:4px">${p.hint}</div>`
			+ `<span class="preset-test" data-p76="preset-test" title="探测 ${p.baseUrl}（3 秒超时）">⚡ 测试</span><span class="preset-test-tip"></span>`; // P76 交付1：卡内「测试」（span 避免嵌套 button）
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
		const testEl = b.querySelector(".preset-test");
		testEl.addEventListener("click", async (e) => {
			e.stopPropagation(); // 不触发载入预设
			const tipEl = b.querySelector(".preset-test-tip");
			testEl.style.pointerEvents = "none";
			const old = testEl.textContent;
			testEl.textContent = "测试中…";
			tipEl.textContent = ""; tipEl.className = "preset-test-tip";
			try {
				const r = await window.openpi.modelsProbe({ baseUrl: p.baseUrl, apiKey: p.apiKey, local: true }); // 3 秒超时，先 /models 再 /api/tags
				if (r.ok) { tipEl.textContent = `✓ 在线 · ${r.latencyMs}ms · ${r.models.length} 个模型`; tipEl.classList.add("ok"); }
				else { tipEl.textContent = `✗ 连不上：检查是否启动（${String(r.error).slice(0, 60)}）`; tipEl.classList.add("err"); }
			} catch (err) {
				tipEl.textContent = `✗ 连不上：检查是否启动（${String(err.message ?? err).slice(0, 60)}）`; tipEl.classList.add("err");
			} finally {
				testEl.style.pointerEvents = "";
				testEl.textContent = old;
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
		syncSideUsage(); // UI v3.1：侧栏用量 pill
		return;
	}
	const pct = Math.min(100, (used / win) * 100);
	ctxBar.style.width = pct.toFixed(1) + "%";
	ctxBar.style.background = pct >= 90 ? "#f87171" : pct >= 70 ? "#eab308" : "#22c55e";
	ctxText.textContent = `上下文 ${(used / 1000).toFixed(1)}k / ${fmtWin(win)} · ${pct.toFixed(0)}%`;
	ctxWrap.title = `上下文: ${(used / 1000).toFixed(1)}k / ${fmtWin(win)} (${pct.toFixed(1)}%) · 压缩触发线 ${Math.round((1 - 16384 / win) * 100)}% · 接力线 ${HANDOFF_PCT * 100}%`;
	state.ctx = { pct, used, win };
	syncSideUsage(); // UI v3.1：侧栏用量 pill
}

/* UI v3.1：侧栏底部用量 pill = 本会话上下文占用%（数据源同 statusbar 上下文仪表） */
function syncSideUsage() {
	const el = document.getElementById("side-usage");
	if (!el) return;
	const pct = state.ctx?.pct;
	el.hidden = pct == null;
	el.textContent = pct == null ? "" : `${Math.round(pct)}%`;
	el.title = pct == null ? "" : `本会话上下文占用 ${pct.toFixed(1)}%`;
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
		if (typeof onSessionSwitched === "function") onSessionSwitched(); // P72b：接力开新会话也视为切换
		state.ctx = null; // 新会话从零开始，防接力链风暴
		state.usageTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
		renderUsage();
		workspaceLabel.textContent = state.session.workspace || "不在项目中工作";
		syncWelcomeTitle(); // UI v3.1：欢迎页标题随工作区
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

/* ---- M2 工具按钮（UI v3.1：emoji → lucide 单色图标） ---- */
const m2bar = document.createElement("div");
m2bar.id = "m2bar";
m2bar.innerHTML = `
	<button id="btn-compact" class="m2btn" title="手动压缩上下文（生成摘要，释放窗口空间）"><i data-lucide="minimize-2"></i></button>
	<button id="btn-tree" class="m2btn" title="会话树（分支导航）"><i data-lucide="list-tree"></i></button>
	<button id="btn-export" class="m2btn" title="导出会话为 HTML"><i data-lucide="share"></i></button>
	<button id="btn-rename" class="m2btn" title="重命名会话"><i data-lucide="pencil"></i></button>`;
document.querySelector("#statusbar .spacer")?.before(m2bar) ?? $("statusbar").appendChild(m2bar);
refreshIcons();

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
		// P76 修复：qmd 记忆扩展未安装的原始安装指引很长且裸奔在欢迎屏——人话化为一行
		if (/^memory_search requires qmd/.test(e.message ?? "")) {
			addSysLine("ℹ 跨会话记忆搜索未启用（可选依赖 qmd 未安装）；需要时运行 npm install -g @tobilu/qmd");
			return;
		}
		addSysLine(`${e.level === "error" ? "✗" : e.level === "warning" ? "⚠" : "ℹ"} ${e.message}`, e.level === "error");
	} else if (e.type === "agent_recovering") {
		addSysLine("⚠ Agent 进程异常退出，正在恢复最近会话；中断的本轮不会自动重放。", true);
		pushNotif("⚠️", "Agent 正在恢复", "会话与工作区将自动恢复，中断的本轮可稍后重试");
	} else if (e.type === "agent_recovered") {
		addSysLine("✓ Agent 进程与会话状态已恢复；若本轮中断，请点击“重试本轮”。");
	} else if (e.type === "agent_recovery_failed") {
		addSysLine(`✗ Agent 自动恢复失败：${e.error || "未知错误"}。请重新打开会话。`, true);
		pushNotif("❗", "Agent 恢复失败", e.error || "请重新打开会话");
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
/** P71：真正执行切档（主进程纠偏回滚 + 系统行提示 + 计划模式记账），change 事件与全自动确认弹窗共用；返回是否切档成功 */
async function switchApprovalMode(mode, sel) {
	try {
 		const real = await window.openpi.setApprovalMode(mode);
 		if (typeof real === "string" && real !== mode) sel.value = real; // 主进程纠偏则回滚显示
 		const cur = typeof real === "string" ? real : mode;
 		const names = { readonly: "只读", "auto-edit": "自动编辑", "full-auto": "全自动", plan: "计划模式（只读探索，批准后执行）" };
 		addSysLine(`🛡 审批模式：${names[cur]}`);
 		// P35：进入计划模式时记住来源档位，批准后切回
 		if (cur === "plan") {
 			state.planPrevMode = state.lastMode || "auto-edit";
 			state.planSpoke = false;
 		}
 		state.lastMode = cur;
 		renderPlanBar();
 		return true;
 	} catch (err) {
 		sel.value = state.lastMode || "auto-edit"; // 失败回滚 select，保持与主进程一致
 		addSysLine(`切换失败: ${err.message ?? err}`, true);
 		return false;
 	}
 }

/* ---- P71：首次切「全自动」前弹自定义风险确认（Electron 里 window.confirm 体验差且可能被拦） ---- */
let faConfirmCb = null;
const faConfirmOpen = (cb) => { faConfirmCb = cb; $("fa-confirm-mask").classList.remove("hidden"); };
const faConfirmClose = () => { faConfirmCb = null; $("fa-confirm-mask").classList.add("hidden"); };
$("btn-fa-ok")?.addEventListener("click", async () => {
	const cb = faConfirmCb;
	faConfirmClose();
	const ok = cb ? await cb() : true;
	if (ok) localStorage.setItem("fullAutoConfirmed", "1"); // 切档成功才记免弹标记；失败下次仍弹确认（审查缺陷 #6）
});
$("btn-fa-cancel")?.addEventListener("click", faConfirmClose);
window.addEventListener("keydown", (e) => {
	// Esc = 取消（capture 阶段先于其他全局 Esc 处理，弹窗开着时优先关弹窗）
	if (e.key === "Escape" && !$("fa-confirm-mask")?.classList.contains("hidden")) {
		e.stopPropagation();
		faConfirmClose();
	}
}, true);

$("approval-select").addEventListener("change", async (e) => {
	if (e.target.value === "goal") {
		// P63：目标模式先填目标+验收标准，确认后才真正切换
		$("goal-bar").hidden = false;
		$("goal-text").focus();
		return; // 等 btn-goal-start 确认后再切
	}
	// P71：首次切「全自动」先弹风险确认；确认前 select 回滚到原档位，点「仍要开启」才真正切
	if (e.target.value === "full-auto" && !localStorage.getItem("fullAutoConfirmed")) {
		e.target.value = state.lastMode || "auto-edit";
		faConfirmOpen(() => switchApprovalMode("full-auto", e.target));
		return;
	}
	await switchApprovalMode(e.target.value, e.target);
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
	const beforeImgs = state.images.length; // P72b：入列前张数基线（失败的已走 addSysLine，不进 toast）
	let savedTotal = 0;
	for (const f of files) {
		try {
			const img = await fileToImage(f);
			savedTotal += img.saved ?? 0;
			state.images.push(img);
		}
		catch (e) { addSysLine(`图片添加失败: ${e.message ?? e}`, true); }
	}
	const addedImgs = state.images.length - beforeImgs;
	if (addedImgs > 0) showToast(P72.pasteToastText(addedImgs)); // P72b：粘贴 toast（复用现有图片压缩提示之外的轻提醒）
	if (savedTotal > 1024 * 512) addSysLine(`🖼 已自动压缩图片，节省 ${fmtMB(savedTotal)}（最长边 2048px，利于识别与速度）`);
	renderImageBar();
}

/** P72b：粘贴 toast——顶部居中，4s 自动消失，后到顶掉前一条（复用同一元素重置计时） */
let toastTimer = null;
function showToast(text) {
	if (!text) return;
	let el = document.getElementById("toast");
	if (!el) {
		el = document.createElement("div");
		el.id = "toast";
		document.body.appendChild(el);
	}
	el.textContent = text;
	el.classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		el.classList.remove("show"); // CSS 过渡淡出；prefers-reduced-motion 下 media query 已去掉 transition = 直接显隐
	}, 4000);
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
// P76：dock 宽度拖拽——左缘手柄，拖宽/拖窄 dock（320–720px），持久化 localStorage；会话区有限度跟随
(() => {
	const handle = $("dock-resize");
	if (!handle) return;
	const saved = Number(localStorage.getItem("op-dock-w"));
	if (saved >= 320 && saved <= 720) document.documentElement.style.setProperty("--dock-w", saved + "px");
	handle.addEventListener("mousedown", (e) => {
		e.preventDefault();
		handle.classList.add("on");
		document.body.classList.add("dock-resizing");
		const onMove = (ev) => {
			const w = Math.min(720, Math.max(320, window.innerWidth - ev.clientX));
			document.documentElement.style.setProperty("--dock-w", w + "px");
		};
		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			handle.classList.remove("on");
			document.body.classList.remove("dock-resizing");
			const w = document.documentElement.style.getPropertyValue("--dock-w");
			if (w) localStorage.setItem("op-dock-w", String(parseInt(w, 10)));
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	});
})();
const dockPanes = { review: $("dock-pane-review"), preview: $("dock-pane-preview"), terminal: $("dock-pane-terminal"), files: $("dock-pane-files"), tasks: $("dock-pane-tasks"), subagents: $("dock-pane-subagents") };
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
	if (tab === "subagents") renderSubagentsPane(); // P76：切入时一次性重绘列表+选中 worker 流水
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
/** 统一刷新入口（P72→dock 归一）：审核页清单 + P72 面板 + 角标徽标；工具改文件 / 切会话都走这里 */
function refreshReviewUI() {
	if (dockTab === "review" && !dock.hidden) refreshReview();
	if (reviewPanelOpen) refreshReviewPanel();
	updateReviewBadge();
}
function scheduleReviewRefresh() {
	clearTimeout(reviewTimer);
	reviewTimer = setTimeout(refreshReviewUI, 600);
}
/** 角标计数：优先 review:changes 的 N（与审核页清单同数）；非 git 仓库 / 失败兜底 gitStatus 行数（原逻辑） */
async function updateReviewBadge(preloaded) {
	if (!state.session?.workspace) { $("review-cnt").hidden = true; return; }
	try {
		let r = preloaded;
		if (!r) { try { r = await window.openpi.reviewChanges(); } catch { r = null; } }
		let n = r?.ok ? (r.files ?? []).length : null;
		if (n == null) {
			const st = await window.openpi.gitStatus();
			n = st.split("\n").filter((l) => l.trim() && !l.startsWith("##")).length;
		}
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
	body.innerHTML = '<div class="dim small" style="padding:12px">加载中…</div>';
	if (!state.session?.workspace) {
		body.innerHTML = '<div class="dim small" style="padding:12px">当前会话无工作区（非 git 仓库不可用）</div>';
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
		// 会话改动清单（review:changes，vs 会话基线）——与 P72 面板同一数据源、同一行渲染
		let rc = null;
		try { rc = await window.openpi.reviewChanges(); } catch { rc = null; }
		const rcFiles = rc?.ok ? (rc.files ?? []) : [];
		if (!reviewFiles.length && !rcFiles.length) {
			updateReviewBadge(rc);
			body.innerHTML = '<div class="dim small" style="padding:12px">✓ 工作区干净，没有待审阅的变更。</div>';
			return;
		}
		const listHtml = rc?.ok
			? `<div class="review-list-head">记录了 ${rcFiles.length} 项改动</div>`
				+ `<div class="dim small" style="padding:0 2px 6px">基线：${rc.base === "HEAD" ? "HEAD（无会话快照）" : `会话快照 ${String(rc.base).slice(0, 7)}`}</div>`
				+ (rcFiles.length ? rcFiles.map((f) => P72.reviewFileRowHtml(f)).join("") : '<div class="dim small" style="padding:4px 2px">本会话暂无改动</div>')
			: '<div class="dim small" style="padding:4px 2px">当前会话无工作区（非 git 仓库不可用）</div>';
		updateReviewBadge(rc);
		// 旧 git status 逐文件明细（内联 diff / 还原 / 回滚，e2e-p26/p27 依赖 .review-file/.rv-discard/.ck-restore）折叠在清单下方
		const gitList = !reviewFiles.length ? "" : `<details class="rv-gitlist"><summary class="dim small">文件状态明细（${reviewFiles.length}）— 点击展开内联 diff / 还原 / 回滚</summary>`
			+ reviewFiles.map((f, i) => {
			const untracked = f.st.trim().startsWith("?");
			return `<div class="review-file" data-i="${i}">`
				+ `<span class="git-st" style="color:${GIT_STATUS_COLOR[f.st.trim()[0]] ?? "#999"}">${f.st.trim() || "??"}</span>`
				+ `<span class="path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>`
				+ `<span class="rv-actions">`
				+ (ckFiles.has(f.path) ? `<button class="rv-btn ck-restore" title="回滚 AI 对此文件的改动（恢复到 AI 首次修改前）">⏪</button>` : "")
				+ `<button class="rv-btn rv-open" title="用系统默认程序打开">打开</button>`
				+ `<button class="rv-btn danger rv-discard" title="${untracked ? "删除新文件（移入回收站，可恢复）" : "还原此文件的改动"}">还原</button></span></div>`
				+ `<pre class="git-pre" id="rv-diff-${i}" hidden></pre>`;
		}).join("") + `</details>`;
		body.innerHTML = listHtml + gitList;
		// 会话改动清单行点击 → P72 复用的单文件 diff 弹窗
		body.querySelectorAll(".rp-file").forEach((row, i) => row.addEventListener("click", () => openReviewDiff(rcFiles[i].file)));
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
	await loadProjectSkills(); // P73 第二批：项目级技能小节（无 workspace 时空态，不报错）
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

/* ---- P71：安装指引（新用户引导）+ 导出日志包（报障自助） ---- */
const INSTALL_GUIDE_URL = "https://github.com/liujinan153-cpu/openpi-desktop/blob/main/docs/INSTALL-GUIDE.md"; // org/repo 与 package.json repository 保持一致
$("btn-install-guide")?.addEventListener("click", () =>
	window.openpi.openExternal(INSTALL_GUIDE_URL).catch((err) => addSysLine(`打开安装指引失败: ${err.message ?? err}`, true)));
$("btn-logs-export")?.addEventListener("click", async () => {
	const btn = $("btn-logs-export"), msg = $("logs-msg");
	if (!btn || btn.disabled) return;
	btn.disabled = true;
	tip(msg, "正在打包日志…");
	try {
		const r = await window.openpi.exportLogs();
		if (r?.canceled) { tip(msg, ""); return; }
		tip(msg, `✓ 已导出: ${r.path}`, "ok");
	} catch (err) {
		tip(msg, `导出失败: ${err.message ?? err}`, "err");
	} finally {
		btn.disabled = false;
	}
});
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

// P73：打开/创建 mcp.json（不存在先落最小模板）——主动添加 MCP 服务器的入口
$("btn-mcp-open")?.addEventListener("click", async () => {
	const msg = $("mcp-msg");
	try {
		const { path: p, created } = await window.openpi.mcpEnsureConfig();
		const r = await window.openpi.openPath("~/.pi/agent/mcp.json");
		if (r?.error) tip(msg, `打开失败：${r.error}`, "err");
		else tip(msg, created ? "已创建示例配置并打开，编辑保存后点「重连全部」生效" : "已打开 mcp.json，编辑保存后点「重连全部」生效", "ok");
	} catch (err) {
		tip(msg, err?.message ?? err, "err");
	}
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
	const q = ($("skill-search").value || "").trim();
	const wrap = $("skill-list");
	wrap.innerHTML = "";
	let total = 0;
	for (const group of ["managed", "disabled", "external"]) {
		const list = (skillsCache[group] ?? []).filter((s) => P73SKILLS.skillMatchQuery(s, q)); // P73：过滤逻辑抽到纯逻辑层
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
	updateSkillSectionHeads();
}

/* ---- P73 第二批：小节头计数 badge + 项目级技能小节（workspace/.agents/skills，只读） ---- */
function updateSkillSectionHeads() {
	const gCount = ["managed", "disabled", "external"].reduce((n, k) => n + (skillsCache?.[k]?.length ?? 0), 0);
	const pCount = projectSkillsCache?.length ?? 0;
	const counts = P73SKILLS.skillChipCounts(gCount, pCount);
	const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
	set("skill-global-count", String(counts.global));
	set("skill-project-count", String(counts.project));
	set("skill-chip-all-n", String(counts.all));
	set("skill-chip-global-n", String(counts.global));
	set("skill-chip-project-n", String(counts.project));
}

let projectSkillsCache = null; // null = 无工作区/主进程旧版本；数组 = 项目级扫描结果
let projectSkillsDir = "";
async function loadProjectSkills() {
	const r = await window.openpi.skillsProjectList?.().catch(() => null);
	projectSkillsCache = r?.ok ? (r.skills ?? []) : null;
	projectSkillsDir = r?.ok ? (r.dir ?? "") : "";
	paintProjectSkills();
}
function paintProjectSkills() {
	const list = $("skill-project-list");
	if (!list) return;
	const pathEl = $("skill-project-path");
	if (!projectSkillsCache) { // 无工作区：小节整体保留，空态「当前不在项目中」（不报错）
		if (pathEl) pathEl.textContent = "";
		list.innerHTML = `<div class="side-empty">当前不在项目中</div>`;
		updateSkillSectionHeads();
		return;
	}
	if (pathEl) pathEl.textContent = projectSkillsDir;
	const q = ($("skill-search").value || "").trim();
	const shown = projectSkillsCache.filter((s) => P73SKILLS.skillMatchQuery(s, q));
	list.innerHTML = "";
	if (!projectSkillsCache.length) list.innerHTML = `<div class="side-empty">此目录中没有技能</div>`;
	else if (!shown.length) list.innerHTML = `<div class="side-empty">无匹配技能</div>`;
	else for (const s of shown) list.appendChild(skillRow(s, "project"));
	updateSkillSectionHeads();
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
	// P73 第二批：来源 badge（全局/外部/项目）；外部来源与项目级保持只读
	const srcBadge = document.createElement("span");
	srcBadge.className = "badge-dim small";
	srcBadge.textContent = group === "external" ? "外部" : group === "project" ? "项目" : "全局";
	el.appendChild(srcBadge);
	if (group === "project") return el; // P73：启停/删除是全局目录（~/.pi/agent/skills）语义，项目级不适用
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
	}
	return el;
}

$("btn-skill-refresh")?.addEventListener("click", renderSkillsPage);
$("skill-search")?.addEventListener("input", () => { renderSkillList(); paintProjectSkills(); }); // P73 第二批：搜索跨全局/项目两组过滤

/* ---- P73 第二批：工具行筛选 chips（全部/全局/项目，单选） ---- */
let skillChipFilter = "all";
function applySkillChipFilter() {
	const vis = P73SKILLS.skillSectionVisibility(skillChipFilter);
	const g = $("skills-global-card"), p = $("skills-project-card");
	if (g) g.hidden = !vis.global;
	if (p) p.hidden = !vis.project;
	for (const b of document.querySelectorAll(".skill-chips .chip")) b.classList.toggle("chip-on", b.dataset.filter === skillChipFilter);
}
for (const b of document.querySelectorAll(".skill-chips .chip")) {
	b.addEventListener("click", () => { skillChipFilter = b.dataset.filter || "all"; applySkillChipFilter(); });
}
$("btn-skill-import")?.addEventListener("click", () => {
	// P73：工具行「导入」复用原安装按钮 handler（原按钮原 id 原位保留，e2e 依赖）；URL 为空时由原 handler 提示
	$("skill-install-url")?.focus();
	$("btn-skill-install")?.click();
});
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
		showToast(`已创建「${name}」`); // P73 第二批：创建成功 toast + 列表刷新
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

/* ================= P73：子智能体管理 tab（内置角色 + ~/.pi/agent/subagents 自定义角色） ================= */
let subagentsCache = null;
let subagentEditingId = ""; // 非空 = 编辑态（复用新建表单）

async function renderSubagentsPage() {
	subagentsCache = await window.openpi.subagentsList().catch(() => null);
	if (!subagentsCache) return;
	renderSubagentLists();
	// P73 交付2：全局指令（~/.pi/agent/AGENTS.md）
	const g = await window.openpi.agentsGlobalRead().catch(() => null);
	if (g) {
		$("commands-global-path").textContent = g.path;
		if (document.activeElement !== $("commands-global-text")) $("commands-global-text").value = g.text; // 用户正在编辑时不回灌
	}
}

function subagentRow(item, kind) {
	const el = document.createElement("div");
	el.className = "subagent-row" + (item.disabled ? " off" : "");
	el.innerHTML = `<span class="subagent-ic"></span><div class="subagent-txt"><div class="subagent-line"><b></b><span class="badge-dim small"></span><code class="subagent-task dim small"></code></div><p class="dim small"></p><div class="subagent-chips"></div></div>`;
	el.querySelector(".subagent-ic").textContent = kind === "builtin" ? "🤖" : "🧩";
	el.querySelector("b").textContent = item.name;
	el.querySelector(".badge-dim").textContent = kind === "builtin" ? "内置" : "自定义";
	el.querySelector(".subagent-task").textContent = `Task("${item.id}")`; // 派发用法提示（等宽小字）
	el.querySelector("p").textContent = item.desc || (kind === "builtin" ? "" : "（无描述）");
	const chips = el.querySelector(".subagent-chips");
	const tools = item.tools ?? [];
	if (tools.length) for (const t of tools) { const c = document.createElement("span"); c.className = "tool-chip"; c.textContent = t; chips.appendChild(c); }
	else chips.innerHTML = `<span class="tool-chip dim">只读基座</span>`;
	if (kind === "custom") {
		const edit = document.createElement("button");
		edit.className = "icon-btn"; edit.title = "编辑"; edit.textContent = "✎";
		edit.addEventListener("click", () => openSubagentForm(item));
		const del = document.createElement("button");
		del.className = "icon-btn skill-del"; del.title = "删除"; del.textContent = "🗑";
		del.addEventListener("click", async () => {
			if (!confirm(`删除自定义子智能体「${item.name}」？JSON 文件将被删除。`)) return;
			try {
				await window.openpi.subagentsDelete(item.id);
				showToast(`已删除「${item.name}」`);
				subagentsCache = await window.openpi.subagentsList().catch(() => null); // 审查修复：IPC 失败不让 unhandled rejection 吞掉刷新
				renderSubagentLists();
			} catch (err) {
				showToast(`删除失败: ${err?.message ?? err}`);
			}
		});
		el.appendChild(edit); el.appendChild(del);
	}
	// 开关（内置/自定义通用）：禁用写入 settings 持久化，派发时回退 explore
	const sw = document.createElement("label");
	sw.className = "switch";
	sw.title = item.disabled ? "已禁用（派发回退 explore）" : "已启用";
	sw.innerHTML = `<input type="checkbox" ${item.disabled ? "" : "checked"}/><span class="slider"></span>`;
	sw.querySelector("input").addEventListener("change", async (e) => {
		const input = e.target;
		if (input.disabled) { input.checked = !input.checked; return; } // 审查修复：in-flight 防连点，写回视觉状态
		input.disabled = true;
		try {
			await window.openpi.subagentsToggle(item.id, !input.checked);
			item.disabled = !input.checked;
			el.classList.toggle("off", item.disabled);
			tip($("subagent-msg"), `✓ 「${item.name}」已${input.checked ? "启用" : "禁用"}（禁用后派发该角色将回退 explore），新派发生效`, "ok");
		} catch (err) {
			input.checked = !input.checked; // 回滚 UI
			tip($("subagent-msg"), err.message ?? err, "err");
		} finally {
			input.disabled = false;
		}
	});
	el.appendChild(sw);
	return el;
}

function renderSubagentLists() {
	const q = ($("subagent-search").value || "").trim().toLowerCase();
	const hit = (it) => !q || it.name.toLowerCase().includes(q) || (it.id || "").toLowerCase().includes(q) || (it.desc || "").toLowerCase().includes(q);
	const wrapB = $("subagent-builtin-list"), wrapC = $("subagent-custom-list");
	wrapB.innerHTML = ""; wrapC.innerHTML = "";
	let n = 0;
	const bl = (subagentsCache.builtin ?? []).filter(hit);
	for (const it of bl) { wrapB.appendChild(subagentRow(it, "builtin")); n++; }
	const cl = (subagentsCache.customs ?? []).filter(hit);
	for (const it of cl) { wrapC.appendChild(subagentRow(it, "custom")); n++; }
	$("subagent-count").textContent = n ? `共 ${n} 个` : "";
	$("subagent-custom-empty").classList.toggle("hidden", cl.length > 0);
	$("subagent-custom-dir").textContent = subagentsCache.dir ? `目录：${subagentsCache.dir}` : "";
}

function openSubagentForm(item = null) {
	subagentEditingId = item ? item.id : "";
	$("subagent-edit-id").value = subagentEditingId;
	$("subagent-new-name").value = item ? item.name : "";
	$("subagent-new-desc").value = item ? (item.desc || "") : "";
	$("subagent-new-tools").value = item ? (item.tools ?? []).join(", ") : "";
	$("subagent-new-prefix").value = item ? (item.prefix || "") : "";
	$("subagent-new-form").classList.remove("hidden");
	$("subagent-new-name").focus();
}
function closeSubagentForm() { subagentEditingId = ""; $("subagent-new-form").classList.add("hidden"); }

$("btn-subagent-new")?.addEventListener("click", () => openSubagentForm(null));
$("btn-subagent-new-empty")?.addEventListener("click", () => openSubagentForm(null));
$("btn-subagent-cancel")?.addEventListener("click", closeSubagentForm);
$("subagent-search")?.addEventListener("input", renderSubagentLists);
$("btn-subagent-save")?.addEventListener("click", async () => {
	const name = $("subagent-new-name").value.trim();
	if (!name) return tip($("subagent-new-msg"), "名称必填", "err");
	const tools = $("subagent-new-tools").value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
	const editing = !!subagentEditingId;
	try {
		await window.openpi.subagentsSave({ id: subagentEditingId || undefined, name, desc: $("subagent-new-desc").value.trim(), tools, prefix: $("subagent-new-prefix").value });
		closeSubagentForm();
		showToast(editing ? `子智能体「${name}」已更新` : `子智能体「${name}」已创建`);
		subagentsCache = await window.openpi.subagentsList();
		renderSubagentLists();
	} catch (err) {
		tip($("subagent-new-msg"), err.message, "err");
	}
});

/* ---- P73 交付2：全局指令保存（~/.pi/agent/AGENTS.md，写前主进程自动备份 .bak）---- */
$("btn-commands-save")?.addEventListener("click", async () => {
	try {
		await window.openpi.agentsGlobalWrite($("commands-global-text").value);
		$("commands-saved-at").textContent = `上次保存：${new Date().toLocaleString("zh-CN", { hour12: false })}`;
		showToast("全局指令已保存（原文件已备份为 AGENTS.md.bak）");
	} catch (err) {
		tip($("commands-msg"), err.message, "err");
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
		// P75 用户定调：每个横杠=一条用户提问，回答内容不上轨
		if (el.hidden || el.classList.contains("empty-hide")) continue;
		if (!el.classList.contains("user")) continue;
		const r = el.getBoundingClientRect();
		const top = ((r.top - chatRect.top + chat.scrollTop) / H) * 100;
		const h = Math.max(0.6, (r.height / H) * 100);
		if (top >= 100) continue;
		const seg = document.createElement("div");
		seg.className = "mm-seg " + mmSegClass(el);
		seg.style.top = top + "%";
		seg.style.height = h + "%";
		seg.title = (el.querySelector(".who")?.textContent ?? el.textContent ?? "").trim().slice(0, 60);
		seg._src = el; // P75：hover 预览弹层用（minimap 段 ↔ 消息元素映射）
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

/* P75：hover 预览弹层（对标 ChatGPT Desktop）——鼠标停在轨道上弹出该位置消息的预览卡，点击/拖动跳转行为不变 */
const mmPop = document.createElement("div");
mmPop.className = "mm-pop hidden";
mmPop.innerHTML = `<div class="mm-pop-who"></div><div class="mm-pop-tx"></div>`;
minimap.appendChild(mmPop);
const mmPopHide = () => { mmPop.classList.add("hidden"); };
minimap.addEventListener("mousemove", (e) => {
	if (mmDragging) { mmPopHide(); return; }
	const rect = minimap.getBoundingClientRect();
	const ratio = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
	let src = null, who = "", tx = "";
	for (const seg of mmSegs.children) {
		const top = parseFloat(seg.style.top) || 0;
		const h = parseFloat(seg.style.height) || 0;
		if (ratio >= top / 100 && ratio <= (top + h) / 100) { src = seg._src; break; }
	}
	if (!src) { mmPopHide(); return; }
	who = (src.querySelector(".who")?.textContent ?? (src.classList.contains("user") ? "你" : "")).trim();
	tx = (src.querySelector(".body")?.textContent ?? src.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
	if (!tx) { mmPopHide(); return; }
	mmPop.querySelector(".mm-pop-who").textContent = who;
	mmPop.querySelector(".mm-pop-tx").textContent = tx;
	mmPop.classList.remove("hidden");
	// 弹层贴轨道左侧，垂直跟随光标并钳制在轨道内
	const popH = mmPop.offsetHeight || 80;
	const y = Math.min(Math.max(e.clientY - rect.top, 8), Math.max(8, rect.height - popH - 8));
	mmPop.style.top = y + "px";
});
minimap.addEventListener("mouseleave", mmPopHide);

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
	/* P71 引入 + P74 迁移：「关于与更新」卡（update-card）现居「信息」tab（#tab-about）内，由通用 tab-pane 选择器索引；
	   .settings-nav 直属卡选择器保留兜底（现无匹配，nav 底部已留白），tab 记空串时 ssGo 里 ?.click() 不切 tab 只滚动+高亮 */
	for (const card of document.querySelectorAll("#settings .tab-pane > div[id$='-card'], #settings .tab-pane > .cu-card, #settings .tab-pane > .kv-list, #settings .tab-pane > .form-grid, #settings .tab-pane > .preset-grid, #settings .settings-nav > div[id$='-card']")) {
		const pane = card.closest(".tab-pane");
		if (!pane && !card.closest(".settings-nav")) continue;
		const tabBtn = pane ? ssTabs().find((t) => "tab-" + t.dataset.tab === pane.id) : null;
		idx.push({ tab: pane ? pane.id.replace("tab-", "") : "", tabLabel: tabBtn?.textContent.trim() ?? "关于与更新", el: card, title: card.querySelector("b")?.textContent?.trim() ?? card.id, text: card.textContent.replace(/\s+/g, " ") });
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

/* ================= P72b：会话改动审阅面板（顶栏 git-compare 按钮 + 右栏 280px + 30s 轮询 + 单文件 diff 弹窗） ================= */
const reviewPanelEl = $("review-panel");
const reviewPanelList = $("review-panel-list");
const reviewPanelEmpty = $("review-panel-empty");
const reviewPanelBase = $("review-panel-base");
const btnReviewPanel = $("btn-review-panel");
let reviewPanelOpen = false;
let reviewPanelTimer = null;

/** 面板开关：打开拉一次 + 启动 30s 轮询；收起即停（不烧无谓 IPC） */
function setReviewPanel(open) {
	reviewPanelOpen = open;
	reviewPanelEl.hidden = !open;
	btnReviewPanel.classList.toggle("on", open);
	if (open) {
		refreshReviewPanel();
		clearInterval(reviewPanelTimer);
		reviewPanelTimer = setInterval(refreshReviewPanel, 30000);
	} else {
		clearInterval(reviewPanelTimer);
		reviewPanelTimer = null;
	}
}

/** 拉取会话改动（review:changes 失败/非 git 仓库 → 空态，不报错） */
async function refreshReviewPanel() {
	let r = null;
	try { r = await window.openpi.reviewChanges(); } catch { r = null; }
	// 拉取期间面板已收起 → 丢弃本次结果
	if (!reviewPanelOpen) return;
	const files = r?.ok ? (r.files ?? []) : [];
	$("review-panel-title").textContent = files.length ? `记录了 ${files.length} 项改动` : "会话改动";
	if (r?.ok) {
		reviewPanelBase.hidden = false;
		reviewPanelBase.textContent = r.base === "HEAD" ? "基线：HEAD（无会话快照）" : `基线：会话快照 ${String(r.base).slice(0, 7)}`;
	} else {
		reviewPanelBase.hidden = true;
	}
	reviewPanelEmpty.hidden = files.length > 0;
	reviewPanelList.innerHTML = "";
	// 行渲染抽到 P72.reviewFileRowHtml（审核 dock 清单共用同一份 HTML）
	files.forEach((f, i) => {
		reviewPanelList.insertAdjacentHTML("beforeend", P72.reviewFileRowHtml(f));
		const row = reviewPanelList.lastElementChild;
		row.addEventListener("click", () => openReviewDiff(files[i].file));
	});
}

/** 单文件 diff 弹窗（复用 memory-mask 同款遮罩结构；等宽滚动区按行打红绿 class） */
async function openReviewDiff(file) {
	const mask = $("review-diff-mask");
	$("review-diff-title").textContent = file;
	const body = $("review-diff-body");
	body.textContent = "加载中…";
	mask.hidden = false;
	try {
		const r = await window.openpi.reviewDiff(file);
		if (!r?.ok) {
			body.textContent = `无法获取 diff：${r?.reason ?? "未知错误"}`;
			return;
		}
		body.innerHTML = "";
		for (const line of String(r.diff ?? "").split("\n")) {
			const div = document.createElement("div");
			if (line.startsWith("+") && !line.startsWith("+++")) div.className = "diff-add";
			else if (line.startsWith("-") && !line.startsWith("---")) div.className = "diff-del";
			else if (line.startsWith("@@")) div.className = "diff-hunk";
			div.textContent = line || " "; // 空行占位保行高
			body.appendChild(div);
		}
		if (r.truncated) {
			const note = document.createElement("div");
			note.className = "dim";
			note.textContent = "…（diff 过大，仅显示前 500 行）";
			body.appendChild(note);
		}
	} catch (err) {
		body.textContent = `无法获取 diff：${err?.message ?? err}`;
	}
}

// 入口归一：顶栏按钮改为跳转 dock 审核页（右栏 #review-panel 面板保留 DOM 但不再有入口，收起以防轮询残留）
btnReviewPanel.addEventListener("click", () => {
	setReviewPanel(false);
	showDock("review");
});
$("review-panel-close").addEventListener("click", () => setReviewPanel(false));
$("review-panel-refresh").addEventListener("click", () => refreshReviewPanel());
$("review-diff-close").addEventListener("click", () => { $("review-diff-mask").hidden = true; });
$("review-diff-mask").addEventListener("click", (e) => {
	if (e.target === $("review-diff-mask")) $("review-diff-mask").hidden = true; // 点遮罩关闭
});
window.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && !$("review-diff-mask").hidden) $("review-diff-mask").hidden = true;
});

/** P72b：切会话钩子（resumeSession/startSession/接力三处调用）——面板/审核 dock 开着才刷新，收起时等下次打开再拉（基线随会话变） */
function onSessionSwitched() {
	refreshReviewUI();
}

/* ================= P74：常规 / 信息 / 扩展 三个设置 tab ================= */

/* ---- P74① 常规页：主题三档（跟随系统/浅色/深色）——applyTheme/resolveTheme 在主题切换区（P74 扩展） ---- */
$("sel-theme")?.addEventListener("change", (e) => applyTheme(e.target.value));

/* ---- P74② 常规页：界面字体——canvas measure 探测过滤未安装候选；选择写 --sans 变量全局生效，「系统默认」恢复内置字体栈 ---- */
const P74_FONT_CANDIDATES = [
	{ name: "Microsoft YaHei", zh: "微软雅黑" },
	{ name: "Noto Sans SC", zh: "思源黑体" },
	{ name: "LXGW WenKai", zh: "霞鹜文楷" },
	{ name: "MiSans", zh: "" },
	{ name: "HarmonyOS Sans SC", zh: "" },
	{ name: "OPPO Sans", zh: "" },
];
function detectInstalledFonts() {
	try {
		const ctx = document.createElement("canvas").getContext("2d");
		if (!ctx) return [];
		const probe = "测iW@1.国"; // 中英混测：候选字体被采用时宽度必偏离回退基线
		ctx.font = "72px 'Courier New', monospace";
		const baseline = ctx.measureText(probe).width;
		const hits = [];
		for (const f of P74_FONT_CANDIDATES) {
			const hit = [f.name, f.zh].filter(Boolean).some((n) => {
				ctx.font = `72px '${n}', 'Courier New', monospace`;
				return Math.abs(ctx.measureText(probe).width - baseline) > 0.5;
			});
			if (hit) hits.push(f.name);
		}
		return hits;
	} catch { return []; } // 探测失败宁可少列，不列出不存在的字体
}
function applyFont(name) {
	if (name) document.documentElement.style.setProperty("--sans", `"${name}", "Microsoft YaHei", "Segoe UI", sans-serif`);
	else document.documentElement.style.removeProperty("--sans"); // 系统默认 = 清空恢复 :root 内置字体栈
	localStorage.setItem("op-font", name || "");
}
(() => {
	const sel = $("sel-font");
	if (!sel) return;
	sel.innerHTML = `<option value="">系统默认</option>`;
	for (const f of detectInstalledFonts()) {
		const o = document.createElement("option");
		o.value = f; o.textContent = f;
		sel.appendChild(o);
	}
	applyFont(localStorage.getItem("op-font") || ""); // 启动恢复上次选择
	sel.addEventListener("change", () => applyFont(sel.value));
})();

/* ---- P74③ 常规页：界面缩放 90–130%（钳制纯函数 clampZoom 在 p72-logic.js）；document.documentElement.style.zoom 在 Chromium 下全局生效 ---- */
function applyZoom(pct) {
	const r = globalThis.P72.clampZoom(pct);
	document.documentElement.style.zoom = r === 100 ? "" : String(r / 100); // 100% 清空，避免叠加精度问题
	const rng = $("rng-zoom"), val = $("zoom-val");
	if (rng) rng.value = String(r);
	if (val) val.textContent = `${r}%`;
	localStorage.setItem("op-zoom", String(r));
}
$("rng-zoom")?.addEventListener("input", (e) => applyZoom(e.target.value));
applyZoom(localStorage.getItem("op-zoom") || "100"); // 启动应用

/* ---- P74④ 信息页：打开日志 / 问题反馈 / 开发者模式 ---- */
$("btn-open-logs")?.addEventListener("click", async () => {
	const log = "~/.pi/agent/logs/main.log", dir = "~/.pi/agent/logs";
	try {
		// 稳方案：fileStat 先探测文件（工作区外路径会被 path-policy 拒绝 → catch 视同不存在）；
		// 存在则资源管理器定位（showItemInFolder 仅工作区内路径可达，失败静默回落 openPath 目录——openPath 允许 ~/.pi/agent 根内路径）
		const st = await window.openpi.fileStat(log).catch(() => null);
		if (st?.exists) {
			const r = await window.openpi.showItemInFolder(log).catch(() => null);
			if (r) return;
		}
		const r2 = await window.openpi.openPath(dir);
		if (r2?.error) showToast(`打开日志失败：${r2.error}`);
	} catch (err) {
		showToast(`打开日志失败：${err?.message ?? err}`);
	}
});
$("btn-feedback")?.addEventListener("click", async () => {
	let ver = "";
	try { ver = (await window.openpi.versions())?.app ?? ""; } catch { /* 旧主进程无此 IPC */ }
	const body = encodeURIComponent(`\n\n---\n- 版本：OpenPi Desktop v${ver}\n- 环境：Windows`);
	window.openpi.openExternal(`https://github.com/liujinan153-cpu/openpi-desktop/issues/new?body=${body}`)
		.catch((err) => addSysLine(`打开问题反馈失败: ${err.message ?? err}`, true));
});
$("chk-devtools")?.addEventListener("change", async (e) => {
	try {
		await window.openpi.devtoolsToggle(e.target.checked); // 新 IPC devtools:toggle → 主进程 openDevTools({mode:"detach"}) / closeDevTools()
		localStorage.setItem("op-devtools", e.target.checked ? "1" : ""); // localStorage 记忆（仅回显状态，不随启动自动开窗）
	} catch (err) {
		e.target.checked = !e.target.checked; // IPC 失败回滚视觉态
		showToast(`切换开发者模式失败: ${err?.message ?? err}`);
	}
});

/* ---- P74⑤ 扩展页：内置能力静态卡（诚实标注）+ MCP 动态行（数据源同 renderMcpSection）+ 市场占位入口 ---- */
const P74_BUILTIN_EXTS = [
	{ icon: "globe", name: "浏览器控制", caps: ["网页浏览", "内容抓取", "点击/表单操作"], perm: "驱动本机浏览器（CDP 调试协议），仅在你要求浏览网页时使用" },
	{ icon: "monitor", name: "电脑控制", caps: ["截图", "鼠标点击/拖拽", "键盘输入"], perm: "纯本地执行、常驻进程驱动；非只读操作受审批档位管控" },
	{ icon: "image", name: "生图", caps: ["文生图"], perm: "调用生图 API（默认智谱 CogView-4，可配第三方 OpenAI 兼容服务）" },
	{ icon: "search", name: "联网检索", caps: ["webfetch 抓网页", "websearch 联网搜索"], perm: "只读工具；已拦截内网/环回地址" },
	{ icon: "code", name: "代码智能", caps: ["代码理解/修改", "工作区检索", "终端命令"], perm: "工作区文件读写与命令执行均受审批档位管控" },
	{ icon: "brain", name: "记忆", caps: ["跨会话记忆读写"], perm: "存储在本地 ~/.pi/agent，不上传" },
];
let extBuiltinRendered = false; // 内置卡静态不依赖 IPC，一次渲染即可
async function renderExtensionsPage() {
	const list = $("ext-builtin-list");
	if (list && !extBuiltinRendered) {
		extBuiltinRendered = true;
		list.innerHTML = "";
		for (const ext of P74_BUILTIN_EXTS) {
			const el = document.createElement("details");
			el.className = "ext-row";
			el.innerHTML = `<summary><span class="ext-ic"><i data-lucide="${ext.icon}"></i></span><b></b><span class="badge-dim small">内置</span><span class="dim small">内置 · 当前版本</span></summary><div class="ext-body"><div class="subagent-chips"></div><p class="dim small"></p></div>`;
			el.querySelector("summary b").textContent = ext.name;
			const chips = el.querySelector(".subagent-chips");
			for (const c of ext.caps) {
				const s = document.createElement("span");
				s.className = "tool-chip"; s.textContent = c;
				chips.appendChild(s);
			}
			el.querySelector(".ext-body p").textContent = `权限：${ext.perm}`;
			list.appendChild(el);
		}
		refreshIcons();
	}
	// MCP 动态行：服务器名 + 连接状态 + 工具数；无配置给空态
	const wrap = $("ext-mcp-list");
	let mcpOk = 0;
	if (wrap) {
		try {
			const r = await window.openpi.mcpStatus();
			if (!r.status.length) {
				wrap.innerHTML = `<span class="dim small">未配置 MCP 服务器。在「工具与集成」→ MCP 服务器 中添加。</span>`;
			} else {
				wrap.innerHTML = "";
				for (const s of r.status) {
					const row = document.createElement("div");
					row.innerHTML = s.ok
						? `<b style="color:#3fb950">●</b> <b class="ext-mcp-name"></b> <span class="dim small"></span>`
						: `<b style="color:#f85149">✖</b> <b class="ext-mcp-name"></b> <span class="err-text small"></span>`;
					row.querySelector(".ext-mcp-name").textContent = `${s.name}（${s.mode}）`;
					row.querySelector("span").textContent = s.ok ? `已连接 · ${s.toolCount} 个工具` : (s.error ?? "连接失败");
					if (s.ok) mcpOk++;
					wrap.appendChild(row);
				}
			}
		} catch (err) {
			wrap.innerHTML = `<span class="err-text small">状态获取失败：${err.message ?? err}</span>`;
		}
	}
	const cnt = $("ext-enabled-count");
	if (cnt) cnt.textContent = `已启用 ${P74_BUILTIN_EXTS.length + mcpOk}`;
}
// 市场入口：诚实占位——扩展市场尚未上线，先跳仓库主页
$("btn-marketplace")?.addEventListener("click", () =>
	window.openpi.openExternal("https://github.com/liujinan153-cpu/openpi-desktop")
		.catch((err) => addSysLine(`打开市场失败: ${err.message ?? err}`, true)));

/* ---- P74⑥ 三页统一挂载（openSettings 调用）：常规回显 / 信息版本号 / 扩展渲染 ---- */
async function renderP74Pages() {
	// 常规页三控件回显（应用逻辑在各自的 change 监听里）
	const selTheme = $("sel-theme");
	if (selTheme) selTheme.value = localStorage.getItem("op-theme") || "dark";
	const selFont = $("sel-font");
	if (selFont) selFont.value = localStorage.getItem("op-font") || "";
	const z = globalThis.P72.clampZoom(localStorage.getItem("op-zoom") || "100");
	const rng = $("rng-zoom"), zv = $("zoom-val");
	if (rng) rng.value = String(z);
	if (zv) zv.textContent = `${z}%`;
	// 信息页：应用版本复用 update-line 同源数据（update:snapshot）；electron/chrome 小字走 app:versions
	try {
		const s = await window.openpi.updateSnapshot();
		const av = $("about-version");
		if (s?.current && av) av.textContent = `v${s.current}`;
	} catch { /* 非主窗口等场景忽略 */ }
	try {
		const v = await window.openpi.versions();
		const ae = $("about-electron");
		if (v && ae) ae.textContent = `Electron ${v.electron} · Chrome ${v.chrome}`;
	} catch { /* 旧主进程无此 IPC */ }
	const chk = $("chk-devtools");
	if (chk) chk.checked = localStorage.getItem("op-devtools") === "1";
	// 扩展页（内置卡 + MCP 动态行）
	renderExtensionsPage();
}
