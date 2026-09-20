// P72a 单测：纯逻辑层（src/renderer/p72-logic.js）——subagent 卡状态机 + 过程时间线聚合计数。
// p72-logic.js 是经典脚本（浏览器 <script src> 加载挂 globalThis.P72），Node 侧用 import 副作用读取。
import assert from "node:assert/strict";
import "../src/renderer/p72-logic.js";

const P72 = globalThis.P72;

let total = 0;
const ok = (name, fn) => {
	total++;
	try { fn(); console.log(`PASS ${name}`); }
	catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

/* ① subagent 卡状态映射：四态齐全，未知状态按「派发中」兜底（不造假终态） */
ok("subagentStatus 四态映射与未知兜底", () => {
	assert.deepEqual(P72.subagentStatus("running"), { label: "运行中", cls: "run" });
	assert.deepEqual(P72.subagentStatus("done"), { label: "已完成", cls: "done" });
	assert.deepEqual(P72.subagentStatus("error"), { label: "已失败", cls: "err" });
	assert.deepEqual(P72.subagentStatus("cancelled"), { label: "已取消", cls: "cancel" });
	assert.deepEqual(P72.subagentStatus("dispatching"), { label: "派发中", cls: "run" });
	assert.deepEqual(P72.subagentStatus(undefined), { label: "派发中", cls: "run" });
});

/* ② 终态判定：done/error/cancelled 终态，running 非终态 */
ok("subagentTerminal 终态判定", () => {
	assert.equal(P72.subagentTerminal("done"), true);
	assert.equal(P72.subagentTerminal("error"), true);
	assert.equal(P72.subagentTerminal("cancelled"), true);
	assert.equal(P72.subagentTerminal("running"), false);
	assert.equal(P72.subagentTerminal("weird"), false);
});

/* ③ 折叠策略：完成/取消默认折叠，失败保持展开（用户要看原因），运行中绝不折叠 */
ok("subagentShouldAutoCollapse：完成折叠、失败展开", () => {
	assert.equal(P72.subagentShouldAutoCollapse("done"), true);
	assert.equal(P72.subagentShouldAutoCollapse("cancelled"), true);
	assert.equal(P72.subagentShouldAutoCollapse("error"), false);
	assert.equal(P72.subagentShouldAutoCollapse("running"), false);
});

/* ④ 统计文案：工具事件透传（steps>0）→「N 个步骤」；没透传且在跑 →「后台执行中」不放假数字；
   终态至少给耗时；耗时=endedAt/now-started，向上取整最少 1s */
ok("subagentStats：步骤数真实透传才显示", () => {
	const t0 = 1_000_000;
	// 透传了 3 个工具事件，运行中
	assert.equal(P72.subagentStats({ status: "running", steps: 3, started: t0 }, t0 + 40_000), "3 个步骤 · 40s");
	// 没透传（steps=0/缺失），运行中 → 后台执行中
	assert.equal(P72.subagentStats({ status: "running", steps: 0, started: t0 }, t0 + 5_000), "后台执行中 · 5s");
	assert.equal(P72.subagentStats({ status: "running", started: t0 }, t0 + 5_000), "后台执行中 · 5s");
	// 完成（steps=0）→ 只显示耗时，不显示「后台执行中」
	assert.equal(P72.subagentStats({ status: "done", started: t0, endedAt: t0 + 2_100 }, 0), "2s");
	// 完成（steps>0）→ 步骤 + 耗时定格（endedAt 优先于 now）
	assert.equal(P72.subagentStats({ status: "done", steps: 7, started: t0, endedAt: t0 + 70_000 }, 999_999_999), "7 个步骤 · 70s");
	// 失败同理
	assert.equal(P72.subagentStats({ status: "error", steps: 1, started: t0, endedAt: t0 + 1_400 }, 0), "1 个步骤 · 1s");
	// 取消
	assert.equal(P72.subagentStats({ status: "cancelled", started: t0, endedAt: t0 + 30_000 }, 0), "30s");
	// 边界：负耗时/缺 started 兜底 1s
	assert.equal(P72.subagentStats({ status: "done", started: t0, endedAt: t0 - 9_000 }, 0), "1s");
	assert.equal(P72.subagentStats({ status: "running" }, 0), "后台执行中 · 1s");
	// 耗时秒数四舍五入（1.4s→1s，1.6s→2s）
	assert.equal(P72.subagentStats({ status: "running", started: t0 }, t0 + 1_400), "后台执行中 · 1s");
	assert.equal(P72.subagentStats({ status: "running", started: t0 }, t0 + 1_600), "后台执行中 · 2s");
});

/* ⑤ 过程时间线折叠条：streaming 中「处理中 · N 个步骤」实时累加；完成后「已工作 X 秒 · N 个步骤」 */
ok("stepsGroupLabel：处理中实时计数 / 完成后定格耗时", () => {
	assert.equal(P72.stepsGroupLabel(0, 0, false), "处理中 · 0 个步骤");
	assert.equal(P72.stepsGroupLabel(1, 0, false), "处理中 · 1 个步骤");
	assert.equal(P72.stepsGroupLabel(12, 0, false), "处理中 · 12 个步骤");
	assert.equal(P72.stepsGroupLabel(12, 40, true), "已工作 40 秒 · 12 个步骤");
	// 完成态耗时段向下兼容 0（最少显示 1 秒）
	assert.equal(P72.stepsGroupLabel(3, 0, true), "已工作 1 秒 · 3 个步骤");
	// 负数/undefined 计数兜底 0，不显示负数
	assert.equal(P72.stepsGroupLabel(-2, 0, false), "处理中 · 0 个步骤");
	assert.equal(P72.stepsGroupLabel(undefined, 3, true), "已工作 3 秒 · 0 个步骤");
});

/* ⑥ 状态机组合：一条完整生命周期的关键转移点（派发→运行→完成）各字段联动正确 */
ok("完整生命周期：派发→运行中→已完成 的文案联动", () => {
	const t0 = 1_000_000;
	const dispatch = { status: "running", steps: 0, started: t0 };
	assert.equal(P72.subagentStatus(dispatch.status).label, "运行中");
	assert.equal(P72.subagentStats(dispatch, t0 + 500), "后台执行中 · 1s");
	assert.equal(P72.subagentShouldAutoCollapse(dispatch.status), false);

	const done = { status: "done", steps: 4, started: t0, endedAt: t0 + 66_000 };
	assert.equal(P72.subagentStatus(done.status).label, "已完成");
	assert.equal(P72.subagentStats(done, 0), "4 个步骤 · 66s");
	assert.equal(P72.subagentShouldAutoCollapse(done.status), true);
});

console.log(`\nunit-p72a: ${total} 组断言`);
