// 品牌图标生成器：圆角菱形（蓝紫渐变+内嵌白菱）→ 多尺寸 ICO + 256 PNG
// 纯 Node 实现（zlib 内置），无第三方依赖。产物：build/icon.ico、build/icon.png
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "build");
fs.mkdirSync(OUT, { recursive: true });

/* ---- PNG 编码 ---- */
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();
const crc32 = (buf) => {
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
};
function encodePNG(rgba, w, h) {
	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
	const raw = Buffer.alloc(h * (w * 4 + 1));
	for (let y = 0; y < h; y++) {
		raw[y * (w * 4 + 1)] = 0; // filter none
		rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
	}
	return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/* ---- 渲染：圆角菱形（超采样抗锯齿） ---- */
const SIZE = 256, SS = 4, N = SIZE * SS;
const px = Buffer.alloc(SIZE * SIZE * 4);
const pow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
for (let y = 0; y < SIZE; y++) {
	for (let x = 0; x < SIZE; x++) {
		let cov = 0, r = 0, g = 0, b = 0;
		for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
			const X = (x * SS + sx + 0.5) / SS, Y = (y * SS + sy + 0.5) / SS;
			const a = (X + Y - 256) / 1.4142, b2 = (X - Y) / 1.4142; // 旋转 45°
			const u = Math.abs(a), v = Math.abs(b2);
			const f = pow(u / 81, 3) + pow(v / 81, 3);   // 外菱形（圆角菱形）
			if (f > 1) continue;
			cov++;
			const t = Math.min(1, Math.max(0, u / 81)); // 沿菱形长轴渐变
			let cr = Math.round(0x6e + (0x9b - 0x6e) * t);
			let cg = Math.round(0xa5 + (0x8c - 0xa5) * t);
			let cb = Math.round(0xff + (0xff - 0xff) * t);
			const f2 = pow(u / 36, 3) + pow(v / 36, 3);  // 内嵌白菱
			if (f2 <= 1) { cr = 0xf6; cg = 0xf8; cb = 0xff; }
			r += cr; g += cg; b += cb;
		}
		const i = (y * SIZE + x) * 4, n = SS * SS;
		px[i] = n ? Math.round(r / n) : 0;
		px[i + 1] = n ? Math.round(g / n) : 0;
		px[i + 2] = n ? Math.round(b / n) : 0;
		px[i + 3] = Math.round((cov / n) * 255);
	}
}

/* ---- 缩放（盒式滤波） ---- */
function scaleTo(size) {
	const out = Buffer.alloc(size * size * 4);
	const k = SIZE / size;
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		let r = 0, g = 0, b = 0, a = 0, cnt = 0;
		for (let yy = Math.floor(y * k); yy < Math.max(Math.floor(y * k) + 1, Math.floor((y + 1) * k)); yy++)
			for (let xx = Math.floor(x * k); xx < Math.max(Math.floor(x * k) + 1, Math.floor((x + 1) * k)); xx++) {
				const i = (Math.min(yy, SIZE - 1) * SIZE + Math.min(xx, SIZE - 1)) * 4;
				r += px[i]; g += px[i + 1]; b += px[i + 2]; a += px[i + 3]; cnt++;
			}
		const o = (y * size + x) * 4;
		out[o] = Math.round(r / cnt); out[o + 1] = Math.round(g / cnt); out[o + 2] = Math.round(b / cnt); out[o + 3] = Math.round(a / cnt);
	}
	return out;
}

/* ---- ICO 组装：小尺寸 BMP DIB + 256 用 PNG ---- */
function bmpEntry(size) {
	const rgba = scaleTo(size);
	const xor = Buffer.alloc(size * size * 4);
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		const src = ((size - 1 - y) * size + x) * 4, dst = (y * size + x) * 4; // 自下而上 + BGRA
		xor[dst] = rgba[src + 2]; xor[dst + 1] = rgba[src + 1]; xor[dst + 2] = rgba[src]; xor[dst + 3] = rgba[src + 3];
	}
	const and = Buffer.alloc(size * Math.ceil(size / 32) * 4); // 全 0 AND 掩码
	const info = Buffer.alloc(40);
	info.writeUInt16LE(40, 0); info.writeInt32LE(size, 4); info.writeInt32LE(size * 2, 8);
	info.writeUInt16LE(1, 12); info.writeUInt16LE(32, 14);
	return { size, data: Buffer.concat([info, xor, and]) };
}

const sizes = [16, 24, 32, 48, 64];
const entries = sizes.map(bmpEntry);
const png256 = encodePNG(px, SIZE, SIZE);
entries.push({ size: 256, data: png256, png: true });

const count = entries.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
let offset = 6 + count * 16;
const dir = Buffer.alloc(count * 16);
entries.forEach((e, i) => {
	dir[i * 16] = e.size >= 256 ? 0 : e.size;
	dir[i * 16 + 1] = e.size >= 256 ? 0 : e.size;
	dir[i * 16 + 2] = 0; dir[i * 16 + 3] = 0;
	dir.writeUInt16LE(1, i * 16 + 4); dir.writeUInt16LE(e.png ? 32 : 32, i * 16 + 6);
	dir.writeUInt32LE(e.data.length, i * 16 + 8); dir.writeUInt32LE(offset, i * 16 + 12);
	offset += e.data.length;
});
const ico = Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
fs.writeFileSync(path.join(OUT, "icon.ico"), ico);
fs.writeFileSync(path.join(OUT, "icon.png"), encodePNG(px, SIZE, SIZE));
console.log("已生成 build/icon.ico（" + ico.length + "B，尺寸 " + sizes.join("/") + "/256）+ build/icon.png（256）");
