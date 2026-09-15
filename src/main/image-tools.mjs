/**
 * P61：CogView-4 生图——智谱自家图像生成 API，零新增依赖（node 原生 fetch）。
 * API key 复用 models.json 里 zhipu provider 的凭据；生成结果下载到本地，
 * 返回绝对路径（主模型有视觉能力，可直接 read 查看并汇报给用户）。
 * 写类工具（落盘文件）——走「操作审批」。
 */
import { Type } from "typebox";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const OKR = (text, details = {}) => ({ content: [{ type: "text", text }], details: { ok: true, ...details } });
const BADR = (text) => ({ content: [{ type: "text", text }], details: { ok: false } });

/** 从 models.json 取 zhipu provider 的 apiKey */
function zhipuKey() {
	try {
		const p = join(getAgentDir(), "models.json");
		const cfg = JSON.parse(readFileSync(p, "utf8"));
		return cfg.providers?.zhipu?.apiKey ?? "";
	} catch {
		return "";
	}
}

const SIZES = ["1024x1024", "768x1344", "864x1152", "1344x768", "1152x864", "1440x720", "720x1440"];

export const imageTools = [
	{
		name: "generate_image",
		label: "AI 生图",
		description:
			`用 CogView-4 模型从文字生成图片，保存到本地并返回路径。可选尺寸：${SIZES.join(" / ")}（默认 1024x1024）。prompt 用中文或英文均可，描述越具体效果越好（主体+风格+构图+光线）。生成后可用 read 工具查看图片确认效果。`,
		parameters: Type.Object({
			prompt: Type.String({ description: "画面描述（越具体越好）" }),
			size: Type.Optional(Type.String({ description: `尺寸，默认 1024x1024，可选：${SIZES.join("/")}` })),
			out: Type.Optional(Type.String({ description: "保存绝对路径（默认存临时目录）" })),
		}),
		async execute(_id, params = {}) {
			const key = zhipuKey();
			if (!key) return BADR("未找到智谱 API key（models.json 的 zhipu provider），无法生图");
			const size = SIZES.includes(params.size) ? params.size : "1024x1024";
			const out = params.out && /^[a-zA-Z]:[\\/]|^\//.test(params.out) ? params.out : join(tmpdir(), `openpi-image-${Date.now()}.png`);
			let resp, data;
			try {
				resp = await fetch("https://open.bigmodel.cn/api/paas/v4/images/generations", {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
					body: JSON.stringify({ model: "cogview-4", prompt: params.prompt, size }),
					signal: AbortSignal.timeout(120_000),
				});
				data = await resp.json();
			} catch (e) {
				return BADR(`生图请求失败：${e.message}（到 open.bigmodel.cn 网络可能间歇不通，可稍后重试）`);
			}
			if (!resp.ok) {
				return BADR(`生图 API 报错 ${resp.status}：${JSON.stringify(data).slice(0, 300)}`);
			}
			const url = data?.data?.[0]?.url;
			if (!url) return BADR(`API 未返回图片 URL：${JSON.stringify(data).slice(0, 300)}`);
			const imgResp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
			if (!imgResp.ok) return BADR(`下载图片失败：HTTP ${imgResp.status}`);
			const buf = Buffer.from(await imgResp.arrayBuffer());
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, buf);
			return OKR(`图片已生成：${out}（${size}，${Math.round(buf.length / 1024)}KB）。可用 read 工具查看。`, { path: out });
		},
	},
];
