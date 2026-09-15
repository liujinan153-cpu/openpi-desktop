#!/usr/bin/env python3
"""general_judge: render a pptx and report rule-based defects.

Every finding is a definite defect for ANY pptx — no thresholds, no taste:
  render_mismatch   visible slide count != pdf page count, or pdf pages != pngs
  garbled           rendered text contains U+FFFD replacement characters
  text_off_canvas   a text-bearing shape extends outside the slide bounds
  text_collision    two rendered words print on the same pixels (exempt:
                    watermark-scale size gap, faux-bold/shadow double draw)
  text_occluded     a text shape is ≥70% covered by a later-drawn opaque
                    solid-fill shape — the reader cannot see the text
  text_overflow     a rendered word escapes every text-capable container —
                    text spilled outside the shape meant to hold it
                    (auto-grow shapes, tables, wrap=none boxes exempt)
  broken_image      picture with a missing/external/zero-byte image part
  placeholder       template placeholder text survived into the render
                    ("lorem ipsum" / "Click to add")

Exit codes: 0 = clean, 1 = findings, 2 = cannot judge (render/deps failed).
Rotated shapes are excluded from geometry checks (bbox would be wrong).
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import xml.etree.ElementTree as ET

EMU_IN = 914400
OFF_TOL_IN = 0.02  # off-canvas tolerance
PLACEHOLDER = re.compile(r"\blorem ipsum\b|\bClick to add\b", re.I)

A = "http://schemas.openxmlformats.org/drawingml/2006/main"


def die(msg):
    print(f"cannot judge: {msg}", file=sys.stderr)
    sys.exit(2)


# ---------------------------------------------------------------- rendering

def render(pptx: Path, outdir: Path, dpi: int):
    outdir.mkdir(parents=True, exist_ok=True)
    try:
        proc = subprocess.run(
            ["soffice", "--headless", "--convert-to", "pdf", str(pptx),
             "--outdir", str(outdir)],
            capture_output=True, text=True, timeout=600)
    except FileNotFoundError:
        die("soffice not found")
    except subprocess.TimeoutExpired:
        die("soffice timed out")
    pdf = outdir / (pptx.stem + ".pdf")
    if proc.returncode != 0 or not pdf.is_file():
        die(f"soffice conversion failed: {proc.stderr.strip() or 'no output'}")
    slides = outdir / "slides"
    slides.mkdir(exist_ok=True)
    for old in slides.glob("slide*.png"):
        old.unlink()
    try:
        subprocess.run(
            ["pdftoppm", "-png", "-r", str(dpi), str(pdf), str(slides / "slide")],
            check=True, timeout=600)
    except (FileNotFoundError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired) as exc:
        die(f"pdftoppm failed: {exc}")
    return pdf, slides


def pdf_page_count(pdf: Path) -> int:
    try:
        info = subprocess.run(["pdfinfo", str(pdf)],
                              capture_output=True, text=True, check=True).stdout
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        die(f"pdfinfo failed: {exc}")
    return int(re.search(r"Pages:\s+(\d+)", info).group(1))


# ---------------------------------------------------------------- pdf text

def el_is(el, name):
    return el.tag.split("}")[-1] == name


def pdf_text_findings(pdf: Path, want, add, containers=None):
    try:
        xml = subprocess.run(["pdftotext", "-bbox-layout", str(pdf), "-"],
                             capture_output=True, text=True, check=True).stdout
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        die(f"pdftotext failed: {exc}")
    pages = [el for el in ET.fromstring(xml).iter() if el_is(el, "page")]
    for pno, page in enumerate(pages, 1):
        if pno not in want:
            continue
        words = []
        for ln in (el for el in page.iter() if el_is(el, "line")):
            txt = " ".join((w.text or "") for w in ln if el_is(w, "word")).strip()
            if not txt:
                continue
            if "�" in txt:
                add(pno, "garbled", "U+FFFD replacement char in rendered text",
                    txt)
            if PLACEHOLDER.search(txt):
                add(pno, "placeholder", "template placeholder text rendered",
                    txt)
            for w in ln:
                if not el_is(w, "word") or not (w.text or "").strip():
                    continue
                try:
                    box = tuple(float(w.get(k)) for k in
                                ("xMin", "yMin", "xMax", "yMax"))
                except (TypeError, ValueError):
                    continue
                words.append((box, w.text.strip()))
        collision_findings(pno, words, add)
        if containers is not None:
            per_page, slide_w, slide_h = containers
            try:
                pw, ph = float(page.get("width")), float(page.get("height"))
            except (TypeError, ValueError):
                continue
            if pno <= len(per_page) and pw > 0 and ph > 0:
                overflow_findings(pno, words,
                                  (per_page[pno - 1], slide_w, slide_h),
                                  pw, ph, add)


def collision_findings(pno, words, add):
    """Two words printed on the same pixels — a definite defect. Exempt:
    watermark-scale size gap (>=3x height), faux-bold/shadow double draw
    (same text at a near-identical position). Adjacent-line/kerning bbox
    touches are filtered by requiring the overlap to be a substantial part
    of a character in BOTH axes (>55% of line height vertically, >50% of
    the smaller height horizontally)."""
    words = sorted(words, key=lambda w: w[0][1])
    reported = set()
    for i, ((ax0, ay0, ax1, ay1), atxt) in enumerate(words):
        ah = ay1 - ay0
        if ah <= 0:
            continue
        for j in range(i + 1, len(words)):
            (bx0, by0, bx1, by1), btxt = words[j]
            if by0 >= ay1:  # sorted by yMin: nothing below can overlap
                break
            bh = by1 - by0
            if bh <= 0 or i in reported or j in reported:
                continue
            mh = min(ah, bh)
            oy = min(ay1, by1) - max(ay0, by0)
            ox = min(ax1, bx1) - max(ax0, bx0)
            if oy <= 0.55 * mh or ox <= 0.5 * mh:
                continue
            if max(ah, bh) >= 3 * mh:  # watermark-scale size gap
                continue
            if (atxt == btxt and abs(ax0 - bx0) <= 1.5
                    and abs(ay0 - by0) <= 1.5):  # faux-bold/shadow draw
                continue
            reported.update((i, j))
            add(pno, "text_collision",
                f"rendered words overlap at ({ax0:.0f},{ay0:.0f})pt",
                f"{atxt!r} × {btxt!r}")


# ------------------------------------------------------------- overflow

def _text_container(sh, l, t, w, h):
    """(box, grow_v, grow_h) when the shape can emit rendered text.
    grow_v: LibreOffice re-flows the height (spAutoFit shapes, tables) so
    the declared bottom is not a boundary. grow_h: wrap='none' text sizes
    itself horizontally from its anchor box by design."""
    import math
    from pptx.enum.text import MSO_AUTO_SIZE
    if getattr(sh, "rotation", 0):
        # AABB can't be trusted under rotation — use the circumscribed box
        # (over-generous container only ever hides findings, never invents)
        r = math.hypot(w, h) / 2
        cx, cy = l + w / 2, t + h / 2
        l, t, w, h = cx - r, cy - r, 2 * r, 2 * r
    grow_v = grow_h = False
    if getattr(sh, "has_table", False):
        grow_v = True
    elif sh.element.tag.split("}")[-1] == "graphicFrame":
        pass  # chart / SmartArt: clipped to the frame
    else:
        try:
            if not sh.has_text_frame:
                return None
            tf = sh.text_frame
            grow_v = tf.auto_size == MSO_AUTO_SIZE.SHAPE_TO_FIT_TEXT
            grow_h = tf.word_wrap is False
        except Exception:
            return None
    return ((l, t, l + w, t + h), grow_v, grow_h)


def _walk_containers(shapes, tf, out, inherited=False):
    """Collect text containers in slide space. Returns False when a rotated
    group is met — its children's geometry is unknowable, caller must skip
    the slide rather than risk false positives. Layout/master shapes
    (inherited=True) only count when they actually render text on the
    slide: footer/slide-number/date placeholders, or ordinary shapes that
    carry text. Title/body placeholder prompt boxes never render — and
    their huge frames would swallow every real overflow."""
    from pptx.enum.shapes import PP_PLACEHOLDER
    fx, fy, sx, sy = tf
    for sh in shapes:
        if sh.shape_type == 6:  # GROUP
            xfrm = None
            for child in sh.element:
                if child.tag.split("}")[-1] == "grpSpPr":
                    xfrm = child.find(f"{{{A}}}xfrm")
                    break
            if xfrm is not None and int(xfrm.get("rot", "0")):
                return False
            child_tf = _group_child_transform(sh.element, tf)
            if child_tf is not None:
                if not _walk_containers(sh.shapes, child_tf, out, inherited):
                    return False
            continue
        if sh.left is None or sh.width is None:
            continue
        if inherited:
            if sh.is_placeholder:
                if sh.placeholder_format.type not in (
                        PP_PLACEHOLDER.FOOTER, PP_PLACEHOLDER.SLIDE_NUMBER,
                        PP_PLACEHOLDER.DATE):
                    continue
            elif not shape_text(sh):
                continue
        c = _text_container(sh, fx + sh.left * sx, fy + sh.top * sy,
                            sh.width * sx, sh.height * sy)
        if c is not None:
            out.append(c)
    return True


def slide_containers(prs):
    """Per visible slide (pdf page order): list of text containers in EMU,
    or None when the slide must be skipped. Layout and master shapes are
    included — slide-number/footer text renders from them."""
    result = []
    for slide in prs.slides:
        if slide.element.get("show") == "0":
            continue
        boxes = []
        ok = _walk_containers(slide.shapes, (0.0, 0.0, 1.0, 1.0), boxes)
        for inherited in (slide.slide_layout.shapes,
                          slide.slide_layout.slide_master.shapes):
            ok = _walk_containers(inherited, (0.0, 0.0, 1.0, 1.0), boxes,
                                  inherited=True) and ok
        result.append(boxes if ok else None)
    return result


def overflow_findings(pno, words, containers, page_w, page_h, add):
    """A rendered word that escapes EVERY text container is text spilled
    outside whatever shape was meant to hold it (typically past a card's
    bottom edge). Threshold max(8pt, 0.6×word height) absorbs renderer
    metric drift, italic overhang and hanging bullets."""
    boxes, slide_w, slide_h = containers
    if boxes is None or not boxes or not words:
        return
    sx, sy = page_w / slide_w, page_h / slide_h  # EMU -> pt
    pt_boxes = [((l * sx, t * sy, r * sx, b * sy), gv, gh)
                for (l, t, r, b), gv, gh in boxes]
    escaped = []
    for (x0, y0, x1, y1), txt in words:
        h = y1 - y0
        if h <= 0:
            continue
        thr = max(8.0, 0.6 * h)
        best = None
        for (cl, ct, cr, cb), grow_v, grow_h in pt_boxes:
            excess = max(0.0,
                         ct - y0,
                         0.0 if grow_v else y1 - cb,
                         0.0 if grow_h else max(cl - x0, x1 - cr))
            if best is None or excess < best:
                best = excess
            if best == 0.0:
                break
        if best is not None and best > thr:
            escaped.append((best, txt))
    if escaped:
        escaped.sort(reverse=True)
        sample = "; ".join(f"{t!r} by {e:.0f}pt" for e, t in escaped[:3])
        add(pno, "text_overflow",
            f"{len(escaped)} word(s) render outside every text container",
            sample)


# ---------------------------------------------------------------- pptx side

def _group_child_transform(grp_el, outer):
    """Compose slide-space transform for children of a group shape.

    outer maps this group's parent-space EMU to slide space as
    (fx, fy, sx, sy): slide_x = fx + x * sx. Children live in the group's
    child space defined by chOff/chExt; the group's off/ext are parent-space.
    """
    xfrm = None
    for child in grp_el:
        if child.tag.split("}")[-1] == "grpSpPr":  # p: on slides, a: in dgm
            xfrm = child.find(f"{{{A}}}xfrm")
            break
    if xfrm is None:
        return None
    def _pt(tag):
        el = xfrm.find(f"{{{A}}}{tag}")
        if el is None:
            return None
        return int(el.get("x", el.get("cx", 0))), int(el.get("y", el.get("cy", 0)))
    off, ext, ch_off, ch_ext = _pt("off"), _pt("ext"), _pt("chOff"), _pt("chExt")
    if not all((off, ext, ch_off, ch_ext)) or 0 in ch_ext:
        return None
    fx, fy, sx, sy = outer
    gx, gy = fx + off[0] * sx, fy + off[1] * sy          # group origin, slide space
    ksx = sx * ext[0] / ch_ext[0]
    ksy = sy * ext[1] / ch_ext[1]
    return (gx - ch_off[0] * ksx, gy - ch_off[1] * ksy, ksx, ksy)


def flatten(shapes, tf=(0.0, 0.0, 1.0, 1.0)):
    """Yield (shape, l, t, w, h) in slide-space EMU, recursing into groups."""
    fx, fy, sx, sy = tf
    for sh in shapes:
        if sh.shape_type == 6:  # GROUP
            child_tf = _group_child_transform(sh.element, tf)
            if child_tf is not None:
                yield from flatten(sh.shapes, child_tf)
            continue
        if sh.left is None or sh.width is None:
            continue
        if getattr(sh, "rotation", 0):  # bbox wrong under rotation
            continue
        yield (sh, fx + sh.left * sx, fy + sh.top * sy,
               sh.width * sx, sh.height * sy)


def shape_text(sh):
    try:
        if sh.has_text_frame:
            return sh.text_frame.text.strip()
    except Exception:
        pass
    return ""


def is_opaque_solid(sh):
    """True when the shape paints an opaque solid rectangle of fill —
    the only case where 'it covers the text below' is certain. Pictures,
    gradients, pattern fills and anything carrying alpha are skipped
    rather than guessed at; connectors/lines never fill their bbox."""
    if sh.element.tag.split("}")[-1] == "cxnSp":
        return False
    try:
        from pptx.enum.dml import MSO_FILL
        if sh.fill.type != MSO_FILL.SOLID:
            return False
    except (AttributeError, TypeError, NotImplementedError):
        return False
    sp_pr = getattr(sh.element, "spPr", None)
    if sp_pr is not None:
        for alpha in sp_pr.iter(f"{{{A}}}alpha"):
            if int(alpha.get("val", "100000")) < 100000:
                return False
        for tag in ("alphaMod", "alphaModFix"):
            if next(sp_pr.iter(f"{{{A}}}{tag}"), None) is not None:
                return False
    return True


def occlusion_findings(sno, placed, add):
    """placed: [(shape, l, t, w, h)] in document order == z-order. A text
    shape whose bbox is >=70% covered by a single LATER opaque solid-fill
    shape is text the reader cannot see — text meant to sit on a card is
    always drawn after the card, never before."""
    for i, (sh, l, t, w, h) in enumerate(placed):
        if w <= 0 or h <= 0:
            continue
        txt = shape_text(sh)
        if not txt:
            continue
        area = w * h
        for csh, cl, ct, cw, ch in placed[i + 1:]:
            ox = min(l + w, cl + cw) - max(l, cl)
            oy = min(t + h, ct + ch) - max(t, ct)
            if ox <= 0 or oy <= 0 or ox * oy < 0.70 * area:
                continue
            if not is_opaque_solid(csh):
                continue
            add(sno, "text_occluded",
                f"text shape is {ox * oy / area:.0%} covered by "
                f"later-drawn opaque shape {csh.name!r}",
                f"{sh.name}: {txt[:40]}")
            break


def pptx_findings(prs, want, add):
    from pptx.enum.shapes import MSO_SHAPE_TYPE
    W, H = prs.slide_width, prs.slide_height
    tol = int(OFF_TOL_IN * EMU_IN)
    for sno, slide in enumerate(prs.slides, 1):
        if sno not in want:
            continue
        placed = list(flatten(slide.shapes))
        for sh, l, t, w, h in placed:
            over = max(-l, -t, l + w - W, t + h - H)
            if over > tol and shape_text(sh):
                add(sno, "text_off_canvas",
                    f"text shape extends {over / EMU_IN:.2f}in outside the slide",
                    sh.name)
            if sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
                try:
                    blob = sh.image.blob
                except Exception as exc:
                    add(sno, "broken_image",
                        f"image part unresolvable ({type(exc).__name__})",
                        sh.name)
                    continue
                if not blob:
                    add(sno, "broken_image", "zero-byte image part", sh.name)
        occlusion_findings(sno, placed, add)


def visible_slide_count(prs) -> int:
    """Slides soffice will render: skip slides marked show="0"."""
    return sum(1 for s in prs.slides if s.element.get("show") != "0")


# ------------------------------------------------------------------- main

def parse_pages(spec, n):
    if not spec:
        return set(range(1, n + 1))
    out = set()
    for part in spec.split(","):
        a, _, b = part.partition("-")
        out.update(range(int(a), int(b or a) + 1))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pptx")
    ap.add_argument("--outdir", default=None,
                    help="render output dir (pdf + slides/*.png); default: "
                         "/tmp/pptx_judge/<deck-stem> — QA intermediates, "
                         "not a deliverable")
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--pages", default="",
                    help="restrict finding emission, e.g. 3-6 or 1,2,9 "
                         "(render always covers the whole deck)")
    ap.add_argument("--no-render", action="store_true",
                    help="reuse existing pdf/pngs in outdir")
    ap.add_argument("--json", action="store_true",
                    help="machine-readable JSON output")
    args = ap.parse_args()

    try:
        from pptx import Presentation
    except ImportError:
        die("python-pptx not installed")
    pptx_path = Path(args.pptx)
    if not pptx_path.is_file():
        die(f"file not found: {pptx_path}")
    outdir = (Path(args.outdir) if args.outdir
              else Path(tempfile.gettempdir()) / "pptx_judge" / pptx_path.stem)

    if args.no_render:
        pdf = outdir / (pptx_path.stem + ".pdf")
        slides_dir = outdir / "slides"
        if not pdf.is_file():
            die(f"--no-render but {pdf} missing")
    else:
        pdf, slides_dir = render(pptx_path, outdir, args.dpi)

    prs = Presentation(str(pptx_path))
    n_slides = len(prs.slides)
    n_visible = visible_slide_count(prs)
    n_pdf = pdf_page_count(pdf)
    pngs = sorted(slides_dir.glob("slide-*.png"))

    want = parse_pages(args.pages, n_slides)
    findings = []

    def add(page, rule, detail, ref):
        loc = f"slide {page}" if page else "deck"
        findings.append({"rule": rule, "location": loc,
                         "detail": f"{detail} ({str(ref)[:80]})"})

    if n_visible != n_pdf:
        add(0, "render_mismatch",
            f"pptx has {n_visible} visible slides, pdf has {n_pdf} pages",
            pdf.name)
    if len(pngs) != n_pdf:
        add(0, "render_mismatch",
            f"pdf has {n_pdf} pages, {len(pngs)} pngs rendered", slides_dir)
    for p in pngs:
        if p.stat().st_size == 0:
            add(0, "render_mismatch", "zero-byte png", p.name)

    pdf_text_findings(pdf, want, add,
                      (slide_containers(prs), prs.slide_width,
                       prs.slide_height))
    pptx_findings(prs, want, add)
    findings.sort(key=lambda f: (f["location"], f["rule"]))

    if args.json:
        json.dump({"file": str(pptx_path), "clean": not findings,
                   "findings": findings},
                  sys.stdout, ensure_ascii=False, indent=1)
        print()
    else:
        print(f"deck: {pptx_path}  ({n_slides} slides, "
              f"{len(pngs)} pngs under {slides_dir})")
        for f in findings:
            print(f"  {f['rule']} {f['location']}: {f['detail']}")
        print(f"judge: {len(findings)} finding(s)" if findings
              else "judge: clean")
    sys.exit(1 if findings else 0)


if __name__ == "__main__":
    main()
