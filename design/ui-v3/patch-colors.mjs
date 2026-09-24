// 一次性补丁：配色对标 Pi-Desktop（深色暖黑 / 浅色纯白内容区）+ dock 标签一次展示全
import fs from "node:fs";
const p = "src/renderer/style.css";
let s = fs.readFileSync(p, "utf8");
let miss = 0;
const n = (b, a) => {
	if (!s.includes(b)) { console.error("MISS: " + b.slice(0, 66)); miss++; return; }
	s = s.split(b).join(a); console.log("OK");
};

/* ---- 深色：中性转暖黑（去蓝相，Pi-Desktop 同族） ---- */
n("\t--bg0: #0a0a0c;\n\t--bg: #0c0c0e;\n\t--bg2: #101013;\n\t--bg3: #17171c;\n\t--bg4: #1f1f26;",
	"\t--bg0: #0a0a09;\n\t--bg: #0c0c0b;\n\t--bg2: #111110;\n\t--bg3: #181816;\n\t--bg4: #201f1d;");

/* ---- 浅色：内容区纯白 + 侧栏暖白（Pi-Desktop 图2 同族），去掉过重的米黄 ---- */
n("\t--bg0: #e9e4da;\n\t--bg: #fbfaf6;\n\t--bg1: #ffffff;\n\t--bg2: #f4efe6;\n\t--bg3: #f2eee5;\n\t--bg4: #e8e2d6;",
	"\t--bg0: #f0eee9;\n\t--bg: #ffffff;\n\t--bg1: #ffffff;\n\t--bg2: #faf9f6;\n\t--bg3: #f4f3ef;\n\t--bg4: #eae8e2;");
n("\t--surface: #f4efe6;\n\t--surface-2: #efeadd;",
	"\t--surface: #faf9f6;\n\t--surface-2: #f4f3ef;");
n("\t--border: rgba(88, 68, 40, .1);\n\t--border2: rgba(88, 68, 40, .18);",
	"\t--border: rgba(60, 55, 45, .1);\n\t--border2: rgba(60, 55, 45, .18);");
n("\t--hover: rgba(88, 68, 40, .055);\n\t--active: rgba(88, 68, 40, .09);",
	"\t--hover: rgba(60, 55, 45, .05);\n\t--active: rgba(60, 55, 45, .08);");
n("\t--shadow-lg: 0 10px 34px rgba(70, 50, 25, .12);\n\t--shadow-pop: 0 18px 60px rgba(70, 50, 25, .18);",
	"\t--shadow-lg: 0 10px 34px rgba(50, 46, 40, .12);\n\t--shadow-pop: 0 18px 60px rgba(50, 46, 40, .18);");
n("\t--shadow-lift: 0 8px 24px rgba(70, 50, 25, .14);",
	"\t--shadow-lift: 0 8px 24px rgba(50, 46, 40, .14);");
n("\t--code-bg: #14120e;", "\t--code-bg: #17150f;");

/* ---- dock：标签一次展示全（缩内距/字号）+ 展开默认加宽 ---- */
n("\twidth: var(--dock-w, 480px); min-width: var(--dock-w, 480px); display: flex; flex-direction: column;",
	"\twidth: var(--dock-w, 520px); min-width: var(--dock-w, 520px); display: flex; flex-direction: column;");
n(".dock-tab {\n\tborder: none; background: transparent; color: var(--dim);\n\tfont: 600 12px var(--sans); padding: 5px 9px; border-radius: var(--r-sm);",
	".dock-tab {\n\tborder: none; background: transparent; color: var(--dim);\n\tfont: 600 11.5px var(--sans); padding: 5px 6px; border-radius: var(--r-xs);");
n(".dock-cnt {\n\tbackground: var(--bg4); color: var(--dim); font-size: 10px; font-weight: 600;\n\tborder-radius: 999px; padding: 0 5px; line-height: 14px; min-width: 14px; text-align: center;\n}",
	".dock-cnt {\n\tbackground: var(--bg4); color: var(--dim); font-size: 9.5px; font-weight: 600;\n\tborder-radius: 999px; padding: 0 4px; line-height: 13px; min-width: 13px; text-align: center;\n}");
n("#dock-tabs {\n\tdisplay: flex; align-items: center; gap: 1px; padding: 6px 6px;",
	"#dock-tabs {\n\tdisplay: flex; align-items: center; gap: 0; padding: 5px 5px;");

/* ---- hero：标题升 28px、幽灵徽标放大（Pi-Desktop 的分量感） ---- */
n("#welcome h1 { font-size: 26px; font-weight: 700; letter-spacing: -.5px; margin-bottom: 10px; }",
	"#welcome h1 { font-size: 28px; font-weight: 700; letter-spacing: -.5px; margin-bottom: 10px; }");
n("\tfont-size: 30px; color: var(--faint); /* UI v3.1：幽灵徽标，无底色无辉光 */",
	"\tfont-size: 38px; color: var(--faint); /* UI v3.1：幽灵徽标，无底色无辉光 */");
n("#welcome .w-logo svg.lucide { width: 34px; height: 34px; }",
	"#welcome .w-logo svg.lucide { width: 40px; height: 40px; }");

fs.writeFileSync(p, s);
console.log(miss ? `完成（${miss} 处未匹配）` : "全部匹配");
