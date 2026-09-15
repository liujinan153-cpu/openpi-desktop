# OpenPi archive 技能核心工具：压缩包读取/解压/创建
# 零依赖（zip/tar 系用 Python 标准库）；7z 依赖内置 Python 运行时的 py7zr
# 用法：
#   python3 archive_tool.py list    <archive> [--password P]
#   python3 archive_tool.py extract <archive> [dest] [--password P]
#   python3 archive_tool.py create  <archive> <path...>
# 退出码：0 成功；2 用法错误；3 不支持的格式；其他非零 = 操作失败
import argparse
import os
import sys
import tarfile
import zipfile

TAKE = ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz"
ZIP = ".zip"
SEVENZ = ".7z"


def kind_of(path):
    low = path.lower()
    if low.endswith(ZIP):
        return "zip"
    if low.endswith(SEVENZ):
        return "7z"
    if low.endswith(TAKE):
        return "tar"
    return None


def fix_zip_name(info):
    """修复中文 zip 文件名乱码：Windows 资源管理器打 zip 时文件名是 GBK 且无 UTF-8 标志位，
    zipfile 会按 cp437 解出乱码。策略：无 UTF-8 标志位时还原原始字节，按 utf-8 → gbk 严格解码。"""
    name = info.filename
    if isinstance(info, zipfile.ZipInfo) and not (info.flag_bits & 0x800):
        try:
            raw = name.encode("cp437")
        except UnicodeEncodeError:
            return name
        for enc in ("utf-8", "gbk"):
            try:
                fixed = raw.decode(enc)
            except UnicodeDecodeError:
                continue
            if fixed != name:
                return fixed
            break
    return name


def safe_join(base, entry):
    """防 zip slip：拒绝绝对路径与逃出目标目录的条目。"""
    p = os.path.normpath(os.path.join(base, entry))
    if p != base and not p.startswith(base + os.sep):
        raise ValueError(f"不安全的条目路径（已拦截）: {entry}")
    return p


def zf_list(path, password):
    out = []
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            out.append((fix_zip_name(info), info.file_size))
    return out


def zf_extract(path, dest, password):
    n = 0
    with zipfile.ZipFile(path, metadata_encoding=None) as z:
        pw = password.encode("utf-8") if password else None
        for info in z.infolist():
            name = fix_zip_name(info)
            target = safe_join(dest, name)
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info, pwd=pw) as src, open(target, "wb") as dst:
                dst.write(src.read())
            n += 1
    return n


def zf_create(path, sources):
    n = 0
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for src in sources:
            if os.path.isfile(src):
                z.write(src, os.path.basename(src))
                n += 1
            elif os.path.isdir(src):
                base = os.path.dirname(os.path.abspath(src)) or "."
                for root, _dirs, files in os.walk(src):
                    for f in files:
                        full = os.path.join(root, f)
                        arc = os.path.relpath(full, base)
                        z.write(full, arc)
                        n += 1
    return n


def sevenz_list(path, password):
    try:
        import py7zr
    except ImportError:
        print("ERR: 内置 Python 运行时缺少 py7zr，无法处理 7z", file=sys.stderr)
        sys.exit(3)
    with py7zr.SevenZipFile(path, "r", password=password) as z:
        out = []
        for fi in z.list():
            if fi.is_directory:
                continue
            out.append((fi.filename, fi.uncompressed))
        return out


def sevenz_extract(path, dest, password):
    try:
        import py7zr
    except ImportError:
        print("ERR: 内置 Python 运行时缺少 py7zr，无法处理 7z", file=sys.stderr)
        sys.exit(3)
    with py7zr.SevenZipFile(path, "r", password=password) as z:
        z.extractall(path=dest)
        return len([fi for fi in z.list() if not fi.is_directory])


