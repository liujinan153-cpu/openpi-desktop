/* P72b：会话改动审阅——git 输出解析纯函数（无 IO / 无 Electron 依赖）。
 * 设计：解析与编排分离——本文件只做「git 文本输出 → 结构」；
 * git 执行（gitQuiet）与基线选择（resolveReviewBaseline）在 main.mjs，
 * 两者都无状态，scripts/unit-p72b.mjs 直接 import 本文件做单测。 */

/** 重命名路径规整：`{old => new}`（含前后缀）与 `old => new` 两种 numstat 形式都取新路径 */
export function normalizeRename(p) {
	const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(p);
	if (brace) return brace[1] + brace[3] + brace[4]; // {旧 => 新}：整段替换成新段（前缀 + 新段 + 后缀）
	const arrow = /^(.*) => (.*)$/.exec(p);
	return arrow ? arrow[2] : p;
}

/** 解析 `git diff --numstat`：`added\tdeleted\tpath`；二进制行 `-\t-\tpath`；坏行跳过不让单行毁掉整个列表 */
export function parseNumstat(text) {
	const out = [];
	for (const line of String(text ?? "").split("\n")) {
		if (!line.trim()) continue;
		const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
		if (!m) continue;
		out.push({
			file: normalizeRename(m[3]),
			added: m[1] === "-" ? 0 : Number(m[1]),
			deleted: m[2] === "-" ? 0 : Number(m[2]),
			binary: m[1] === "-",
		});
	}
	return out;
}

/** 解析 `git diff --name-status`：`M\tpath` / `A\tpath` / `D\tpath` / `R100\told\tnew` / `C100\told\tnew`。
 *  R（重命名）简化按 M 呈现并取新路径（渲染层语义色只有 M/A/D/? 四档）。 */
export function parseNameStatus(text) {
	const out = [];
	for (const line of String(text ?? "").split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		const st = (parts[0] || "?").charAt(0).toUpperCase();
		if ((st === "R" || st === "C") && parts.length >= 3) {
			out.push({ status: "M", file: parts[2], prev: parts[1] });
		} else if (parts.length >= 2) {
			out.push({ status: st, file: parts.slice(1).join("\t") });
		}
	}
	return out;
}

/** 解析 `git status --porcelain`：`XY path`；`?? path`=未跟踪；`R  old -> new` 取新路径；
 *  引号包裹（含中文/空格转义）的路径去引号；`##` 分支行跳过。 */
export function parsePorcelain(text) {
	const out = [];
	for (const line of String(text ?? "").split("\n")) {
		if (!line.trim() || line.startsWith("##")) continue;
		const xy = line.slice(0, 2);
		let p = line.slice(3);
		if (/^".*"$/.test(p)) {
			try { p = JSON.parse(p); } catch { p = p.slice(1, -1); }
		}
		const arrow = p.split(" -> ");
		out.push({ xy, file: arrow.length === 2 ? arrow[1] : p });
	}
	return out;
}

/** 合并三路来源 → [{file, status, added, deleted, binary}]，按文件名排序去重：
 *  name-status（M/A/D，含未跟踪以外的全部）优先，numstat 补增删行数，
 *  porcelain 只补 diff 里没有的条目（基本是 ?? 未跟踪文件，git diff <commit> 不含未跟踪）。 */
export function mergeChanges(nameStatus, numstat, porcelain) {
	const nums = new Map((numstat ?? []).map((n) => [n.file, n]));
	const out = [];
	const seen = new Set();
	for (const ns of nameStatus ?? []) {
		if (seen.has(ns.file)) continue;
		seen.add(ns.file);
		const n = nums.get(ns.file);
		out.push({ file: ns.file, status: ns.status, added: n?.added ?? 0, deleted: n?.deleted ?? 0, binary: n?.binary ?? false });
	}
	for (const pr of porcelain ?? []) {
		if (seen.has(pr.file)) continue;
		seen.add(pr.file);
		const st = pr.xy.trim().startsWith("?") ? "?" : (pr.xy.trim().charAt(0) || "M").toUpperCase();
		out.push({ file: pr.file, status: st, added: 0, deleted: 0, binary: false });
	}
	return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** 从 `git log --format="%H %ct" --grep=openpi:checkpoint refs/openpi/checkpoints` 输出里挑「会话起点快照」：
 *  取提交时刻 ≤ 会话首次写文件时刻（+2s 容差，git 提交时间秒级精度与 manifest 毫秒时间戳有同拍误差）的最新一条；
 *  没有可用快照（无检查点链 / 时刻全部晚于首次改动）→ null，调用方回退 HEAD。 */
export function pickBaselineCommit(logText, firstTsSec, slackSec = 2) {
	if (!Number.isFinite(firstTsSec)) return null;
	const limit = firstTsSec + slackSec;
	for (const line of String(logText ?? "").split("\n")) {
		const m = /^([0-9a-f]{7,40})\s+(\d+)\s*$/.exec(line.trim());
		if (!m) continue;
		if (Number(m[2]) <= limit) return m[1];
	}
	return null;
}
