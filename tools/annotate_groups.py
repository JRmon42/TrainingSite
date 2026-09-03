#!/usr/bin/env python3
"""Annotate an exam JSON with question-group metadata.

Two kinds of groups are detected:

  * ``case-study``      - questions that share one long "Case Study" scenario
                          (Contoso / Fabrikam style).
  * ``scenario-series`` - questions carrying the "Note: This question is part of
                          a series of questions that present the same scenario."
                          preamble, where each question offers a different
                          Solution for the same goal.

Questions belonging to the same group receive a shared ``groupId`` plus the
shared scenario text, so the app can keep them consecutive and show the
scenario once per group.

Usage:  python3 tools/annotate_groups.py data/exams/dp-800.json
"""

import json
import re
import sys

# Boilerplate that is identical across every case-study question and therefore
# useless for telling one case study from another.
CASE_BOILERPLATE = re.compile(
    r".*?click the Question button to return to the question\.\s*", re.I | re.S)
SERIES_BOILERPLATE = re.compile(
    r".*?these questions will not appear in the review screen\.\s*", re.I | re.S)

CASE_MARKER = re.compile(r"case\s+stud", re.I)
SERIES_MARKER = re.compile(
    r"series of questions that present the same scenario", re.I)
SOLUTION_SPLIT = re.compile(r"\bSolution\s*:", re.I)

SIMILARITY_THRESHOLD = 0.30
SHINGLE_SIZE = 6


def norm(text):
    return re.sub(r"\s+", " ", text or "").strip()


