// E2E P35：向 Claude Code 学习三部曲
// ① TodoWrite 任务清单（todo_write 工具 + 输入框上方进度条渲染）
// ② Plan Mode 计划模式（只读拦截 + 计划输出 + 批准后自动切回执行）
// ③ # 快捷记忆（# 开头一句话追加进工作区 AGENTS.md，不发给模型）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
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
const waitSettled = async (timeout = 120000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const s = await ev(`({ streaming: state.streaming, has: !!state.session })`);
		if (s.has && !s.streaming) return true;
		await sleep(1500);
	}
	return false;
};

/* 会话前置（绑定演示工作区） */
const ws = path.join(os.homedir(), "p35-e2e");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(path.join(ws, "src"), { recursive: true });
fs.writeFileSync(path.join(ws, "README.md"), "# P35 演示\n");
fs.writeFileSync(path.join(ws, "src", "lib.js"), "export function add(a, b) { return a + b; }\n");
await ev(`startSession(${JSON.stringify(ws.replace(/\\/g, "/"))}).then(() => null)`);
await sleep(1500);
ok("会话已启动", await ev(`!!state.session`));

/* ---- ① TodoWrite 任务清单 ---- */
await ev(`sendText("请用 todo_write 工具建立 3 项清单（1.读 src/lib.js 2.在 src/lib.js 加 mul 函数 3.更新 README 提及 mul），然后逐项执行完成，全程用清单跟踪。", [])`);
let todoSeen = false;
let todoDone = 0;
for (let i = 0; i < 80; i++) {
	await sleep(1500);
	const t = await ev(`(function(){ const bar = document.getElementById("todo-bar"); if (bar.hidden) return JSON.stringify({ seen: false }); const items = [...document.querySelectorAll(".todo-item")]; return JSON.stringify({ seen: true, n: items.length, done: items.filter((e) => e.classList.contains("done")).length, prog: document.getElementById("todo-progress").textContent }); })()`);
	const st = JSON.parse(t);
	if (st.seen) { todoSeen = true; todoDone = st.done; if (st.done >= 3) break; }
}
await waitSettled();
ok("任务清单条出现", todoSeen);
ok("清单 3 项全部勾选完成", todoDone >= 3, `done=${todoDone}`);
const mulAdded = fs.readFileSync(path.join(ws, "src", "lib.js"), "utf8").includes("mul");
ok("清单对应的实际工作也完成（mul 已加）", mulAdded);
await shot("p35-todo.png");

/* ---- ② Plan Mode ---- */
await ev(`(function(){ const sel = document.getElementById("approval-select"); sel.value = "plan"; sel.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await sleep(600);
ok("模式已切到计划模式", (await ev(`document.getElementById("approval-select").value`)) === "plan");
await ev(`sendText("把当前时间字符串写进 src/now.txt（内容随意），写完告诉我。", [])`);
await waitSettled();
const nowBlocked = !fs.existsSync(path.join(ws, "src", "now.txt"));
ok("计划模式下写文件被拦截（now.txt 不存在）", nowBlocked);
const planBarShown = await ev(`!document.getElementById("plan-bar").hidden`);
ok("AI 回合结束后计划卡片出现", planBarShown);
const planCard = await ev(`(function(){ return JSON.stringify({ goal: document.getElementById("plan-goal").textContent, steps: document.querySelectorAll(".plan-step").length, count: document.getElementById("plan-steps-count").textContent }); })()`);
const pc = JSON.parse(planCard);
ok("计划卡片含结构化 goal", pc.goal.length > 0, pc.goal.slice(0, 40));
ok("计划卡片含步骤列表 ≥1", pc.steps >= 1, `steps=${pc.steps} ${pc.count}`);
await shot("p35-plan.png");
// 批准执行 → 自动切回上一档 + 发送"计划已批准"
await ev(`document.getElementById("btn-plan-approve").click(); null`);
let executed = false;
for (let i = 0; i < 50; i++) {
	await sleep(1500);
	if (fs.existsSync(path.join(ws, "src", "now.txt"))) { executed = true; break; }
}
await waitSettled();
ok("批准后自动执行（now.txt 已生成）", executed);
ok("批准后模式自动切回", (await ev(`document.getElementById("approval-select").value`)) !== "plan");
await shot("p35-plan-approved.png");

/* ---- ③ # 快捷记忆 ---- */
const marker = `P35-MEMO-${Date.now()}`;
await ev(`sendText("# 记住：本项目的构建命令是 ${marker}", [])`);
await sleep(1000);
const agentsMd = fs.existsSync(path.join(ws, "AGENTS.md")) ? fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8") : "";
ok("# 记忆已写入 AGENTS.md", agentsMd.includes(marker));
const sysMemo = await ev(`[...document.querySelectorAll(".sysline")].map((e) => e.textContent).join(" || ")`);
ok("记忆 sysline 反馈", sysMemo.includes("已记忆"));
ok("记忆未走模型（无 streaming）", !(await ev(`state.streaming`)));
/* 记忆管理面板：发空 # 打开 → 列出 → 删除一条 */
await ev(`sendText("#", [])`);
await sleep(800);
ok("空 # 打开记忆面板", await ev(`!document.getElementById("memory-mask").hidden`));
const memCount = await ev(`document.querySelectorAll(".memory-item").length`);
ok("面板列出记忆条目 ≥1", memCount >= 1, `items=${memCount}`);
await ev(`document.querySelector(".memory-del").click(); null`);
await sleep(600);
const agentsMd2 = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
ok("删除后 AGENTS.md 少一条", agentsMd2.split("\n").filter((l) => l.startsWith("- （")).length === memCount - 1);
await ev(`document.getElementById("memory-close").click(); null`);
ok("关闭面板", await ev(`document.getElementById("memory-mask").hidden`));
await shot("p35-memory.png");

console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
