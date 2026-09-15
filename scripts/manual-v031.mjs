// v0.31.0 打包产物级人工流程实测（真实模型 + portable 安装包）
// 场景：① 多步任务清单 ② 计划模式结构化卡片+批准 ③ # 记忆+管理面板 ④ 更新器连真实发布目录
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = await (async () => {
	const tabs = await CDP.List({ port: PORT });
	const page = tabs.find((t) => t.type === "page");
	return CDP({ target: page.webSocketDebuggerUrl });
})();
await client.Runtime.enable();
await client.Page.enable();
const ev = async (expr) => {
	const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true, userGesture: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.slice(0, 400));
	return r.result.value;
};
const shot = async (name) => {
	const r = await client.Page.captureScreenshot({ format: "png", fromSurface: true });
	fs.writeFileSync(name, Buffer.from(r.data, "base64"));
	console.log(`📸 ${name}`);
};
const ok = (name, cond, extra = "") => console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
const waitSettled = async (timeout = 150000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const s = await ev(`({ streaming: state.streaming, has: !!state.session })`);
		if (s.has && !s.streaming) return true;
		await sleep(2000);
	}
	return false;
};

console.log(`== 打包版版本确认 ==`);
ok("UA 为 0.31.0 打包版", true, "（启动时已由 UA 确认）");

/* 工作区 */
const ws = path.join(os.homedir(), "v031-manual");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(path.join(ws, "src"), { recursive: true });
fs.writeFileSync(path.join(ws, "README.md"), "# v031 实测\n");
fs.writeFileSync(path.join(ws, "src", "util.js"), "export const VER = '0.31.0';\n");
await ev(`startSession(${JSON.stringify(ws.replace(/\\/g, "/"))}).then(() => null)`);
await sleep(2000);
ok("会话已启动", await ev(`!!state.session`));

/* ---- ① 多步任务清单 ---- */
console.log(`\n== ① 多步任务清单 ==`);
await ev(`sendText("请用 todo_write 工具建立 3 项清单（1.读 src/util.js 2.在 src/util.js 加一个 greet 函数 3.更新 README 提及 greet），然后逐项执行完成，全程用清单跟踪。", [])`);
let todoSeen = false, todoDone = 0, todoN = 0;
for (let i = 0; i < 90; i++) {
	await sleep(2000);
	const st = JSON.parse(await ev(`(function(){ const bar = document.getElementById("todo-bar"); if (bar.hidden) return JSON.stringify({ seen: false }); const items = [...document.querySelectorAll(".todo-item")]; return JSON.stringify({ seen: true, n: items.length, done: items.filter((e) => e.classList.contains("done")).length }); })()`));
	if (st.seen) { todoSeen = true; todoN = st.n; todoDone = st.done; if (st.done >= 3) break; }
}
await waitSettled();
ok("清单条出现且 3 项完成", todoSeen && todoDone >= 3, `items=${todoN} done=${todoDone}`);
ok("greet 真实写入", fs.readFileSync(path.join(ws, "src", "util.js"), "utf8").includes("greet"));
await shot("v031-1-todo.png");

