/* P72：纯逻辑层（无 DOM 依赖）——Subagent 协作卡状态机 + 过程时间线聚合计数。
   经典脚本加载（index.html 在 app.js 之前 <script src>），挂到 globalThis.P72；
   Node 单测（scripts/unit-p72a.mjs）通过 import 副作用读取 globalThis.P72。
   不用 import/export 语法：同一份代码在浏览器经典脚本与 Node ESM 下都可执行。 */
(() => {
	/** P72 交付1：worker.status → 协作卡状态文案/样式类（未知状态按「派发中」处理，不造假终态） */
	const SUBAGENT_STATUS = {
		running: { label: "运行中", cls: "run" },
		done: { label: "已完成", cls: "done" },
		error: { label: "已失败", cls: "err" },
		cancelled: { label: "已取消", cls: "cancel" },
	};

	function subagentStatus(status) {
		return SUBAGENT_STATUS[status] ?? { label: "派发中", cls: "run" };
	}

	/** 是否终态（终态停 spinner、定格耗时） */
	function subagentTerminal(status) {
		return status === "done" || status === "error" || status === "cancelled";
	}

	/** P72 折叠策略：完成即折叠、失败保持展开（让用户看到原因）；取消视同完成（用户主动结束，不占视觉焦点） */
	function subagentShouldAutoCollapse(status) {
		return status === "done" || status === "cancelled";
	}

	/** P72 统计文案：步骤数只在主进程透传了工具事件（steps>0）时显示；
	    没有透传（steps=0）且仍在跑 → 显示「后台执行中」，不放假数字。耗时：运行中实时、终态定格。 */
	function subagentStats(worker, now) {
		const w = worker ?? {};
		const end = w.endedAt ?? (typeof now === "number" ? now : Date.now());
		const secs = Math.max(1, Math.round((end - (w.started ?? end)) / 1000));
		const parts = [];
		if ((w.steps ?? 0) > 0) parts.push(`${w.steps} 个步骤`);
		else if (!subagentTerminal(w.status)) parts.push("后台执行中");
		parts.push(`${secs}s`);
		return parts.join(" · ");
	}

	/** P72 交付2：过程时间线折叠条文案。streaming 中「处理中 · N 个步骤」实时累加；
	    消息完成后「已工作 X 秒 · N 个步骤」并默认折叠（与既有 work 条措辞同族）。 */
	function stepsGroupLabel(count, secs, finished) {
		const n = Math.max(0, count ?? 0);
		if (!finished) return `处理中 · ${n} 个步骤`;
		const s = Math.max(1, Math.round(secs ?? 0));
		return `已工作 ${s} 秒 · ${n} 个步骤`;
	}
	/* ---- P75：轮次折叠条（对标 ChatGPT Desktop 用时条） ---- */

	/** 秒 → 人话时长：「47 秒 / 2分47秒 / 1时3分」（P75 轮次条完成态用） */
	function fmtDur(secs) {
		const s = Math.max(0, Math.round(Number(secs) || 0));
		if (s < 60) return `${s} 秒`;
		const m = Math.floor(s / 60);
		const r = s % 60;
		if (m < 60) return r ? `${m}分${r}秒` : `${m}分`;
		return `${Math.floor(m / 60)}时${m % 60}分`;
	}

	/** P75 轮次折叠条文案（严格对标 ChatGPT 截图）：流式中「正在工作…」；完成后「用时 2分47秒」 */
	function turnBarLabel(count, secs, finished) {
		if (!finished) return "正在工作…";
		return `用时 ${fmtDur(secs)}`;
	}
	/* ---- P72b：会话改动审阅面板 + toast + token 指示的纯展示逻辑（无 DOM） ---- */

	/** token 数 k 缩写（「⚡ 12.3k tok」用）：<1k 原样，<100k 一位小数 k，≥100k 整数 k，≥1M 用 M */
	function fmtTokCompact(n) {
		const v = Math.max(0, Number(n) || 0);
		if (v < 1000) return String(v);
		if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`;
		if (v >= 100000) return `${Math.round(v / 1000)}k`;
		return `${(v / 1000).toFixed(1)}k`;
	}

	/** diffstat 展示拆分：+N 绿 / -N 红两段（渲染层各自上色）；二进制给「二进制」文案；0 增 0 删两段为空不占位 */
	function diffStatParts(added, deleted, binary) {
		if (binary) return { plus: "", minus: "", text: "二进制" };
		const a = Math.max(0, Number(added) || 0);
		const d = Math.max(0, Number(deleted) || 0);
		return { plus: a > 0 ? `+${fmtTokCompact(a)}` : "", minus: d > 0 ? `-${fmtTokCompact(d)}` : "", text: "" };
	}

	/** 粘贴 toast 文案：1 张单数措辞，多张复数，0 张返回空串（调用方不弹） */
	function pasteToastText(n) {
		const c = Math.max(0, Number(n) || 0);
		if (!c) return "";
		return c === 1 ? "已将 1 张图片保存到会话临时目录" : `已将 ${c} 张图片保存到会话临时目录`;
	}

	/** P74：界面缩放钳制——90–130%，步进对齐 5；脏输入（NaN/非数值）回落 100。渲染层 applyZoom 与常规页回显共用 */
	function clampZoom(v) {
		let n = Math.round(Number(v));
		if (!Number.isFinite(n)) return 100;
		n = Math.round(n / 5) * 5;
		return Math.min(130, Math.max(90, n));
	}

	globalThis.P72 = { SUBAGENT_STATUS, subagentStatus, subagentTerminal, subagentShouldAutoCollapse, subagentStats, stepsGroupLabel, turnBarLabel, fmtDur, fmtTokCompact, diffStatParts, pasteToastText, clampZoom };


})();
