// E2E P28：MCP 桥（mcp.json 配置 → 连接 → 工具注册 → Agent 真实调用 → 设置页状态卡）
// 前置：应用带 --remote-debugging-port=9333 启动；mcp.json 指向本地 echo server
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
	fs.writeFileSync(name, Buffer.from(r.data, "base64"));
	console.log(`📸 ${name}`);
};
let total = 0;
let fails = 0;
const ok = (name, cond, extra = "") => {
	total++;
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
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

/* ---- 1. IPC 状态：echo server 已连接、2 个工具 ---- */
// MCP ensure 是 stdio spawn（受 CPU/杀扫拖慢）：轮询等就绪，上限 30s（踩坑 #80：一次性查询遇 spawn 慢必炸）
let st = null;
for (let i = 0; i < 30; i++) {
	st = await ev(`window.openpi.mcpStatus()`);
	if (st?.ready && (st.status ?? []).find((s) => s.name === "echo")?.ok) break;
	await sleep(1000);
}
ok("mcp:status 就绪", st && st.ready);
const echoSt = (st.status ?? []).find((s) => s.name === "echo");
ok("echo server 已连接", echoSt && echoSt.ok === true, JSON.stringify(st.status));
ok("工具数 = 2", echoSt && echoSt.toolCount === 2, String(echoSt?.toolCount));

/* ---- 2. 会话里注册了 mcp__echo__* 工具（启动头部/系统提示词间接验证：直接问 Agent） ---- */
await waitSettled(60000);
await ev(`sendText("列出你当前可用的所有工具名。只输出工具名列表本身，一行一个，不要解释。", [])`);
ok("工具清单问答 settle", await waitSettled());
const lastAssistant = await ev(`(() => { const msgs = [...document.querySelectorAll("#chat .msg")]; for (let i = msgs.length - 1; i >= 0; i--) { const b = msgs[i].querySelector(".msg-body, .md, .content, p"); if (b && b.textContent) return b.textContent; } return ""; })()`);
ok("Agent 感知 mcp__echo__echo", /mcp__echo__echo/.test(lastAssistant || ""), (lastAssistant || "").slice(0, 120).replace(/\n/g, " "));

/* ---- 3. Agent 真实调用 MCP 工具（先切 full-auto：MCP 工具属未知工具，auto-edit 会弹审批窗阻塞 E2E） ---- */
await ev(`(async () => { const sel = document.getElementById("approval-select"); sel.value = "full-auto"; sel.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await sleep(500);
await ev(`sendText("调用 mcp__echo__echo 工具，text 参数填 PING-42，然后把工具返回的原样告诉我。", [])`);
ok("工具调用轮 settle", await waitSettled());
const chatText = await ev(`document.getElementById("chat").textContent`);
ok("会话出现 ECHO:PING-42", typeof chatText === "string" && chatText.includes("ECHO:PING-42"));
const addOk = await ev(`(async () => { return await window.openpi.mcpStatus().then((r) => r.toolCount === 2); })()`);
ok("调用后连接仍健康", addOk === true);

/* ---- 4. 设置页 MCP 卡片 ---- */
await ev(`openSettings(); null`);
await sleep(500);
ok("MCP 卡片可见", await ev(`!$("mcp-card").hidden && !!document.getElementById("mcp-card")`));
const cardText = await ev(`$("mcp-list").textContent`);
ok("卡片列出 echo 与工具数", cardText.includes("echo") && cardText.includes("2"), cardText.slice(0, 80));

/* 重连 */
const rc = await ev(`window.openpi.mcpReconnect()`);
ok("重连成功", rc && rc.status.some((s) => s.name === "echo" && s.ok) && rc.toolCount === 2);

await ev(`$("btn-settings-close").click(); null`);
await shot("p28-mcp.png");

console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
