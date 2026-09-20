/* P73 第二批：技能页「全局级/项目级」重排的纯逻辑层（对标 Cherry Studio 技能页）。
   经典脚本加载（index.html 在 app.js 之前 <script src>），挂到 globalThis.P73SKILLS；
   Node 单测（scripts/unit-p73.mjs）通过 import 副作用读取 globalThis.P73SKILLS。
   不用 import/export 语法：同一份代码在浏览器经典脚本与 Node ESM 下都可执行。 */
(() => {
	/** 技能搜索过滤：命中名称或描述（中文优先，无中文回退英文原文）；q 空串/null 全过。
	    语义与旧 renderSkillList 内联过滤一致（name || descriptionZh||description，大小写不敏感），
	    P73 起全局/项目两组共用。 */
	function skillMatchQuery(s, q) {
		const query = String(q ?? "").trim().toLowerCase();
		if (!query) return true;
		const hay = `${s?.name ?? ""} ${s?.descriptionZh || s?.description || ""}`.toLowerCase();
		return hay.includes(query);
	}

	/** chips 计数：全部 = 全局 + 项目（全局含已安装/已停用/外部来源三组） */
	function skillChipCounts(globalCount, projectCount) {
		const g = Math.max(0, Number(globalCount) || 0);
		const p = Math.max(0, Number(projectCount) || 0);
		return { all: g + p, global: g, project: p };
	}

	/** chip 单选 → 两组小节可见性：全部=都显示；全局/项目=只显示对应小节 */
	function skillSectionVisibility(filter) {
		return { global: filter !== "project", project: filter !== "global" };
	}

	globalThis.P73SKILLS = { skillMatchQuery, skillChipCounts, skillSectionVisibility };
})();
