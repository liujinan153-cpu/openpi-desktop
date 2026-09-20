// P73 单测：子智能体管理纯逻辑（src/main/p73-logic.mjs）——文件名清洗 / JSON 校验 / 禁用清单合并回退
import assert from "node:assert/strict";
import { BUILTIN_SUBAGENT_META, sanitizeSubagentFilename, parseSubagentJsonFile, resolveWorkerRole } from "../src/main/p73-logic.mjs";
import "../src/renderer/p73-skills-logic.js"; // P73 第二批：技能页筛选/计数纯逻辑（globalThis.P73SKILLS）
import "../src/renderer/p72-logic.js"; // P74：界面缩放钳制纯逻辑（globalThis.P72.clampZoom）

let total = 0;
const ok = (name, fn) => {
	total++;
	try { fn(); console.log(`PASS ${name}`); }
	catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

/* ① 角色文件名清洗：Windows 非法字符 / 首尾点空格 / 空名回退 / 超长截断 */
ok("sanitizeSubagentFilename 清洗非法字符与回退", () => {
	assert.equal(sanitizeSubagentFilename('docs:writer?v2'), "docs-writer-v2");
	assert.equal(sanitizeSubagentFilename('a*b"c<d>e|f\\g'), "a-b-c-d-e-f-g");
	assert.equal(sanitizeSubagentFilename("  ..名字.. "), "名字"); // Windows 尾点/尾空格是坑
	assert.equal(sanitizeSubagentFilename(""), "subagent"); // 空名回退
	assert.equal(sanitizeSubagentFilename("???"), "---"); // 全非法字符 → 全替换成 -（非空，不触发回退）
	assert.equal(sanitizeSubagentFilename("///"), "---"); // 同上（路径分隔符也是非法字符）
	assert.ok(sanitizeSubagentFilename("长".repeat(100)).length <= 60); // 超长截断
});
/* ② subagents JSON 校验：合法规范化 / 坏文件（坏 JSON、缺 name、非对象、tools 非数组）返回 null 跳过 */
ok("parseSubagentJsonFile 合法规范化与坏文件跳过", () => {
	const good = parseSubagentJsonFile("docs-writer.json", JSON.stringify({ name: "文档写手", desc: "写文档", tools: ["write", " edit ", "", 3], prefix: "你是文档写手" }));
	assert.deepEqual(good, { id: "docs-writer", name: "文档写手", desc: "写文档", tools: ["write", "edit", "3"], prefix: "你是文档写手" });
	assert.equal(parseSubagentJsonFile("bad.json", "{不是JSON"), null); // 坏 JSON
	assert.equal(parseSubagentJsonFile("no-name.json", JSON.stringify({ desc: "缺 name" })), null); // 缺 name
	assert.equal(parseSubagentJsonFile("arr.json", "[1,2]"), null); // 顶层是数组
	assert.equal(parseSubagentJsonFile("num.json", "42"), null); // 顶层是数字
	assert.equal(parseSubagentJsonFile(".json", "{}"), null); // 空文件名
	const minimal = parseSubagentJsonFile("mini.json", JSON.stringify({ name: "最小" }));
	assert.deepEqual(minimal, { id: "mini", name: "最小", desc: "", tools: [], prefix: "" }); // 可选字段全兜底
});

/* ③ 禁用清单合并回退：未知角色→explore；被禁用→回退 explore 并注明「该角色已被禁用」；自定义角色可用 */
ok("resolveWorkerRole 未知/禁用回退与自定义合并", () => {
	const builtin = ["explore", "coder", "tester", "reviewer"];
	const customs = [{ id: "docs-writer", name: "文档写手" }, { id: "tmp", name: "临时" }];
	// 正常内置角色
	assert.deepEqual(resolveWorkerRole("coder", builtin, customs, []), { role: "coder", note: "", custom: null });
	// 未知角色 → explore 兜底
	assert.deepEqual(resolveWorkerRole("ghost", builtin, customs, []), { role: "explore", note: "", custom: null });
	assert.deepEqual(resolveWorkerRole(undefined, builtin, customs, []), { role: "explore", note: "", custom: null });
	// 被禁用 → 回退 explore + 注明（文案含「该角色已被禁用」）
	const dis = resolveWorkerRole("coder", builtin, customs, ["coder"]);
	assert.equal(dis.role, "explore");
	assert.ok(dis.note.includes("该角色已被禁用"), `note=${dis.note}`);
	// 被禁用的自定义角色同样回退
	const disCustom = resolveWorkerRole("docs-writer", builtin, customs, ["docs-writer"]);
	assert.equal(disCustom.role, "explore");
	assert.ok(disCustom.note.includes("该角色已被禁用"));
	// 可用的自定义角色 → custom 定义返回（agent-host 据此合成 roleDef）
	const useCustom = resolveWorkerRole("docs-writer", builtin, customs, []);
	assert.equal(useCustom.role, "docs-writer");
	assert.equal(useCustom.custom.id, "docs-writer");
	// explore 本身被禁 → 仍以 explore 只读基座兜底（不能没有兜底角色），注明
	const disExplore = resolveWorkerRole("explore", builtin, customs, ["explore"]);
	assert.equal(disExplore.role, "explore");
	assert.ok(disExplore.note.includes("explore"), `note=${disExplore.note}`);
});

/* ④ 内置角色元数据表：四角色齐全、id/tools 与 agent-host WORKER_ROLES.extraTools 对齐（设置页展示与运行时不脱节） */
ok("BUILTIN_SUBAGENT_META 四角色与工具白名单对齐", () => {
	assert.deepEqual(BUILTIN_SUBAGENT_META.map((r) => r.id), ["explore", "coder", "tester", "reviewer"]);
	const byId = Object.fromEntries(BUILTIN_SUBAGENT_META.map((r) => [r.id, r]));
	assert.deepEqual(byId.explore.tools, []);
	assert.deepEqual(byId.coder.tools, ["write", "edit", "run_cmd"]);
	assert.deepEqual(byId.tester.tools, ["run_cmd"]);
	assert.deepEqual(byId.reviewer.tools, []);
	for (const r of BUILTIN_SUBAGENT_META) { assert.ok(r.name, `${r.id} 缺 name`); assert.ok(r.desc, `${r.id} 缺 desc`); }
});

/* ⑤ P73 第二批：技能搜索过滤（名称/中文描述/英文描述回退，空串全过，大小写不敏感） */
const P73 = globalThis.P73SKILLS;
ok("skillMatchQuery 名称/描述过滤与空串全过", () => {
	assert.ok(P73, "P73SKILLS 未挂载");
	const s = { name: "weekly-report", description: "Generate weekly report", descriptionZh: "生成周报" };
	assert.equal(P73.skillMatchQuery(s, ""), true); // 空串全过
	assert.equal(P73.skillMatchQuery(s, null), true); // 无搜索词全过
	assert.equal(P73.skillMatchQuery(s, "WEEKLY"), true); // 大小写不敏感
	assert.equal(P73.skillMatchQuery(s, "周报"), true); // 命中中文描述
	assert.equal(P73.skillMatchQuery(s, "invoice"), false);
	const noZh = { name: "docx", description: "Word documents" };
	assert.equal(P73.skillMatchQuery(noZh, "word"), true); // 无中文描述回退英文原文
	assert.equal(P73.skillMatchQuery(noZh, "pdf"), false);
	assert.equal(P73.skillMatchQuery(null, ""), true); // 脏数据不抛错
});
/* ⑥ P73 第二批：chips 计数与单选可见性（全部=两组；全局/项目=只显示对应小节） */
ok("skillChipCounts / skillSectionVisibility", () => {
	assert.deepEqual(P73.skillChipCounts(3, 2), { all: 5, global: 3, project: 2 });
	assert.deepEqual(P73.skillChipCounts(0, 0), { all: 0, global: 0, project: 0 });
	assert.deepEqual(P73.skillChipCounts(undefined, null), { all: 0, global: 0, project: 0 }); // 脏数据兜底
	assert.deepEqual(P73.skillSectionVisibility("all"), { global: true, project: true });
	assert.deepEqual(P73.skillSectionVisibility("global"), { global: true, project: false });
	assert.deepEqual(P73.skillSectionVisibility("project"), { global: false, project: true });
	assert.deepEqual(P73.skillSectionVisibility(undefined), { global: true, project: true }); // 未知值兜底=全部
});
/* ⑦ P74：界面缩放钳制——边界 90/130、步进对齐 5、脏输入回落 100 */
const P72 = globalThis.P72;
ok("clampZoom 边界/步进/脏数据", () => {
	assert.ok(P72, "P72 未挂载");
	assert.equal(P72.clampZoom(100), 100);
	assert.equal(P72.clampZoom(105), 105);
	assert.equal(P72.clampZoom(80), 90); // 下界钳制
	assert.equal(P72.clampZoom(140), 130); // 上界钳制
	assert.equal(P72.clampZoom(103), 105); // 步进对齐 5（四舍五入）
	assert.equal(P72.clampZoom(97), 95);
	assert.equal(P72.clampZoom("115"), 115); // 字符串数字照常处理（range input 值）
	assert.equal(P72.clampZoom("abc"), 100); // 脏输入回落
	assert.equal(P72.clampZoom(NaN), 100);
	assert.equal(P72.clampZoom(undefined), 100);
});
console.log(`\nP73 unit: ${total} 组断言完成`);
