// P72b 单测：会话改动审阅纯逻辑——git 输出解析（src/main/review-changes.mjs）+ 展示格式化（src/renderer/p72-logic.js）。
// p72-logic.js 是经典脚本（浏览器 <script src> 加载挂 globalThis.P72），Node 侧用 import 副作用读取。
import assert from "node:assert/strict";
import { mergeChanges, parseNameStatus, parseNumstat, parsePorcelain, pickBaselineCommit } from "../src/main/review-changes.mjs";
import "../src/renderer/p72-logic.js";

const P72 = globalThis.P72;

let total = 0;
const ok = (name, fn) => {
	total++;
	try { fn(); console.log(`PASS ${name}`); }
	catch (err) { console.error(`FAIL ${name}: ${err.message}`); process.exitCode = 1; }
};

/* ① numstat 行解析：常规 / 二进制(- -) / 重命名两种格式 / 坏行跳过 */
ok("parseNumstat：常规+二进制+重命名容错+坏行跳过", () => {
	const out = parseNumstat([
		"12\t3\tsrc/a.js",
		"-\t-\tlogo.png",
		"1\t2\tsrc/old/{dir => newdir}/file.js", // 花括号重命名（git 真实格式：公共前缀 + {旧 => 新} + 后缀）
		"1\t0\tsrc/{a.js => b.js}", // 带增删列的花括号重命名 → 取新路径 b.js
		"2\t1\tsrc/old.js => src/new.js", // 箭头重命名 → 取新路径
		"garbage line",
		"",
	].join("\n"));
	assert.deepEqual(out[0], { file: "src/a.js", added: 12, deleted: 3, binary: false });
	assert.deepEqual(out[1], { file: "logo.png", added: 0, deleted: 0, binary: true });
	assert.equal(out[2].file, "src/old/newdir/file.js"); // 花括号重命名：前缀/后缀都拼回，只换中间段
	assert.equal(out[3].file, "src/b.js"); // 重命名取新路径，行数照记
	assert.equal(out[4].file, "src/new.js");
	assert.equal(out.length, 5); // 坏行不入列
});

/* ② name-status 解析：M/A/D + R100/C100 取新路径并降级为 M */
ok("parseNameStatus：MAD + R100 降级 M 取新路径", () => {
	const out = parseNameStatus([
		"M\tsrc/a.js",
		"A\tnew.txt",
		"D\tgone.txt",
		"R100\told.js\tnew.js",
		"C75\tsrc/x.js\tsrc/y.js",
	].join("\n"));
	assert.deepEqual(out[0], { status: "M", file: "src/a.js" });
	assert.deepEqual(out[1], { status: "A", file: "new.txt" });
	assert.deepEqual(out[2], { status: "D", file: "gone.txt" });
	assert.deepEqual(out[3], { status: "M", file: "new.js", prev: "old.js" });
	assert.deepEqual(out[4], { status: "M", file: "src/y.js", prev: "src/x.js" });
});

/* ③ porcelain 状态映射：?? → ?，重命名取 -> 新路径，引号路径去引号，## 分支行跳过 */
ok("parsePorcelain + mergeChanges：??/R/引号路径/分支行", () => {
	const pr = parsePorcelain([
		"?? new-file.log",
		"M  src/a.js",
		' R "带 空格 的 文件.txt"',
		"R  old.js -> new.js",
		"## main...origin/main",
		"",
	].join("\n"));
	assert.equal(pr[0].xy, "??");
	assert.equal(pr[0].file, "new-file.log");
	assert.equal(pr[1].file, "src/a.js");
	assert.equal(pr[2].file, "带 空格 的 文件.txt");
	assert.equal(pr[3].file, "new.js"); // 重命名取 -> 后的新路径
	assert.equal(pr.length, 4); // ## 分支行跳过
	// 合并：name-status 优先（带增删），porcelain 只补 ?? 未跟踪
	const merged = mergeChanges(
		parseNameStatus("M\tsrc/a.js"),
		parseNumstat("5\t2\tsrc/a.js"),
		pr
	);
	assert.equal(merged.length, 4); // src/a.js 来自 name-status；porcelain 只补 diff 里没有的 3 条（?? / 引号路径 / 重命名新路径）
	assert.deepEqual(merged.find((f) => f.file === "src/a.js"), { file: "src/a.js", status: "M", added: 5, deleted: 2, binary: false });
	assert.deepEqual(merged.find((f) => f.file === "new-file.log"), { file: "new-file.log", status: "?", added: 0, deleted: 0, binary: false });
});

