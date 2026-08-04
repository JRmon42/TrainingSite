#!/usr/bin/env python3
"""
parse_pdf.py — Convert a CertyIQ-style certification PDF dump into the
Certification Trainer exam JSON format.

Usage:
    python3 tools/parse_pdf.py <pdf> <exam-id> "<Exam Name>" <images-dir> <out-json>

Env:
    VERBOSE=1   (or -v)   per-question progress on stderr
    PYTHON=...            (handled by the caller, not here)

The LAST line printed to stdout is a one-line JSON summary of type counts,
which the server captures on success.

Design notes
------------
* Text is read in reading order with pdfplumber (required).
* single / multi questions are parsed directly from text and auto-graded.
* HOTSPOT / DRAG DROP questions cannot be graded from text reliably, so we:
    - render the page(s) to PNGs with PyMuPDF (fitz) when available, and
    - optionally try OCR + green/red colour analysis (rapidocr + numpy) to
      auto-detect the answer;
    - if detection is uncertain OR the optional libs are missing, we emit a
      self-graded `image` question (never fail the import).
Optional dependencies (pymupdf, rapidocr-onnxruntime, numpy) are imported
lazily; the parser still works with pdfplumber alone (image questions just
won't carry cropped PNGs).
"""

import os
import re
import sys
import json

VERBOSE = os.environ.get("VERBOSE") == "1" or "-v" in sys.argv
if "-v" in sys.argv:
    sys.argv.remove("-v")


def log(*a):
    if VERBOSE:
        print(*a, file=sys.stderr, flush=True)


def die(msg):
    print(msg, file=sys.stderr, flush=True)
    sys.exit(1)


try:
    import pdfplumber
except ImportError:
    die("Missing required dependency 'pdfplumber'. Install it with: pip install pdfplumber")

# ---- optional deps (lazy / guarded) ----
try:
    import fitz  # PyMuPDF
    HAVE_FITZ = True
except Exception:
    HAVE_FITZ = False

try:
    import numpy as np
    HAVE_NUMPY = True
except Exception:
    HAVE_NUMPY = False

try:
    from rapidocr_onnxruntime import RapidOCR
    HAVE_OCR = True
except Exception:
    HAVE_OCR = False


QUESTION_RE = re.compile(r"^\s*Question:?\s*(\d+)\b", re.IGNORECASE)
OPTION_RE = re.compile(r"^\s*([A-E])[\.\)]\s?(.*)$")
ANSWER_RE = re.compile(r"^\s*Answer:\s*([A-E][A-E\s,]*)", re.IGNORECASE)
EXPL_RE = re.compile(r"^\s*Explanation:", re.IGNORECASE)
HOTSPOT_RE = re.compile(r"\b(HOTSPOT|DRAG\s*DROP|DRAG\s*AND\s*DROP)\b", re.IGNORECASE)


def extract_pages(pdf_path):
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages):
            txt = page.extract_text(layout=False) or ""
            pages.append(txt)
    return pages


def build_line_index(pages):
    """Return list of (page_index, line_text) preserving reading order."""
    idx = []
    for pi, txt in enumerate(pages):
        for line in txt.split("\n"):
            idx.append((pi, line))
    return idx


def split_questions(line_index):
    """Yield dicts: {num, page, lines:[...] } for each question block."""
    starts = [i for i, (_, l) in enumerate(line_index) if QUESTION_RE.match(l)]
    starts.append(len(line_index))
    for k in range(len(starts) - 1):
        s, e = starts[k], starts[k + 1]
        page = line_index[s][0]
        num = int(QUESTION_RE.match(line_index[s][1]).group(1))
        lines = [line_index[i][1] for i in range(s, e)]
        yield {"num": num, "page": page, "lines": lines}


def parse_block(block):
    """Parse a raw block into structured fields (text-only)."""
    lines = block["lines"]
    # locate answer + explanation
    ans_i = expl_i = None
    for i, l in enumerate(lines):
        if ans_i is None and ANSWER_RE.match(l):
            ans_i = i
        if expl_i is None and EXPL_RE.match(l):
            expl_i = i
    answer = None
    if ans_i is not None:
        letters = ANSWER_RE.match(lines[ans_i]).group(1)
        answer = sorted(set(re.findall(r"[A-E]", letters.upper())))

    # options region between header and answer/explanation
    opt_end = ans_i if ans_i is not None else (expl_i if expl_i is not None else len(lines))
    region = lines[1:opt_end]
    opt_starts = [i for i, l in enumerate(region) if OPTION_RE.match(l)]

    options = {}
    if opt_starts:
        stem_lines = region[:opt_starts[0]]
        bounds = opt_starts + [len(region)]
        for j in range(len(opt_starts)):
            chunk = region[opt_starts[j]:bounds[j + 1]]
            m = OPTION_RE.match(chunk[0])
            letter = m.group(1)
            text = " ".join([m.group(2).strip()] + [x.strip() for x in chunk[1:] if x.strip()])
            options[letter] = text.strip()
    else:
        stem_lines = region

    stem = " ".join(x.strip() for x in stem_lines if x.strip())
    stem = re.sub(r"\s*CertyIQ\s*$", "", stem).strip()
    stem = re.sub(r"^\s*Question:?\s*\d+\s*", "", stem).strip()

    # explanation
    explanation = ""
    if expl_i is not None:
        expl_lines = lines[expl_i + 1:]
    elif ans_i is not None:
        expl_lines = lines[ans_i + 1:]
    else:
        expl_lines = []
    explanation = "\n".join(x.rstrip() for x in expl_lines).strip()
    explanation = re.sub(r"\n{3,}", "\n\n", explanation)

    return {
        "num": block["num"],
        "page": block["page"],
        "stem": stem,
        "options": options,
        "answer": answer,
        "explanation": explanation,
        "is_hotspot": bool(HOTSPOT_RE.search(stem)),
    }