def sevenz_create(path, sources):
    try:
        import py7zr
    except ImportError:
        print("ERR: 内置 Python 运行时缺少 py7zr，无法创建 7z", file=sys.stderr)
        sys.exit(3)
    count = 0
    with py7zr.SevenZipFile(path, "w") as z:
        for src in sources:
            if os.path.isdir(src):
                z.writeall(src, arcname=os.path.basename(src))
                count += sum(len(files) for _r, _d, files in os.walk(src))
            else:
                z.write(src, arcname=os.path.basename(src))
                count += 1
    return count


def tar_extract(path, dest):
    n = 0
    with tarfile.open(path, "r:*") as t:
        for m in t.getmembers():
            safe_join(dest, m.name)
        t.extractall(dest, filter="data")
        n = len(t.getmembers())
    return n


def tar_list(path):
    with tarfile.open(path, "r:*") as t:
        return [(m.name, m.size) for m in t.getmembers() if m.isfile()]


def tar_create(path, sources):
    mode = "w"
    low = path.lower()
    if low.endswith((".tar.gz", ".tgz")):
        mode = "w:gz"
    elif low.endswith((".tar.bz2", ".tbz2")):
        mode = "w:bz2"
    elif low.endswith((".tar.xz", ".txz")):
        mode = "w:xz"
    n = 0
    with tarfile.open(path, mode) as t:
        for src in sources:
            t.add(src, arcname=os.path.basename(src))
            n += 1
    return n


def fmt_size(n):
    if n is None:
        return "?"
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n / 1:.1f}{unit}"
        n /= 1024


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("action", choices=["list", "extract", "create"])
    ap.add_argument("archive")
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--password", default=None)
    args = ap.parse_args()

    kind = kind_of(args.archive)
    if args.action != "create" and kind is None:
        print(f"ERR: 不认识的压缩包格式: {args.archive}（支持 zip/7z/tar/tar.gz/tgz/tar.bz2/tar.xz）", file=sys.stderr)
        sys.exit(3)
    if args.action == "create":
        if not args.paths:
            print("ERR: create 需要至少一个来源文件/目录", file=sys.stderr)
            sys.exit(2)
        kind = kind or ("zip" if args.archive.lower().endswith(ZIP) else None)
        if kind is None:
            print(f"ERR: 不支持的压缩格式: {args.archive}（创建支持 zip/7z/tar 系）", file=sys.stderr)
            sys.exit(3)

    if args.action == "list":
        items = zf_list(args.archive, args.password) if kind == "zip" else (
            sevenz_list(args.archive, args.password) if kind == "7z" else tar_list(args.archive))
        print(f"共 {len(items)} 个文件:")
        for name, size in items:
            print(f"  {fmt_size(size):>10}  {name}")
        sys.exit(0)

    if args.action == "extract":
        dest = args.paths[0] if args.paths else None
        if not dest:
            base = os.path.splitext(os.path.basename(args.archive))[0]
            base = base.replace(".tar", "")
            dest = os.path.join("output", base)
        os.makedirs(dest, exist_ok=True)
        n = zf_extract(args.archive, dest, args.password) if kind == "zip" else (
            sevenz_extract(args.archive, dest, args.password) if kind == "7z" else tar_extract(args.archive, dest))
        abs_dest = os.path.abspath(dest)
        print(f"OK 解压 {n} 个文件 → {abs_dest}")
        sys.exit(0)

    if args.action == "create":
        n = zf_create(args.archive, args.paths) if kind == "zip" else (
            sevenz_create(args.archive, args.paths) if kind == "7z" else tar_create(args.archive, args.paths))
        print(f"OK 压缩 {n} 个条目 → {os.path.abspath(args.archive)}")
        sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except zipfile.BadZipFile as e:
        print(f"ERR: 压缩包损坏或格式不对: {e}", file=sys.stderr)
        sys.exit(1)
    except RuntimeError as e:
        msg = str(e)
        if "password" in msg.lower():
            print("ERR: 需要密码（--password）或密码错误", file=sys.stderr)
        else:
            print(f"ERR: {msg}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:  # noqa: BLE001 — CLI 边界兜底
        print(f"ERR: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