def soft_norm(text):
    """Normalize whitespace but keep line breaks.

    ``norm`` flattens everything onto one line, which is right for similarity
    matching but destroys the indentation of fenced code blocks in a stem. The
    per-question ``groupStem`` is sliced out of this version instead so that
    Transact-SQL / JSON listings survive de-duplication intact.
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[^\S\n]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def shingles(text, k=SHINGLE_SIZE):
    words = re.findall(r"[a-z0-9]+", text.lower())
    if len(words) < k:
        return {tuple(words)} if words else set()
    return {tuple(words[i:i + k]) for i in range(len(words) - k + 1)}


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def scenario_of(question):
    """Return (kind, scenario_text, solution_text) for a grouped question."""
    stem = norm(question.get("stem"))
    if SERIES_MARKER.search(stem):
        body = SERIES_BOILERPLATE.sub("", stem, count=1)
        parts = SOLUTION_SPLIT.split(body, maxsplit=1)
        scenario = parts[0].strip()
        solution = ("Solution: " + parts[1].strip()) if len(parts) > 1 else ""
        return "scenario-series", scenario, solution
    if CASE_MARKER.search(stem):
        body = CASE_BOILERPLATE.sub("", stem, count=1)
        # Cap the fingerprint: the tail of the stem holds the question-specific
        # wording, which must not influence which case study we match.
        return "case-study", body.strip(), ""
    return None, "", ""


def cluster(items):
    """Greedy single-link clustering on scenario similarity."""
    clusters = []  # list of {"sig": set, "members": [...]}
    for item in items:
        sig = shingles(item["scenario"][:2500])
        best, best_score = None, 0.0
        for c in clusters:
            score = jaccard(sig, c["sig"])
            if score > best_score:
                best, best_score = c, score
        if best is not None and best_score >= SIMILARITY_THRESHOLD:
            best["members"].append(item)
            # Keep the longest signature as the cluster representative so later
            # OCR-truncated variants still match.
            if len(sig) > len(best["sig"]):
                best["sig"] = sig
        else:
            clusters.append({"sig": sig, "members": [item]})
    return clusters


def word_spans(text):
    """Tokens plus the character offset just past each token."""
    return [(m.group(0).lower(), m.end()) for m in re.finditer(r"\S+", text)]


def common_prefix_len(a, b):
    """Length in characters of the shared leading text of a and b (word-aligned)."""
    ta, tb = word_spans(a), word_spans(b)
    i = 0
    while i < len(ta) and i < len(tb) and ta[i][0] == tb[i][0]:
        i += 1
    return ta[i - 1][1] if i else 0


MIN_SHARED_PREFIX = 400
SENTENCE_END = re.compile(r"[.?!]['\")\]]?\s")


def snap_to_sentence(text, pos):
    """Pull a split point back to the end of the last complete sentence.

    The raw common prefix usually runs a few words into the question itself
    (siblings often open with "You need to ..."), which would leave the question
    starting mid-sentence.
    """
    ends = [m.end() for m in SENTENCE_END.finditer(text, 0, pos + 1)]
    return ends[-1] if ends else pos


def split_shared(members):
    """Strip the scenario each question shares with its siblings.

    Returns the longest shared scenario found in the group. Each member gets a
    ``question_text`` holding only the part that is unique to it; members whose
    wording diverges too early (OCR variants) keep their full stem.
    """
    best_shared = ""
    for m in members:
        best = 0
        for other in members:
            if other is m:
                continue
            best = max(best, common_prefix_len(m["stem"], other["stem"]))
        m["prefix"] = best
        if best >= MIN_SHARED_PREFIX:
            cut = snap_to_sentence(m["stem"], best)
            m["prefix"] = cut
            shared = m["stem"][:cut]
            if len(shared) > len(best_shared):
                best_shared = shared
    for m in members:
        if m["prefix"] >= MIN_SHARED_PREFIX:
            text = m["stem"][m["prefix"]:].strip()
            # OCR leaves the tab header ("Question") in front of the real text.
            text = re.sub(r"^(?:Question|Questions)\b[\s:\-\u2013]*", "", text).strip()
            m["question_text"] = text
        else:
            m["question_text"] = ""  # keep the original stem
    return best_shared.strip()


def title_for(kind, scenario, index):
    company = ""
    m = re.search(r"\b(Contoso|Fabrikam|Litware|Adventure\s?Works|Northwind|Woodgrove|Tailwind)\b",
                  scenario, re.I)
    if m:
        company = m.group(1).title()
    if kind == "case-study":
        return f"Case study{': ' + company if company else ''}"
    goal = ""
    g = re.search(r"You need to ([^.]+)\.", scenario, re.I)
    if g:
        goal = g.group(1).strip()
        if len(goal) > 70:
            goal = goal[:67].rstrip() + "..."
    return f"Same scenario, multiple solutions{': ' + goal if goal else f' #{index}'}"


CASE_NOTE = ("This is a case study. All of the questions below refer to the same "
             "scenario. Review the scenario, then answer each question.")
SERIES_NOTE = ("Each question in this series presents a different solution for the "
               "same goal. Some, all, or none of the solutions may be correct — "
               "judge each one independently.")


def main(path):
    with open(path, encoding="utf-8") as fh:
        exam = json.load(fh)

    questions = exam["questions"]
    buckets = {"case-study": [], "scenario-series": []}
    for q in questions:
        kind, scenario, solution = scenario_of(q)
        if not kind or not scenario:
            continue
        buckets[kind].append(
            {"q": q, "scenario": scenario, "solution": solution,
             "stem": soft_norm(q.get("stem"))})

    # Clear any stale annotation so the script is idempotent.
    for q in questions:
        for key in ("groupId", "groupKind", "groupTitle", "groupScenario",
                    "groupNote", "groupOrder", "groupSize", "groupStem"):
            q.pop(key, None)

    summary = []
    for kind in ("case-study", "scenario-series"):
        for i, c in enumerate(cluster(buckets[kind]), start=1):
            members = sorted(c["members"], key=lambda m: m["q"]["id"])
            if kind == "scenario-series":
                # The scenario/solution split is explicit for these.
                shared = max((m["scenario"] for m in members), key=len)
                for m in members:
                    m["question_text"] = m["solution"]
            else:
                shared = split_shared(members)
                if not shared:
                    shared = max((m["scenario"] for m in members), key=len)
            gid = f"{kind}-{i}"
            title = title_for(kind, shared, i)
            for order, m in enumerate(members, start=1):
                q = m["q"]
                q["groupId"] = gid
                q["groupKind"] = kind
                q["groupTitle"] = title
                q["groupScenario"] = shared
                q["groupNote"] = CASE_NOTE if kind == "case-study" else SERIES_NOTE
                q["groupOrder"] = order
                q["groupSize"] = len(members)
                if m.get("question_text"):
                    q["groupStem"] = m["question_text"]
            summary.append((gid, title, [m["q"]["id"] for m in members],
                            sum(1 for m in members if m.get("question_text"))))

    with open(path, "w", encoding="utf-8") as fh:
        json.dump(exam, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(f"Annotated {path}")
    for gid, title, ids, split in summary:
        print(f"  {gid:<20} {len(ids):>2} questions ({split} de-duplicated)  {title}")
        print(f"    {ids}")
    grouped = sum(len(ids) for _, _, ids, _ in summary)
    print(f"  total grouped: {grouped} / {len(questions)}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "data/exams/dp-800.json")
