// 一次性补丁 11：深色配色对标 Pi-Desktop——纯黑侧栏/dock + 浅一档灰主区（明度反转成层次）
import fs from "node:fs";
const p = "src/renderer/style.css";
let s = fs.readFileSync(p, "utf8");
let miss = 0;
const n = (b, a) => {
	if (!s.includes(b)) { console.error("MISS: " + b.slice(0, 66)); miss++; return; }
	s = s.split(b).join(a); console.log("OK");
};

// 深色 tokens：主区抬亮成灰面，侧栏压到纯黑
n("\t--bg0: #0a0a09;", "\t--bg0: #0f0f0e;");
n("\t--bg: #0c0c0b;", "\t--bg: #1b1a18; /* UI v3.1：主区=灰面（比侧栏亮一档，Pi-Desktop 明度反转） */");
n("\t--bg2: #111110;", "\t--bg2: #232220; /* 卡片/composer 浮起面 */");
n("\t--bg3: #181816;", "\t--bg3: #2a2926;");
n("\t--bg4: #201f1d;", "\t--bg4: #33322f;");
n("\t--bg4: #33322f;", "\t--bg4: #33322f;\n\t--bg-side: #060607; /* 侧栏/dock=纯黑 */");

// 侧栏 / dock / 审核右栏 → 纯黑
n("\twidth: 320px; min-width: 320px; background: var(--bg2);", "\twidth: 320px; min-width: 320px; background: var(--bg-side);");
n("\tborder-left: 1px solid var(--border); background: var(--bg2); position: relative;", "\tborder-left: 1px solid var(--border); background: var(--bg-side); position: relative;");
n("\twidth: 280px; min-width: 280px; display: flex; flex-direction: column;\n\tbackground: var(--bg2); border-left: 1px solid var(--border);", "\twidth: 280px; min-width: 280px; display: flex; flex-direction: column;\n\tbackground: var(--bg-side); border-left: 1px solid var(--border);");

// 亮色主题补 --bg-side（暖白侧栏，不受影响）
n("\t--shadow-lift: 0 8px 24px rgba(50, 46, 40, .14);", "\t--shadow-lift: 0 8px 24px rgba(50, 46, 40, .14);\n\t--bg-side: #faf9f6;");

fs.writeFileSync(p, s);
console.log(miss ? `完成（${miss} 处未匹配）` : "全部匹配");