def render_page_png(pdf_path, page_index, out_path):
    """Render a single page to PNG using PyMuPDF; return True on success."""
    if not HAVE_FITZ:
        return False
    try:
        doc = fitz.open(pdf_path)
        page = doc.load_page(page_index)
        pix = page.get_pixmap(matrix=fitz.Matrix(2, 2))
        pix.save(out_path)
        doc.close()
        return True
    except Exception as e:
        log("  ! render failed:", e)
        return False


_ocr_engine = None


def try_detect_from_image(png_path):
    """
    Best-effort OCR + colour analysis. Returns None (uncertain) for now unless
    a strong green highlight signal is present. Kept conservative on purpose so
    we fall back to a self-graded image question rather than guess wrong.
    """
    global _ocr_engine
    if not (HAVE_NUMPY and HAVE_FITZ):
        return None
    try:
        from PIL import Image  # optional
    except Exception:
        return None
    try:
        img = np.asarray(Image.open(png_path).convert("RGB"), dtype=np.int16)
        r, g, b = img[..., 0], img[..., 1], img[..., 2]
        green_mask = (g > 120) & (g - r > 40) & (g - b > 40)
        frac = float(green_mask.mean())
        log(f"  green fraction={frac:.4f} ocr={HAVE_OCR}")
        # We can see a highlight exists, but mapping it to a specific option
        # reliably needs layout coordinates we don't extract here -> stay uncertain.
        return None
    except Exception as e:
        log("  ! detect failed:", e)
        return None


def build_question(parsed, pdf_path, exam_id, images_dir):
    num = parsed["num"]
    q = {"id": num, "stem": parsed["stem"], "explanation": parsed.get("explanation", "")}

    if parsed["is_hotspot"] or not parsed["options"]:
        # image / self-graded fallback (optionally with cropped page image)
        q["type"] = "image"
        if HOTSPOT_RE.search(parsed["stem"] or ""):
            q["subtype"] = "hotspot" if re.search(r"HOTSPOT", parsed["stem"], re.I) else "dragdrop"
        src_name = f"{exam_id}_q{num}_src.png"
        src_path = os.path.join(images_dir, src_name)
        if render_page_png(pdf_path, parsed["page"], src_path):
            q["sourceImages"] = [src_name]
            q["questionImages"] = [src_name]
            # answer page heuristic: render the following page as answer crop
            ans_name = f"{exam_id}_q{num}_a_p1.png"
            ans_path = os.path.join(images_dir, ans_name)
            if render_page_png(pdf_path, parsed["page"] + 1, ans_path):
                q["answerImages"] = [ans_name]
                q["sourceImages"].append(ans_name)  # filtered out of quiz-time toggle by _a_p rule
            detected = try_detect_from_image(ans_path if os.path.exists(ans_path) else src_path)
            # detected stays None -> keep image type
        q["explanation"] = parsed.get("explanation") or "Self-graded question extracted from the exam PDF."
        return q, "image"

    # text-graded single / multi
    ans = parsed["answer"] or []
    qtype = "multi" if len(ans) > 1 else "single"
    q["type"] = qtype
    q["choices"] = [
        {"key": k, "text": parsed["options"][k], "correct": (k in ans)}
        for k in sorted(parsed["options"].keys())
    ]
    return q, qtype


def main():
    args = sys.argv[1:]
    if len(args) < 5:
        die("Usage: parse_pdf.py <pdf> <exam-id> <name> <images-dir> <out-json>")
    pdf_path, exam_id, name, images_dir, out_json = args[:5]
    os.makedirs(images_dir, exist_ok=True)
    os.makedirs(os.path.dirname(os.path.abspath(out_json)), exist_ok=True)

    log(f"Opening {pdf_path} (fitz={HAVE_FITZ}, numpy={HAVE_NUMPY}, ocr={HAVE_OCR})")
    pages = extract_pages(pdf_path)
    line_index = build_line_index(pages)

    counts = {"single": 0, "multi": 0, "dropdown": 0, "yesno": 0, "image": 0}
    questions = []
    for block in split_questions(line_index):
        parsed = parse_block(block)
        if not parsed["stem"] and not parsed["options"]:
            continue
        q, qtype = build_question(parsed, pdf_path, exam_id, images_dir)
        counts[qtype] = counts.get(qtype, 0) + 1
        questions.append(q)
        log(f"Q{parsed['num']}: {qtype}")

    exam = {
        "id": exam_id,
        "name": name,
        "source": f"Imported from {os.path.basename(pdf_path)}",
        "totalQuestions": len(questions),
        "questions": questions,
    }
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(exam, f, ensure_ascii=False, indent=1)

    summary = {"id": exam_id, "total": len(questions), **counts}
    print(json.dumps(summary))  # MUST be the last stdout line


if __name__ == "__main__":
    main()
