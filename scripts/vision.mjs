// 用已配置的视觉模型（kimi-k2.7-code）看图：node scripts/vision.mjs <图片路径> [提问]
import fs from "node:fs";
import path from "node:path";

const [,, imgPath, question = "详细描述这张截图的内容，特别是界面上的文字、按钮和用户正在做什么"] = process.argv;
if (!imgPath || !fs.existsSync(imgPath)) {
	console.error("用法: node scripts/vision.mjs <图片路径> [提问]");
	process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, ".pi", "agent", "models.json"), "utf8"));
const p = Object.values(cfg.providers).find((pr) => (pr.models ?? []).some((m) => (m.input ?? []).includes("image")));
if (!p) {
	console.error("未配置视觉模型（models.json 里没有 input 含 image 的模型）");
	process.exit(1);
}
const vm = p.models.find((m) => (m.input ?? []).includes("image"));
const b64 = fs.readFileSync(imgPath).toString("base64");
const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[path.extname(imgPath).toLowerCase()] ?? "image/png";
const r = await fetch((p.baseUrl ?? "").replace(/\/$/, "") + "/chat/completions", {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
	body: JSON.stringify({
		model: vm.id,
		max_tokens: 2048,
		messages: [
			{ role: "user", content: [
				{ type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
				{ type: "text", text: question },
			] },
		],
	}),
});
const j = await r.json();
if (!r.ok) {
	console.error("API 错误:", JSON.stringify(j).slice(0, 400));
	process.exit(1);
}
console.log(j.choices?.[0]?.message?.content ?? "(空)");
