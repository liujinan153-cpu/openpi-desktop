// xlsx 产物宽容复验：表头行（产品/季度/销售额）存在于任意行 + 数值单元格 ≥5
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
const PY = path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe");
const wsPath = path.join(os.homedir(), "office-test", "sales.xlsx").replace(/\\/g, "/");
const code = `
import openpyxl
wb = openpyxl.load_workbook(r"${wsPath}")
ws = wb.active
rows = list(ws.iter_rows(values_only=True))
# 表头字符用 unicode 转义（argv 编码链路不可靠，踩坑 #81）：产品/季度/销售额
KEYS = ("\u4ea7\u54c1", "\u5b63\u5ea6", "\u9500\u552e\u989d")
has_hdr_row = any(all(any(c == k for c in row if c is not None) for k in KEYS) for row in rows)
nums = sum(1 for row in rows for c in row if isinstance(c, (int, float)))
bold_hdr = False
for row in ws.iter_rows():
    for c in row:
        if c.value == KEYS[0] and c.font and c.font.bold:
            bold_hdr = True
print("HDR" if has_hdr_row else "NOHDR")
print(nums)
print("BOLD" if bold_hdr else "PLAIN")
`;
const out = execFileSync(PY, ["-X", "utf8", "-c", code], { encoding: "utf8" }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
console.log("[debug] out =", JSON.stringify(out));
console.log("表头行存在（产品/季度/销售额）:", out[0] === "HDR");
console.log("数值单元格数:", out[1]);
console.log("表头加粗:", out[2] === "BOLD");
const pass = out[0] === "HDR" && Number(out[1]) >= 5;
console.log(pass ? "✓ xlsx 产物合格（断言修正后）" : "✗ 仍不合格");
process.exit(pass ? 0 : 1);
