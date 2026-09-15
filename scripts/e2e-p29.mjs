// E2E P29：full-auto 护栏 + 审计日志
// 断言：full-auto 普通命令直通；RISKY 命令强制弹确认（全自动档不放行）；批准后执行；审计日志落盘且 decision 正确
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const chatText = () => ev(`document.getElementById("chat").textContent`);

/* ---- 0. 切 full-auto + 记录审计基线 ---- */
await ev(`(async () => { const sel = document.getElementById("approval-select"); sel.value = "full-auto"; sel.dispatchEvent(new Event("change", { bubbles: true })); })()`);
await sleep(500);
const auditPath = path.join(os.homedir(), ".pi", "agent", "audit", new Date().toISOString().slice(0, 10) + ".jsonl");
const baseline = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean).length : 0;

/* ---- 1. full-auto 普通命令直通（无弹窗） ---- */
await ev(`sendText("运行命令 echo SAFE-AUTO-42，把命令输出原样告诉我，不要做其他事。", [])`);
ok("普通命令轮 settle", await waitSettled());
ok("SAFE-AUTO-42 已执行", String(await chatText()).includes("SAFE-AUTO-42"));
ok("过程中无审批弹窗", await ev(`!document.body.contains(document.querySelector(".ui-ok"))`) === true);

/* ---- 2. 创建靶目录（full-auto 直通） ---- */
await ev(`sendText("运行命令 mkdir -p ~/openpi-workspace/p29-doomed && echo hi > ~/openpi-workspace/p29-doomed/x.txt，不要做其他事。", [])`);
ok("建靶目录轮 settle", await waitSettled());
const doomed = path.join(os.homedir(), "openpi-workspace", "p29-doomed");
ok("靶目录已存在", fs.existsSync(doomed));

/* ---- 3. 危险命令：full-auto 仍强制弹确认（Observer 事件化断言 + 自动点击，不与人竞速） ---- */
await ev(`(() => {
	window.__uiPopups = [];
	const mo = new MutationObserver(() => {
		document.querySelectorAll(".modal-mask").forEach((m) => {
			const okBtn = m.querySelector(".ui-ok");
			if (okBtn && m.textContent.includes("危险命令确认") && !m.dataset.autoclicked) {
				m.dataset.autoclicked = "1";
				window.__uiPopups.push(m.querySelector(".modal-head")?.textContent ?? "?");
				setTimeout(() => okBtn.click(), 600);
			}
		});
	});
	mo.observe(document.body, { childList: true, subtree: true });
})()`);
await ev(`sendText("运行命令 rm -rf ~/openpi-workspace/p29-doomed，不要做其他事。", [])`);
ok("批准后 settle（含弹窗自动批准）", await waitSettled());
const popups = await ev(`window.__uiPopups`);
ok("危险命令触发审批弹窗", Array.isArray(popups) && popups.some((t) => String(t).includes("危险命令确认")), JSON.stringify(popups));
ok("命令已执行（目录已删）", !fs.existsSync(doomed));
await shot("p29-guard.png");

/* ---- 4. 审计日志断言 ---- */
await sleep(800);
const lines = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").split("\n").filter(Boolean).slice(baseline) : [];
const recs = lines.map((l) => JSON.parse(l));
ok("审计记录数 > 0", recs.length >= 3, String(recs.length));
ok("审计含 auto-allow(echo)", recs.some((r) => r.decision === "auto-allow" && r.input.includes("SAFE-AUTO-42")));
ok("审计含 risk-confirm(rm -rf)", recs.some((r) => r.decision === "risk-confirm" && r.input.includes("rm -rf") && r.input.includes("p29-doomed")));
ok("审计字段完整", recs.every((r) => r.ts && r.tool && r.mode === "full-auto" && r.session));

console.log(fails ? `\n${total - fails}/${total} 通过` : `\n全部通过 ✓ ${total}/${total}`);
process.exit(fails ? 1 : 0);
