// E2E P24：上下文接力（占用过阈值 → 压缩摘要 → 自动开新会话继续）
// 前置：electron --remote-debugging-port=9333 已启动
// 关键前提（读 pi 源码得出）：compact 的切点必须落在条目 0 之后（切点前的内容才生成摘要），
// 因此会话至少 3 轮、且倒数第二轮累计估算 token ≥ keepRecentTokens(默认 20000，估算=字符数/4)。
import CDP from "chrome-remote-interface";
import fs from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await (async () => {
	const tabs = await CDP.List({ port: 9333 });
	const page = tabs.find((t) => t.type === "page");
	return CDP({ target: page.webSocketDebuggerUrl });
})();
await client.Runtime.enable();
await client.Page.enable();
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 500));
	return r.result.value;
};
const shot = async (name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(`p24-${name}.png`, Buffer.from(r.data, "base64"));
	console.log(`📸 p24-${name}.png`);
};
const waitSettled = async (timeout = 180000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const s = await ev(`({ streaming: state.streaming, has: !!state.session })`);
		if (s.has && !s.streaming) return true;
		await sleep(1200);
	}
	return false;
};
let fails = 0;
const ok = (name, cond, extra = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};

// 铺垫轮生成器：~550 句 ≈ 7.1 万字符 ≈ 1.78 万估算 token（字符数/4）
const filler = `Array.from({ length: 550 }, (_, i) => "Section " + i + ": the alpha-beta-gamma-delta module registers endpoint /api/v2/status with timeout 30000ms and retry policy 3x exponential backoff, see manual R-" + i + ".").join("  ")`;

// 0. 等应用就绪 + 强制 auto 模式（防历史残留）
await waitSettled(30000);
await ev(`localStorage.setItem("op-handoff", "auto"); document.getElementById("handoff-select").value = "auto"; state.ctx = null;`);

// 1. UI 接线
ok("handoff-select 存在", await ev(`!!document.getElementById("handoff-select")`));
ok("三个档位", JSON.stringify(await ev(`[...document.getElementById("handoff-select").options].map(o => o.value)`)) === JSON.stringify(["auto", "ask", "off"]));

// 2. 三轮真实消息铺垫（让切点落在中部；真实占用 ~40%，不会触发原生压缩/自然接力）
await ev(`sendText("记住暗号 ZEBRA-7391。以下是背景资料，通读后只回复 OK。资料：" + ${filler}, [], null)`);
ok("第1轮", await waitSettled());
await ev(`sendText("继续阅读第二部分资料，通读后只回复 OK。资料：" + ${filler}, [], null)`);
ok("第2轮", await waitSettled());
await ev(`sendText("继续阅读第三部分资料，通读后只回复 OK。资料：" + ${filler}, [], null)`);
ok("第3轮", await waitSettled());
const oldId = await ev(`state.session.sessionId`);
const oldFile = await ev(`state.session.sessionFile`);

// 3. 强制占用过阈值 → 触发接力（真实验证链路：compact 摘要 → start 新会话 → 种子注入）
await ev(`state.ctx = { pct: 95, used: 1, win: 1 }; maybeAutoHandoff();`);

// 4. 等接力完成（handoffBusy 贯穿种子回复完成）
let newId = null, newFile = null;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
	const s = await ev(`({ busy: state.handoffBusy, id: state.session?.sessionId, file: state.session?.sessionFile })`);
	if (!s.busy && s.id && s.id !== oldId) { newId = s.id; newFile = s.file; break; }
	await sleep(1500);
}
ok("已切到新会话", !!newId && newId !== oldId, `${String(oldId).slice(0, 8)}… → ${String(newId).slice(0, 8)}…`);
ok("会话文件已更换", !!newFile && newFile !== oldFile);

// 5. 接力痕迹
ok("注入胶囊（摘要不打屏）", await ev(`[...document.querySelectorAll(".msg.user .body")].some(b => b.textContent.includes("交接摘要已注入"))`));
ok("接力 sysline", await ev(`[...document.querySelectorAll(".sysline")].some(b => b.textContent.includes("已接力到新会话"))`));
ok("接力回复完成（再次 settle）", await waitSettled());
const title = await ev(`state.meta?.[state.session.sessionId]?.title ?? ""`);
ok("meta 标题接力N", / · 接力\d+$/.test(title), title);
ok("旧会话仍在侧栏可回看", await ev(`state.sessions.some(s => s.id === ${JSON.stringify(oldId)})`));
ok("ctx 已重置为新会话真实占用", await ev(`state.ctx === null || (state.ctx.win > 1000 && state.ctx.pct < 50)`), JSON.stringify(await ev(`state.ctx`)));

// 6. 软验证：暗号是否随摘要跨会话（依赖摘要模型忠实度，只记录不判分）
try {
	await ev(`sendText("暗号是什么？只回复暗号本身。", [], null)`);
	await waitSettled();
	const last = await ev(`[...document.querySelectorAll(".msg.assistant")].at(-1)?.textContent ?? ""`);
	console.log(`${last.includes("ZEBRA-7391") ? "PASS" : "INFO"} 暗号跨会话（摘要忠实度）${last.includes("ZEBRA-7391") ? "" : "  回复: " + last.slice(0, 80)}`);
} catch (e) { console.log("INFO 暗号验证跳过:", String(e).slice(0, 100)); }

await shot("handoff");
console.log(fails ? `\n${fails} 项失败` : "\n全部通过 ✓");
process.exit(fails ? 1 : 0);
