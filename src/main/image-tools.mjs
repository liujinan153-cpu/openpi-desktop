/**
 * P61：生图工具（CogView-4 默认，可配其他 OpenAI 兼容 images API）。
 * 配置源（优先级）：
 *   1. openpi-settings.json 的 image 节：{ apiKey, baseUrl, model }（设置页可改，接第三方生图服务）
 *   2. models.json zhipu provider 的 apiKey（同平台免配置，默认走通）
 * 约束（工具层强校验，防模型乱传参数——不合法明确报错，绝不静默回落）：
 *   - size 必须形如 WxH，宽高均在 512~2880 且为 16 的倍数、总像素≤2^21（实测 API 官方口径）
 *   - API 层对特定模型可能更严，报错原样透传，模型可自行调整参数重试
 * 写类工具（落盘文件）——走「操作审批」。
 */
import { Type } from "typebox";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const OKR = (text, details = {}) => ({ content: [{ type: "text", text }], details: { ok: true, ...details } });
const BADR = (text) => ({ content: [{ type: "text", text }], details: { ok: false } });

/** 生图配置：settings.image 优先，缺省回落智谱 */
function imageConfig() {
	const d = getAgentDir();
	let settings = {};
	try {
		settings = JSON.parse(readFileSync(join(d, "openpi-settings.json"), "utf8"));
	} catch { /* 无设置文件 */ }
	let zhipuKey = "";
	try {
		zhipuKey = JSON.parse(readFileSync(join(d, "models.json"), "utf8")).providers?.zhipu?.apiKey ?? "";
	} catch { /* 无 models.json */ }
	const c = settings.image ?? {};
	return {
		apiKey: c.apiKey || zhipuKey,
		baseUrl: (c.baseUrl || "https://open.bigmodel.cn/api/paas/v4").replace(/\/+$/, ""),
		model: c.model || "cogview-4",
	};
}

/** size 强校验（实测口径=智谱官方：512~2880、16 倍数、总像素≤2097152）。返回错误信息或 null */
function sizeError(size) {
	const m = /^(\d{3,4})x(\d{3,4})$/.exec(size ?? "");
	if (!m) return `size 格式必须为「宽x高」（如 1344x768），收到：${JSON.stringify(size)}`;
	const w = Number(m[1]), h = Number(m[2]);
	const bad = [];
	if (w < 512 || w > 2880) bad.push(`宽 ${w} 不在 512~2880`);
	if (h < 512 || h > 2880) bad.push(`高 ${h} 不在 512~2880`);
	if (w % 16 || h % 16) bad.push(`宽高必须是 16 的倍数（${w}x${h} 不满足）`);
	if (w * h > 2097152) bad.push(`总像素 ${w * h} 超过上限 2097152（≈2048x1024 / 1448x1448）`);
	if (bad.length) return `size 非法：${bad.join("；")}`;
	return null;
}

export const imageTools = [
	{
		name: "generate_image",
		label: "AI 生图",
		description:
			"用文生图模型从文字生成图片，保存到本地并返回路径。" +
			"size 规则：「宽x高」，宽高均 512~2880 且为 16 的倍数、总像素≤2097152（例：1024x1024 方图 / 1344x768 横图 / 768x1344 竖图 / 2048x1024 高清；cogview-4 不支持 4K，要更高分辨率请在设置页换其他生图模型）；省略 size 默认 1024x1024。" +
			"model 可选：默认用设置页配置的模型（cogview-4）；若配置了其他生图模型（如 image-2 等）可传其名称。" +
			"prompt 描述越具体越好（主体+风格+构图+光线）。生成后可用 read 工具查看确认效果；API 对参数的报错会原样返回，按提示调整后重试。",
		parameters: Type.Object({
			prompt: Type.String({ description: "画面描述（越具体越好）" }),
			size: Type.Optional(Type.String({ description: "尺寸「宽x高」，宽高 512~2880 且 16 的倍数、总像素≤2097152；默认 1024x1024" })),
			model: Type.Optional(Type.String({ description: "生图模型；默认用设置页配置（cogview-4）" })),
			out: Type.Optional(Type.String({ description: "保存绝对路径（默认存临时目录）" })),
		}),
		async execute(_id, params = {}) {
			const cfg = imageConfig();
			if (!cfg.apiKey) return BADR("未配置生图 API key：设置页「生图 API」填写，或确保 models.json 里有 zhipu provider 的 key");
			if (params.size !== undefined && params.size !== null) {
				const err = sizeError(params.size);
				if (err) return BADR(`${err}。正确示例：1024x1024 / 1344x768 / 2048x1024`);
			}
			const size = params.size || "1024x1024";
			const out = /^[a-zA-Z]:[\\/]|^\//.test(params.out ?? "") ? params.out : join(tmpdir(), `openpi-image-${Date.now()}.png`);
			let resp, data;
			try {
				resp = await fetch(`${cfg.baseUrl}/images/generations`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
					body: JSON.stringify({ model: params.model || cfg.model, prompt: params.prompt, size }),
					signal: AbortSignal.timeout(120_000),
				});
				data = await resp.json();
			} catch (e) {
				return BADR(`生图请求失败：${e.message}（网络可能间歇不通，可稍后重试）`);
			}
			if (!resp.ok) {
				return BADR(`生图 API 报错 ${resp.status}：${JSON.stringify(data).slice(0, 300)}（常见原因：size 超出该模型支持范围——调小或改为 16 的倍数后重试）`);
			}
			const url = data?.data?.[0]?.url;
			if (!url) return BADR(`API 未返回图片 URL：${JSON.stringify(data).slice(0, 300)}`);
			const imgResp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
			if (!imgResp.ok) return BADR(`下载图片失败：HTTP ${imgResp.status}`);
			const buf = Buffer.from(await imgResp.arrayBuffer());
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, buf);
			return OKR(`图片已生成：${out}（${params.model || cfg.model} · ${size} · ${Math.round(buf.length / 1024)}KB）。可用 read 工具查看。`, { path: out, size, model: params.model || cfg.model });
		},
	},
];
