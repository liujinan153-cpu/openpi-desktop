// P37.1：办公技能品牌洗白（一次性工具）——去除 ZCode/Z.ai 痕迹，改为 OpenPi 自有标识
// 跑法：node scripts/rebrand-skills.mjs  （同时处理 resources/skills 与 ~/.pi/agent/skills 两份）
// 注意：LICENSE.txt 依上游许可要求原样保留，本脚本不动它。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOTS = [
	path.resolve(import.meta.dirname, "..", "resources", "skills"),
	path.join(os.homedir(), ".pi", "agent", "skills"),
];

// OpenPi 自有产物报告规范（替代 ZCode 的 ::zcode-file-citation 引用体系；OpenPi Desktop 渲染层会把绝对路径渲染成文件卡）
const CITATION_SECTION = `## Final response — artifact reporting (OpenPi)

Report every final artifact in your reply by its full absolute path, written inline in prose (for example: Created C:\\\\workspace\\\\output\\\\launch-plan.docx, highlighting the rollout and owners). The OpenPi Desktop interface automatically renders absolute file paths as clickable file cards.

- [HARD REQUIREMENT] Create/edit: report each final file exactly once with its absolute path. Summarize representative changes; do not list every section/page or add a separate filename list.
- Q&A/no-op: do not edit or re-export files.
- Never report intermediates (rendered PNGs, scratch files, builders, QA artifacts) unless asked.`;

let total = 0, changed = 0;
const log = (file, msg) => console.log(`  ${file}: ${msg}`);

for (const root of ROOTS) {
	if (!fs.existsSync(root)) { console.log(`跳过（不存在）: ${root}`); continue; }
	console.log(`\n=== 处理 ${root} ===`);
	for (const skill of ["docx", "xlsx", "pptx", "pdf"]) {
		const dir = path.join(root, skill);
		if (!fs.existsSync(dir)) continue;
		// 递归收集文本文件（排除 LICENSE）
		const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
			if (e.name === "LICENSE.txt" || e.name.startsWith(".")) return [];
			const p = path.join(d, e.name);
			return e.isDirectory() ? walk(p) : /\.(md|py|sh|js|mjs|cjs|tex|json|txt)$/i.test(e.name) ? [p] : [];
		});
		for (const file of walk(dir)) {
			total++;
			const rel = path.relative(root, file);
			let text = fs.readFileSync(file, "utf8");
			const before = text;
			const edits = [];

			// 1) SKILL.md 引用章节整体替换（章节固定在文件尾）
			if (file.endsWith("SKILL.md") && /^## Final response citations/m.test(text)) {
				text = text.replace(/^## Final response citations[\s\S]*$/m, CITATION_SECTION + "\n");
				edits.push("引用章节→OpenPi产物报告规范");
			}
			// 2) 元数据/署名
			text = text.replace(/^(\s*author:\s*)Z\.AI\s*$/m, "$1OpenPi");
			text = text.replace(/^#\s*author:\s*Z\.AI\s*$/m, "# author: OpenPi");
			// 3) 代码/文档中的 Z.ai → OpenPi（PDF 元数据、模板 pdfauthor、VBA 注释等）
			text = text.replaceAll("Z.ai", "OpenPi");
			// 4) document.py 默认作者 Z.AI → OpenPi
			text = text.replaceAll('"Z.AI"', '"OpenPi"').replaceAll("'Z.AI'", "'OpenPi'");
			// 5) 残留 zcode 路径举例 → 通用写法
			text = text.replace(/\.zcode\/cli\/plugins\/cache\/zcode-plugins-official/g, ".openpi/skills");
			text = text.replace(/~\/\.zcode/g, "~/.openpi");

			if (text !== before) {
				fs.writeFileSync(file, text, "utf8");
				changed++;
				log(rel, edits.length ? edits.join(" + ") : "署名/元数据替换");
			}
		}
	}
}
console.log(`\n完成：扫描 ${total} 个文件，改写 ${changed} 个`);