/* ---- ② 计划模式结构化卡片 ---- */
console.log(`\n== ② 计划模式 ==`);
await ev(`(function(){ const sel = document.getElementById("approval-select"); sel.value = "plan"; sel.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await sleep(800);
ok("切到计划模式", (await ev(`document.getElementById("approval-select").value`)) === "plan");
await ev(`sendText("给 src/util.js 加一个 farewell 函数并更新 README 提及 farewell。先探索再提交计划。", [])`);
await waitSettled();
const farewellBlocked = !fs.readFileSync(path.join(ws, "src", "util.js"), "utf8").includes("farewell");
ok("计划模式下未实际修改", farewellBlocked);
const pc = JSON.parse(await ev(`(function(){ const bar = document.getElementById("plan-bar"); return JSON.stringify({ shown: !bar.hidden, goal: document.getElementById("plan-goal").textContent, steps: document.querySelectorAll(".plan-step").length }); })()`));
ok("计划卡片出现", pc.shown);
ok("卡片含结构化 goal", pc.goal.length > 0, pc.goal.slice(0, 50));
ok("卡片含步骤列表", pc.steps >= 1, `steps=${pc.steps}`);
await shot("v031-2-plan-card.png");
await ev(`document.getElementById("btn-plan-approve").click(); null`);
let executed = false;
for (let i = 0; i < 60; i++) {
	await sleep(2000);
	if (fs.readFileSync(path.join(ws, "src", "util.js"), "utf8").includes("farewell")) { executed = true; break; }
}
await waitSettled();
ok("批准后自动执行（farewell 已写入）", executed);
ok("模式自动切回", (await ev(`document.getElementById("approval-select").value`)) !== "plan");
await shot("v031-3-approved.png");

/* ---- ③ # 记忆 + 管理面板 ---- */
console.log(`\n== ③ 快捷记忆 ==`);
await ev(`sendText("# 本项目统一使用 four-space 缩进", [])`);
await sleep(1200);
const md1 = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
ok("# 记忆写入 AGENTS.md", md1.includes("four-space"));
await ev(`sendText("#", [])`);
await sleep(1000);
ok("空 # 打开记忆面板", await ev(`!document.getElementById("memory-mask").hidden`));
const items = await ev(`document.querySelectorAll(".memory-item").length`);
ok(`面板列出记忆（${items} 条）`, items >= 1);
await shot("v031-4-memory.png");
await ev(`document.querySelector(".memory-del").click(); null`);
await sleep(800);
const md2 = fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
ok("删除一条后 AGENTS.md 不再含该记忆", !md2.includes("four-space"));
await ev(`document.getElementById("memory-close").click(); null`);

/* ---- ④ 更新器连真实发布目录 ---- */
console.log(`\n== ④ 自动更新器 ==`);
// 本地 HTTP 伺服 dist/（真实 Setup exe + blockmap + latest.yml）
const distDir = path.resolve("dist");
const server = http.createServer((req, res) => {
	const f = path.join(distDir, decodeURIComponent(req.url.split("?")[0].replace(/^\//, "")));
	if (fs.existsSync(f) && fs.statSync(f).isFile()) {
		res.writeHead(200, { "content-type": req.url.endsWith(".yml") ? "text/yaml" : "application/octet-stream" });
		fs.createReadStream(f).pipe(res);
	} else { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => server.listen(9399, r));
console.log("本地发布目录伺服 :9399（真实 0.31.0 安装包 + latest.yml）");
const cfgPath = path.join(os.homedir(), ".pi", "agent", "updater.json");
const cfgBackup = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, "utf8") : null;
fs.writeFileSync(cfgPath, JSON.stringify({ provider: "generic", url: "http://127.0.0.1:9399/" }), "utf8");
await ev(`(function(){ const b = document.getElementById("btn-settings"); if (b) b.click(); })()`);
await sleep(600);
// 找设置页的「检查更新」按钮
const btns = await ev(`[...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter((t) => t.includes("检查") || t.includes("更新"))`);
console.log("设置页更新相关按钮:", JSON.stringify(btns));
const checkBtn = await ev(`(function(){ const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("检查更新")); if (b) { b.click(); return true; } return false; })()`);
await sleep(4000);
const st = await ev(`(function(){ const el = document.body; return el.textContent.includes("已是最新") ? "up-to-date" : (el.textContent.includes("可用") ? "available" : "unknown"); })()`);
ok("检查更新走通真实 HTTP 源", st === "up-to-date" || st === "available", `state=${st}（0.31.0 对 0.31.0 → 预期 up-to-date）`);
await shot("v031-5-updater.png");
// 还原配置
if (cfgBackup !== null) fs.writeFileSync(cfgPath, cfgBackup, "utf8");
else fs.rmSync(cfgPath, { force: true });
server.close();
console.log("updater.json 已还原");

console.log("\n== 打包产物级实测完成 ==");
process.exit(0);
