---
name: archive
metadata:
  author: OpenPi
  version: "1.0"
description: "Compressed archive handling: read, list, extract, and create zip / 7z / tar / tar.gz / tgz / tar.bz2 / tar.xz archives. Handles Chinese filename mojibake in legacy GBK zips, password-protected archives, and safe extraction (zip-slip protection). Use whenever the user gives you an archive to process or asks to compress, pack, bundle, unzip, or extract files."
---

# 压缩包处理（archive）

处理压缩包：查看内容、解压、创建。用户丢给你 .zip/.7z/.tar.gz 让你处理，或要求把文件打包，都用本技能。

## 何时使用

- 用户发送/引用压缩包文件（zip/7z/tar/tar.gz/tgz/tar.bz2/tar.xz），要「看看里面有什么」「解压」「提取某个文件」
- 用户要求「打包/压缩/归档」文件或目录（「把这些图片打包成 zip」「压缩整个项目」）
- 压缩包里的文件需要二次处理（解压后用 docx/xlsx 等技能继续加工）

## 格式能力矩阵

| 格式 | 读/解压 | 创建 | 说明 |
|---|---|---|---|
| .zip | ✅ | ✅ | 标准库；含 GBK 中文文件名乱码自动修复；支持密码 |
| .7z | ✅ | ✅ | 内置 Python 运行时的 py7zr；支持密码 |
| .tar / .tar.gz / .tgz / .tar.bz2 / .tar.xz | ✅ | ✅ | 标准库 |
| .rar | ⚠️ 尽力而为 | ❌ | 先试系统 `tar -xf 某文件.rar`（部分 Windows 版本可读 rar）；失败就明确告知用户「暂不支持 rar 解压，请转存 zip/7z」，不要假装成功 |

## 用法（宿主 python3 = 内置 Python 运行时，直接可用）

工具在本技能 `scripts/archive_tool.py`（用相对本 SKILL.md 的路径引用）：

```bash
# 查看内容（不解压）
python3 <本技能目录>/scripts/archive_tool.py list "C:\path\to\file.zip"

# 解压（默认到 <工作区>/output/<压缩包名>/，也可指定目标目录）
python3 <本技能目录>/scripts/archive_tool.py extract "C:\path\to\file.zip"
python3 <本技能目录>/scripts/archive_tool.py extract "C:\path\to\file.zip" "C:\workspace\output\unpacked"

# 创建（zip/7z/tar 系；来源可以是文件或目录，目录递归）
python3 <本技能目录>/scripts/archive_tool.py create "C:\workspace\output\打包.zip" "C:\workspace\report.docx" "C:\workspace\photos"

# 密码包
python3 <本技能目录>/scripts/archive_tool.py list secret.zip --password "密码"
```

## 关键规则

1. **中文乱码**：老式中文 zip（Windows 资源管理器直接压缩）文件名是 GBK 编码，工具已自动修复。若 list 输出的文件名仍然异常，向用户如实说明并展示修复前后的对照，不要静默猜测。
2. **安全**：工具内置 zip-slip 防护（条目路径含 `..` 或绝对路径会被拦截并报错）。看到「不安全的条目路径」报错时，向用户说明该压缩包包含可疑路径，不要尝试绕过。
3. **解压目标**：默认解到工作区 `output/<压缩包名>/`，用户指定了目录则用用户的。绝不解压到桌面、下载目录等工作区之外。
4. **创建目标**：压缩产物放工作区（推荐 `output/`），回复中报告完整绝对路径（界面会渲染成文件卡）。
5. **解压覆盖**：目标目录已存在同名文件时不要静默覆盖；先 list 确认内容，与用户确认或换新目录。
6. **大文件**：超大压缩包（>500MB）先 list 看内容规模，向用户确认后再全量解压。
7. **密码包**：用户没给密码时先问密码，不要穷举尝试。

## 典型任务菜谱

- 「这个压缩包里有什么」→ list → 用一句话概括内容结构，列出关键文件
- 「解压并处理里面的 Word 文件」→ extract → 对解出的 .docx 用 docx 技能继续加工
- 「把这些文件打包发给同事」→ create zip → 报告 zip 的绝对路径
- 「压缩包里有个 Excel，帮我把数据整理成报表」→ extract → xlsx 技能处理 → 新产物放 output/
