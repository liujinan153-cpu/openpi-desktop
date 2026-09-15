// 办公技能实测（打包版 0.31.0 + 真实模型 + Python 3.12）
// 前置：Python312 + 全部依赖已装，应用以含 python3 的 PATH 启动
// 场景：docx / xlsx / pptx / pdf 各生成一个文件，产物用对应库读回验证（不只看文件存在）
import CDP from "chrome-remote-interface";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PORT = 9335;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PY = path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe");
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
let fails = 0;
const ok = (name, cond, extra = "") => {
	console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
	if (!cond) fails++;
};
const waitSettled = async (timeout = 360000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const s = await ev(`({ streaming: state.streaming, has: !!state.session })`);
		if (s.has && !s.streaming) return true;
		await sleep(3000);
	}
	return false;
};
const pyVal = (code) => execFileSync(PY, ["-X", "utf8", "-c", code], { encoding: "utf8", timeout: 30000 }).replace(/\r/g, "").trim();

/* 工作区 */
const ws = path.join(os.homedir(), "office-test");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
await ev(`startSession(${JSON.stringify(ws.replace(/\\/g, "/"))}).then(() => null)`);
await sleep(2000);
ok("会话已启动（工作区 office-test）", await ev(`!!state.session`));

const runTask = async (label, prompt, checks) => {
	console.log(`\n== ${label} ==`);
	await ev(`sendText(${JSON.stringify(prompt)}, [])`);
	await waitSettled();
	for (const [name, fn] of checks) {
		try {
			fn();
			ok(name, true);
		} catch (e) {
			ok(name, false, String(e.message ?? e).slice(0, 150));
		}
	}
};

/* ---- ① docx ---- */
await runTask(
	"① docx 技能",
	"请用 docx 技能创建 Word 文档 intro.docx：标题为《OpenPi Desktop 项目简介》，包含两段正文（分别介绍这是什么软件、有什么特性）。生成后确认文件在工作区。",
	[
		["intro.docx 已生成", () => { if (!fs.existsSync(path.join(ws, "intro.docx"))) throw new Error("文件不存在"); }],
		["python-docx 读回：含标题与正文段落", () => {
			const out = pyVal("from docx import Document; d=Document(r'" + path.join(ws, "intro.docx").replace(/\\/g, "/") + "'); ps=[p.text for p in d.paragraphs if p.text.strip()]; import sys; print(len(ps))");
			const n = Number(out);
			if (!(n >= 3)) throw new Error(`段落仅 ${n} 个`);
			console.log(`   段落数=${n}`);
		}],
	],
);
await shot("office-1-docx.png");

/* ---- ② xlsx ---- */
await runTask(
	"② xlsx 技能",
	"请用 xlsx 技能创建 Excel 表格 sales.xlsx：工作表含表头（产品、季度、销售额）和 5 行示例数据（数字为合法数值），并对表头加粗。生成后确认文件在工作区。",
	[
		["sales.xlsx 已生成", () => { if (!fs.existsSync(path.join(ws, "sales.xlsx"))) throw new Error("文件不存在"); }],
		["openpyxl 读回：表头行+数值数据", () => {
			// 宽容断言（AI 可能在表头上方加标题行）：任意行存在「产品/季度/销售额」表头 + 数值单元格 ≥5
			const code = `
import openpyxl
wb = openpyxl.load_workbook(r'${path.join(ws, "sales.xlsx").replace(/\\/g, "/")}')
ws = wb.active
rows = list(ws.iter_rows(values_only=True))
KEYS = ("\u4ea7\u54c1", "\u5b63\u5ea6", "\u9500\u552e\u989d")
print("HDR" if any(all(any(c == k for c in row if c is not None) for k in KEYS) for row in rows) else "NOHDR")
print(sum(1 for row in rows for c in row if isinstance(c, (int, float))))
`;
			const [st, n] = pyVal(code).split("\n");
			if (st !== "HDR") throw new Error("未找到表头行");
			if (Number(n) < 5) throw new Error(`数值单元格仅 ${n}`);
			console.log(`   表头行✓ 数值单元格=${n}`);
		}],
	],
);
await shot("office-2-xlsx.png");

/* ---- ③ pptx ---- */
await runTask(
	"③ pptx 技能",
	"请用 pptx 技能创建 PPT 演示文稿 demo.pptx：共 3 页（封面页标题《OpenPi Desktop》、内容页两页各带标题和要点）。生成后确认文件在工作区。",
	[
		["demo.pptx 已生成", () => { if (!fs.existsSync(path.join(ws, "demo.pptx"))) throw new Error("文件不存在"); }],
		["python-pptx 读回：3 页幻灯片", () => {
			const out = pyVal("from pptx import Presentation; p=Presentation(r'" + path.join(ws, "demo.pptx").replace(/\\/g, "/") + "'); print(len(p.slides))");
			const n = Number(out);
			if (n !== 3) throw new Error(`页数=${n}`);
			console.log(`   页数=${n}`);
		}],
	],
);
await shot("office-3-pptx.png");

/* ---- ④ pdf ---- */
await runTask(
	"④ pdf 技能",
	"请用 pdf 技能创建 PDF 文档 hello.pdf：单页，标题为 Hello OpenPi，含一小段说明文字。生成后确认文件在工作区。",
	[
		["hello.pdf 已生成", () => { if (!fs.existsSync(path.join(ws, "hello.pdf"))) throw new Error("文件不存在"); }],
		["pypdf 读回：1 页且含文本", () => {
			const out = pyVal("from pypdf import PdfReader; r=PdfReader(r'" + path.join(ws, "hello.pdf").replace(/\\/g, "/") + "'); t=(r.pages[0].extract_text() or ''); print(len(r.pages)); print(int('openpi' in t.lower()))");
			const [n, hasT] = out.split("\n");
			if (Number(n) !== 1) throw new Error(`页数=${n}`);
			if (Number(hasT) !== 1) throw new Error("未提取到文本");
			console.log(`   页数=${n} 含文本=${hasT === "1"}`);
		}],
	],
);
await shot("office-4-pdf.png");

console.log(fails ? `\n${fails} 项失败` : "\n办公技能实测全部通过 ✓");
process.exit(fails ? 1 : 0);