/* ④ diffstat 展示格式化：+N 绿 / -N 红 / 二进制 / 双零空段 */
ok("diffStatParts：+N/-N/二进制/零段", () => {
	assert.deepEqual(P72.diffStatParts(12, 3, false), { plus: "+12", minus: "-3", text: "" });
	assert.deepEqual(P72.diffStatParts(5, 0, false), { plus: "+5", minus: "", text: "" });
	assert.deepEqual(P72.diffStatParts(0, 7, false), { plus: "", minus: "-7", text: "" });
	assert.deepEqual(P72.diffStatParts(0, 0, true), { plus: "", minus: "", text: "二进制" });
	assert.deepEqual(P72.diffStatParts(0, 0, false), { plus: "", minus: "", text: "" }); // 双零不占位
	assert.deepEqual(P72.diffStatParts(undefined, null, false), { plus: "", minus: "", text: "" }); // 缺字段兜底
});

/* ⑤ toast 文案单复数：1 张单数 / N 张复数 / 0 张不弹（空串） */
ok("pasteToastText：单复数与 0 张", () => {
	assert.equal(P72.pasteToastText(1), "已将 1 张图片保存到会话临时目录");
	assert.equal(P72.pasteToastText(3), "已将 3 张图片保存到会话临时目录");
	assert.equal(P72.pasteToastText(0), "");
	assert.equal(P72.pasteToastText(undefined), "");
	assert.equal(P72.pasteToastText(-2), ""); // 非法输入不弹
});

/* ⑥ token k 缩写：<1k 原样 / 12.3k / 123k 整数 / 1.2M */
ok("fmtTokCompact：k 缩写分档", () => {
	assert.equal(P72.fmtTokCompact(0), "0");
	assert.equal(P72.fmtTokCompact(999), "999");
	assert.equal(P72.fmtTokCompact(12300), "12.3k");
	assert.equal(P72.fmtTokCompact(123456), "123k");
	assert.equal(P72.fmtTokCompact(1234567), "1.2M");
	assert.equal(P72.fmtTokCompact(undefined), "0"); // 缺数据兜底（渲染层据此隐藏元素）
	assert.equal(P72.fmtTokCompact(-5), "0");
});

/* ⑤b 审阅清单行渲染（审核 dock 清单与 P72 面板共用的纯 HTML 构建） */
ok("reviewFileRowHtml：徽标/增删/二进制", () => {
	const html = P72.reviewFileRowHtml({ file: "src/app.js", status: "m", added: 12, deleted: 3, binary: false });
	assert.ok(html.includes('class="rp-file"'), html); // 行结构（审核 dock 复用同一渲染）
	assert.ok(html.includes("rp-badge rp-m") && html.includes(">M<"), html); // 小写状态归一为大写 M 徽标
	assert.ok(html.includes('class="rp-add">+12') && html.includes('class="rp-del">-3'), html); // +N 绿 / -N 红
	const bin = P72.reviewFileRowHtml({ file: "logo.png", status: "A", added: 0, deleted: 0, binary: true });
	assert.ok(bin.includes("二进制") && !bin.includes("rp-add") && !bin.includes("rp-del"), bin); // 二进制不出现增删段
});
ok("reviewFileRowHtml：未跟踪徽标与 HTML 转义", () => {
	const untracked = P72.reviewFileRowHtml({ file: "new.txt", status: "??" });
	assert.ok(untracked.includes("rp-badge rp-u") && untracked.includes(">?<"), untracked); // 非常规状态落 u 徽标
	const dirty = P72.reviewFileRowHtml({ file: 'a<b>&"x".js', status: "M", added: 1, deleted: 0 });
	assert.ok(dirty.includes("a&lt;b&gt;&amp;&quot;x&quot;.js"), dirty); // 文件名转义（title 与正文）
	const empty = P72.reviewFileRowHtml(null);
	assert.ok(empty.includes("rp-u") && empty.includes(">?<"), empty); // 缺数据兜底不抛
});


ok("pickBaselineCommit：时刻容差与回退", () => {
	const log = [
		"abc1234 2000",
		"def5678 1000",
		"aaa1111 900",
	].join("\n");
	assert.equal(pickBaselineCommit(log, 1500), "def5678"); // ≤ 1500 的最新一条
	assert.equal(pickBaselineCommit(log, 500), null); // 全部晚于 → 回退 HEAD
	assert.equal(pickBaselineCommit(log, Number.NaN), null); // 无有效时刻 → null
	assert.equal(pickBaselineCommit("", 1500), null);
	assert.equal(pickBaselineCommit(log, 1998), "abc1234"); // 同拍误差容差内（2000 ≤ 1998+2）
	assert.equal(pickBaselineCommit(log, 1997), "def5678"); // 容差外不算
});
