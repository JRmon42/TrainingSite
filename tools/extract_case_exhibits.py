#!/usr/bin/env python3
"""Extract the exhibit figures of a case study from the source PDF.

The scenario text of a case study refers to figures that only exist as images in
the PDF ("The database contains the following tables.", "... stores JSON
documents in the following format.", ...). Those figures were never pulled out,
so the case-study tabs showed the sentence but not the table/query it refers to.

Each PDF page is a rendered card: one full-page background image plus the real
figures. Walking the page in reading order, a figure always directly follows the
sentence that introduces it, so the last sentence of the preceding text block is
used as the figure's anchor.

The result is written to a sidecar ``<exam>.exhibits.json`` keyed by that anchor
sentence, which ``annotate_groups.py`` then applies to the section bodies. Keying
on the sentence rather than on a section index keeps the two tools independent
and lets either be re-run on its own.

Usage:  python3 tools/extract_case_exhibits.py data/exams/dp-800.json
"""

import hashlib
import io
import json
import os
import re
import sys

import pymupdf

# The white card each page is drawn on; never an exhibit.
BACKGROUND_MIN_W = 550
BACKGROUND_MIN_H = 780
# Rules, spacers and other slivers.
MIN_W = 80
MIN_H = 30
# How many pages after a question header to scan for figures.
PAGE_SPAN = 7

SENTENCE = re.compile(r"[^.?!]*[.?!]")


def norm(text):
    return re.sub(r"\s+", " ", text or "").strip()


def last_sentence(text):
    """The trailing sentence of a text block, which introduces the next figure."""
    flat = norm(text)
    hits = SENTENCE.findall(flat)
    if not hits:
        return flat
    tail = hits[-1].strip()
    # A section heading sits in the same block as the sentence that follows it
    # ("DAB - You create a DAB configuration file..."); drop it so the anchor is
    # the sentence alone and matches the section body rather than its title.
    return re.sub(r"^[^.?!]{0,45}? - ", "", tail)


def page_elements(page):
    """Text blocks and non-background images on one page, in reading order."""
    out = []
    for b in page.get_text("blocks"):
        if (b[4] or "").strip():
            out.append({"kind": "text", "y": b[1], "text": b[4]})
    for im in page.get_images(full=True):
        for r in page.get_image_rects(im[0]):
            w, h = r.width, r.height
            if w >= BACKGROUND_MIN_W and h >= BACKGROUND_MIN_H:
                continue
            if w < MIN_W or h < MIN_H:
                continue
            out.append({"kind": "image", "y": r.y0, "xref": im[0],
                        "w": round(w), "h": round(h)})
    out.sort(key=lambda e: e["y"])
    return out


def save_image(doc, xref, path):
    pix = pymupdf.Pixmap(doc, xref)
    if pix.colorspace and pix.colorspace.n > 3:  # CMYK -> RGB
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    pix.save(path)
    return os.path.getsize(path)


def main(exam_path):
    exam = json.load(io.open(exam_path, encoding="utf-8"))
    exam_id = exam.get("id") or "exam"
    root = os.path.dirname(os.path.dirname(exam_path))
    pdf_path = os.path.join(root, "pdfs", exam.get("pdfFile") or f"{exam_id}.pdf")
    images_dir = os.path.join(root, "images")
    os.makedirs(images_dir, exist_ok=True)

    groups = {}
    for q in exam["questions"]:
        if q.get("groupKind") != "case-study" or not q.get("groupId"):
            continue
        groups.setdefault(q["groupId"], []).append(q)
    if not groups:
        print("no case-study groups found; run annotate_groups.py first")
        return 1

    doc = pymupdf.open(pdf_path)
    sidecar, summary, seen = {}, [], set()

    for gid in sorted(groups):
        members = groups[gid]
        scenario = norm(members[0].get("groupScenario") or "")
        if not scenario:
            continue
        # The scenario is reprinted before every question of the group, so scan
        # around each one and keep the first copy of each distinct figure. The
        # pages are walked as one continuous stream because a figure often sits
        # at the top of the page after the sentence that introduces it.
        pages = sorted({p for q in members for p in
                        range((q.get("pdfPage") or 1) - 1,
                              (q.get("pdfPage") or 1) + PAGE_SPAN + 1)
                        if 1 <= p <= doc.page_count})
        stream = []
        for page_no in pages:
            for el in page_elements(doc[page_no - 1]):
                el["page"] = page_no
                stream.append(el)

        found = 0
        for i, e in enumerate(stream):
            if e["kind"] != "image":
                continue
            prev = next((stream[j] for j in range(i - 1, -1, -1)
                         if stream[j]["kind"] == "text"), None)
            if not prev:
                continue
            anchor = last_sentence(prev["text"])
            # Only figures introduced by the shared scenario are exhibits;
            # anything else belongs to a single question's answer area.
            if len(anchor) < 25 or anchor not in scenario:
                continue
            if anchor in sidecar:
                continue
            digest = hashlib.sha1(pymupdf.Pixmap(doc, e["xref"]).samples).hexdigest()
            if digest in seen:  # same figure reprinted before another question
                continue
            seen.add(digest)
            found += 1
            name = f"{exam_id}_{gid}_ex{found}.png"
            save_image(doc, e["xref"], os.path.join(images_dir, name))
            sidecar[anchor] = [name]
            summary.append((gid, e["page"], f'{e["w"]}x{e["h"]}', name, anchor[:58]))

    out_path = os.path.splitext(exam_path)[0] + ".exhibits.json"
    with io.open(out_path, "w", encoding="utf-8") as fh:
        json.dump(sidecar, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")

    print(f"Wrote {out_path}  ({len(sidecar)} anchors, {len(summary)} figures)")
    for gid, page, dims, name, anchor in summary:
        print(f"  {gid:<14} p{page:<4} {dims:>10}  {name:<28} after: {anchor}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "data/exams/dp-800.json"))
