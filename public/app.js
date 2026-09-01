"use strict";

/* ===================== Certification Trainer — SPA ===================== */

const state = {
  exams: [],
  exam: null,
  analysis: { windowSize: 3, incorrect: [], seen: [], sessionsConsidered: 0 },
  session: null,
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const view = () => $("#view");

function tpl(id) { return document.getElementById(id).content.cloneNode(true); }

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Escape then turn bare URLs into links.
function linkify(text) {
  const parts = String(text == null ? "" : text).split(/(https?:\/\/[^\s<>"')]+)/g);
  return parts.map((p, i) => {
    if (i % 2 === 1) {
      const safe = escapeHtml(p);
      return `<a href="${safe}" target="_blank" rel="noopener">${safe}</a>`;
    }
    return escapeHtml(p);
  }).join("");
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

/* ===================== Router ===================== */
const pages = {
  practice: renderPractice,
  import: renderImport,
};
function go(page) {
  $$(".navlink").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  (pages[page] || renderPractice)();
}
$$(".navlink").forEach(b => b.onclick = () => go(b.dataset.page));

/* ===================== Practice page ===================== */
async function renderPractice() {
  stopQuizTimer();
  view().innerHTML = "";
  view().appendChild(tpl("tpl-practice"));

  try { state.exams = await api("/api/exams"); }
  catch { state.exams = []; }

  const sel = $("#examSelect");
  if (!state.exams.length) {
    sel.innerHTML = `<option value="">No exams — add one from “Add exam (PDF)”</option>`;
    $("#startBtn").disabled = true;
  } else {
    sel.innerHTML = state.exams.map(e =>
      `<option value="${e.id}">${escapeHtml(e.name)}</option>`).join("");
  }
  renderExamList();

  sel.onchange = () => selectExam(sel.value);
  $("#lookback").oninput = () => refreshAnalysis();
  $("#optWrong").onchange = updateSelectionNote;
  $("#optUnseen").onchange = updateSelectionNote;
  $("#numQuestions").oninput = updateSelectionNote;
  $("#startBtn").onclick = startPractice;

  if (state.exams.length) await selectExam(state.exams[0].id);
}

async function selectExam(id) {
  const meta = state.exams.find(e => e.id === id);
  state.examMeta = meta;
  if (!meta) return;
  const c = meta.counts;
  $("#examMeta").textContent =
    `${meta.totalQuestions} questions · single ${c.single} · multi ${c.multi} · dropdown ${c.dropdown} · yes/no ${c.yesno} · image ${c.image} — ${meta.autoGraded} auto-graded · ${meta.selfGraded} self-graded`;
  $("#numQuestions").max = meta.totalQuestions;
  if (+$("#numQuestions").value > meta.totalQuestions) $("#numQuestions").value = meta.totalQuestions;
  try { state.exam = await api(`/api/exams/${id}`); } catch { state.exam = null; }
  await refreshAnalysis();
}

async function refreshAnalysis() {
  if (!state.examMeta) return;
  const lookback = Math.max(1, parseInt($("#lookback").value, 10) || 3);
  let data;
  try { data = await api(`/api/exams/${state.examMeta.id}/history?lookback=${lookback}`); }
  catch { data = { count: 0, sessions: [], analysis: { windowSize: lookback, incorrect: [], seen: [] } }; }
  state.analysis = data.analysis;
  state.history = data.sessions;

  const n = data.analysis.windowSize;
  const total = state.exam ? state.exam.questions.length : 0;
  const unseenCount = total - (data.analysis.seen ? data.analysis.seen.length : 0);
  const wrongCount = data.analysis.incorrect ? data.analysis.incorrect.length : 0;

  $("#lblWrong").textContent = `Prioritize questions I got wrong (last ${n} session${n > 1 ? "s" : ""}) — ${wrongCount}`;
  $("#lblUnseen").textContent = `Include questions not seen in my last ${n} session${n > 1 ? "s" : ""} — ${unseenCount}`;
  const w = $("#optWrong"); w.disabled = data.count === 0; if (data.count === 0) w.checked = false;

  renderRecentSessions();
  updateSelectionNote();
}

function updateSelectionNote() {
  const wrong = $("#optWrong").checked, unseen = $("#optUnseen").checked;
  let note;
  if (!wrong && !unseen) note = "Selection: random questions from the whole exam.";
  else {
    const tiers = [];
    if (wrong) tiers.push("questions you recently got wrong");
    if (unseen) tiers.push("questions you haven’t seen recently");
    note = `Selection: prioritize ${tiers.join(", then ")}, then fill the rest at random.`;
  }
  $("#selectionNote").textContent = note + groupFitNote();
}

/* Case studies and scenario series are always kept whole, so they can only be
   drawn when the requested question count leaves room for all of their
   questions. Tell the user when their count is too small. */
function groupFitNote() {
  if (!state.exam) return "";
  const n = parseInt($("#numQuestions").value, 10) || 0;
  const sizes = new Map();
  for (const q of state.exam.questions) {
    if (q.groupId) sizes.set(q.groupId, q.groupSize || 0);
  }
  if (!sizes.size) return "";
  const all = [...sizes.values()];
  const smallest = Math.min(...all);
  const excluded = all.filter(s => s > n).length;
  if (!excluded) return " Case studies and scenario series are included in full.";
  if (excluded === all.length) {
    return ` Note: case studies/scenario series are kept whole — ask for at least ${smallest} questions to include one.`;
  }
  return ` Note: ${excluded} case study/scenario set${excluded > 1 ? "s are" : " is"} too large for ${n} questions and will be skipped (they are always kept whole).`;
}

function renderRecentSessions() {
  const host = $("#recentSessions");
  const sessions = (state.history || []).slice(0, 10);
  if (!sessions.length) { host.innerHTML = `<p class="muted">No sessions yet.</p>`; return; }
  host.innerHTML = sessions.map(s => {
    const pct = Math.round(s.percentage);
    const color = pct >= 80 ? "#3fb950" : pct >= 60 ? "#d29922" : "#f85149";
    const d = new Date(s.finishedAt);
    const dur = (s.finishedAt && s.startedAt && s.finishedAt > s.startedAt)
      ? `⏱ ${formatDuration(s.finishedAt - s.startedAt)}` : "";
    return `<div class="recent-item">
      <span class="pct" style="color:${color}">${pct}%</span>
      <span>${s.earned}/${s.possible} pts · ${s.total} questions${dur ? ` · ${dur}` : ""}</span>
      <span class="spacer" style="flex:1"></span>
      <span class="muted">${d.toLocaleString()}</span>
    </div>`;
  }).join("");
}

function renderExamList() {
  const host = $("#examList");
  if (!state.exams.length) { host.innerHTML = `<p class="muted">No exams yet.</p>`; return; }
  host.innerHTML = state.exams.map(e => {
    const c = e.counts;
    const tags = Object.entries(c).filter(([, v]) => v > 0)
      .map(([k, v]) => `<span class="tag">${k}: ${v}</span>`).join("");
    return `<div class="exam-item">
      <div>
        <div class="ename">${escapeHtml(e.name)}</div>
        <div class="tags">${tags}</div>
      </div>
      <div class="spacer"></div>
      <button class="danger" data-del="${e.id}">Delete</button>
    </div>`;
  }).join("");
  $$("[data-del]", host).forEach(b => b.onclick = async () => {
    if (!confirm(`Delete exam “${b.dataset.del}” and its history?`)) return;
    await api(`/api/exams/${b.dataset.del}`, { method: "DELETE" });
    renderPractice();
  });
}

/* ===================== Unit model ===================== */
function buildUnits(questions) {
  const units = [];
  const emitted = new Set();
  const bySeries = new Map();
  for (const q of questions) {
    if (q.seriesId) {
      if (!bySeries.has(q.seriesId)) bySeries.set(q.seriesId, []);
      bySeries.get(q.seriesId).push(q);
    }
  }
  for (const q of questions) {
    if (q.seriesId) {
      if (emitted.has(q.seriesId)) continue;
      emitted.add(q.seriesId);
      const members = bySeries.get(q.seriesId).slice()
        .sort((a, b) => (a.seriesOrder || 0) - (b.seriesOrder || 0));
      units.push({
        kind: "series",
        seriesId: q.seriesId,
        title: q.seriesTitle || "Scenario series",
        note: q.seriesNote || "",
        scenario: q.seriesScenario || "",
        members,
      });
    } else {
      // Grouped questions (case studies / same-scenario series) stay one
      // question per page, but carry their group so they can be kept together.
      units.push({
        kind: "single",
        members: [q],
        groupId: q.groupId || null,
        groupKind: q.groupKind || null,
        groupTitle: q.groupTitle || "",
        groupScenario: q.groupScenario || "",
        groupNote: q.groupNote || "",
        groupOrder: q.groupOrder || 0,
        groupSize: q.groupSize || 0,
      });
    }
  }
  return units;
}

/* Group lookup: groupId -> its units, in exam order. */
function groupIndex(allUnits) {
  const byGroup = new Map();
  for (const u of allUnits) {
    if (!u.groupId) continue;
    if (!byGroup.has(u.groupId)) byGroup.set(u.groupId, []);
    byGroup.get(u.groupId).push(u);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => (a.groupOrder || 0) - (b.groupOrder || 0));
  }
  return byGroup;
}

function unitHasMember(unit, idSet) { return unit.members.some(m => idSet.has(m.id)); }

/* Candidate units in preference order (no truncation — packUnits enforces the
   question budget, since one unit may carry several questions). */
function orderCandidates(units, analysis, optWrong, optUnseen) {
  if (!optWrong && !optUnseen) return shuffle(units);

  const incorrect = new Set(analysis.incorrect || []);
  const seen = new Set(analysis.seen || []);
  const isUnseenUnit = u => u.members.some(m => !seen.has(m.id));

  const tier1 = optWrong ? units.filter(u => unitHasMember(u, incorrect)) : [];
  const t1set = new Set(tier1);
  const tier2 = optUnseen ? units.filter(u => !t1set.has(u) && isUnseenUnit(u)) : [];
  const t2set = new Set(tier2);
  const tier3 = units.filter(u => !t1set.has(u) && !t2set.has(u));

  return [...shuffle(tier1), ...shuffle(tier2), ...shuffle(tier3)];
}

/* Fill up to exactly n questions. A case study / scenario series is taken whole
   or not at all, so a group that no longer fits in the remaining budget is
   skipped and the budget is spent on other questions instead. */
function packUnits(candidates, n, allUnits) {
  const byGroup = groupIndex(allUnits);
  const out = [];
  const used = new Set();
  const usedGroups = new Set();
  let count = 0;
  const skippedGroups = new Set();

  for (const u of candidates) {
    if (count >= n) break;
    if (used.has(u)) continue;

    if (u.groupId && byGroup.has(u.groupId)) {
      if (usedGroups.has(u.groupId)) continue;
      const sibs = byGroup.get(u.groupId);
      if (count + sibs.length > n) { skippedGroups.add(u.groupId); continue; }
      usedGroups.add(u.groupId);
      for (const s of sibs) { used.add(s); out.push(s); }
      count += sibs.length;
    } else {
      if (count + u.members.length > n) continue;
      used.add(u); out.push(u); count += u.members.length;
    }
  }
  out._skippedGroups = skippedGroups.size;
  return out;
}

/* Give one multi-solution series a chance to appear, by moving it to the front
   of the candidate list. It is still subject to the question budget. */
function preferOneSeries(candidates) {
  const seriesIdx = candidates.findIndex(u => u.kind === "series");
  if (seriesIdx <= 0) return candidates;
  const out = candidates.slice();
  const [pick] = out.splice(seriesIdx, 1);
  out.unshift(pick);
  return out;
}

function groupBanner(unit) {
  const isCase = unit.groupKind === "case-study";
  const label = isCase ? "case study" : "same scenario";
  const pos = unit.groupSize
    ? `Question ${unit.groupOrder} of ${unit.groupSize}`
    : "";
  // Open on the first question of the group, collapsed afterwards, so the long
  // scenario does not have to be re-read for every question.
  const open = unit.groupOrder <= 1 ? " open" : "";
  const scenario = unit.groupScenario
    ? `<details class="group-scenario"${open}>
         <summary>📋 ${isCase ? "Case study scenario" : "Shared scenario"} — click to ${unit.groupOrder <= 1 ? "hide" : "show"}</summary>
         <div class="group-scenario-body">${escapeHtml(unit.groupScenario)}</div>
       </details>`
    : "";
  return `<div class="group-banner ${isCase ? "is-case" : "is-series"}">
      <div class="group-head">
        <span class="group-badge">${label}</span>
        <span class="group-title">${escapeHtml(unit.groupTitle || "")}</span>
        ${pos ? `<span class="group-pos">${pos}</span>` : ""}
      </div>
      ${unit.groupNote ? `<div class="group-note">${escapeHtml(unit.groupNote)}</div>` : ""}
      ${scenario}
    </div>`;
}

/* ===================== Start practice ===================== */
function startPractice() {
  if (!state.exam) return;
  const n = Math.max(1, Math.min(
    parseInt($("#numQuestions").value, 10) || 20, state.exam.questions.length));
  const optWrong = $("#optWrong").checked;
  const optUnseen = $("#optUnseen").checked;
  const mode = $("#optExam").checked ? "exam" : "normal";

  const units = buildUnits(state.exam.questions);
  let candidates = orderCandidates(units, state.analysis, optWrong, optUnseen);
  candidates = preferOneSeries(candidates);
  // Fills to exactly n questions; case studies / scenario series are kept whole
  // and consecutive, and are skipped when they no longer fit the budget.
  const picks = packUnits(candidates, n, units);

  // flatten
  const members = [];
  for (const u of picks) {
    u._range = [members.length, 0];
    for (const m of u.members) members.push(m);
    u._range[1] = members.length;
  }

  state.session = {
    examId: state.exam.id,
    units: picks,
    members,
    idx: 0,
    mode,
    answers: {},        // flatIdx -> {captured, score}
    gradeSource: {},    // flatIdx -> 'reviewer'|'community'
    startedAt: Date.now(),
    saved: false,
  };
  // default grade source
  members.forEach((m, i) => {
    state.session.gradeSource[i] = (m.review && m.review.verdict === "disagree") ? "reviewer" : "community";
  });
  renderQuiz();
  startQuizTimer();
}

/* ===================== Effective-correct helpers ===================== */
function gradeSrc(idx) { return state.session.gradeSource[idx] || "community"; }
function usesReviewer(q, idx) {
  return q.review && q.review.verdict === "disagree" && gradeSrc(idx) === "reviewer";
}
function effSingle(q, idx) {
  if (usesReviewer(q, idx)) return q.review.suggested;
  const c = (q.choices || []).find(x => x.correct);
  return c ? c.key : null;
}
function effMulti(q, idx) {
  if (usesReviewer(q, idx)) return q.review.suggested.slice();
  return (q.choices || []).filter(x => x.correct).map(x => x.key);
}
function effDropdown(q, idx) {
  const blanks = q.blanks || [];
  const idxArr = usesReviewer(q, idx) ? q.review.suggested.slice() : blanks.map(b => b.correctIndex);
  // return the correct *text* per blank (drag-and-drop is graded by value, not index)
  return blanks.map((b, j) => ((b.options || [])[idxArr[j]]) ?? "");
}
function effYesno(q, idx) {
  if (usesReviewer(q, idx)) return q.review.suggested.slice();
  return (q.statements || []).map(s => s.correct);
}

/* ===================== Scoring ===================== */
function scoreQuestion(q, captured, idx) {
  if (q.type === "single") {
    const correct = effSingle(q, idx);
    const earned = captured === correct ? 1 : 0;
    return { possible: 1, earned, correct: earned === 1 };
  }
  if (q.type === "multi") {
    const correct = new Set(effMulti(q, idx));
    const possible = correct.size;
    let earned = 0;
    for (const k of (captured || [])) earned += correct.has(k) ? 1 : -1;
    earned = Math.max(0, earned);
    return { possible, earned, correct: earned === possible };
  }
  if (q.type === "dropdown") {
    const correct = effDropdown(q, idx);
    let earned = 0;
    correct.forEach((ci, i) => { if ((captured || [])[i] === ci) earned++; });
    return { possible: correct.length, earned, correct: earned === correct.length };
  }
  if (q.type === "yesno") {
    const correct = effYesno(q, idx);
    let earned = 0;
    correct.forEach((c, i) => { if ((captured || [])[i] === c) earned++; });
    return { possible: correct.length, earned, correct: earned === correct.length };
  }
  // image (self-graded): captured is true/false
  return { possible: 1, earned: captured ? 1 : 0, correct: !!captured };
}

/* ===================== Stem extras & explanation ===================== */
function renderTable(t) {
  const headers = t.headers && t.headers.length
    ? `<tr>${t.headers.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr>` : "";
  const rows = (t.rows || []).map(r =>
    `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("");
  const cap = t.caption ? `<caption>${escapeHtml(t.caption)}</caption>` : "";
  return `<table class="stem-table">${cap}${headers}${rows}</table>`;
}
function stemExtras(q) {
  let html = "";
  if (q.table) {
    const tables = Array.isArray(q.table) ? q.table : [q.table];
    html += tables.map(renderTable).join("");
  }
  for (const img of (q.exhibitImages || [])) {
    html += `<img class="exhibit" src="/images/${encodeURIComponent(img)}" alt="exhibit">`;
  }
  return html;
}
function explanationBlock(q) {
  let html = "";
  if (q.deepDive) {
    html += `<div class="deep-dive"><h4>💡 Why — in plain terms</h4><div>${linkify(q.deepDive)}</div></div>`;
  }
  if (q.explanation) html += `<div class="explanation">${linkify(q.explanation)}</div>`;
  if (q.reference) html += `<div class="reference">Reference: ${linkify(q.reference)}</div>`;
  return html;
}
function sourceImagesBlock(q) {
  const imgs = (q.sourceImages || []).filter(f => !/_a_p\d+/.test(f));
  if (!imgs.length) return "";
  const body = imgs.map(f => `<img class="q-image" src="/images/${encodeURIComponent(f)}" alt="original question">`).join("");
  return `<details class="collapsible"><summary>Show original question (as in the exam PDF)</summary>${body}</details>`;
}

/* ===================== Drag & drop (dropdown-type) ===================== */
function dndHtml(q) {
  const blanks = q.blanks || [];
  const seen = new Set();
  const bank = [];
  blanks.forEach(b => (b.options || []).forEach(o => { if (!seen.has(o)) { seen.add(o); bank.push(o); } }));
  const chips = bank.map(o =>
    `<div class="dnd-chip" draggable="true" data-val="${escapeHtml(o)}">${escapeHtml(o)}</div>`).join("");
  const targets = blanks.map((b, j) =>
    `<div class="dnd-target-row" data-blank="${j}">
       <span class="dnd-label">${escapeHtml(b.statement || ("Box " + (j + 1)))}</span>
       <div class="dnd-slot" data-blank="${j}" data-val=""><span class="dnd-ph">Drop a value…</span></div>
       <button type="button" class="dnd-clear" data-blank="${j}" title="Clear this box">✕</button>
       <span class="dnd-fb"></span>
     </div>`).join("");
  return `<div class="dnd">
    <div class="dnd-bank">
      <div class="dnd-col-title">Values</div>
      <div class="dnd-chips">${chips}</div>
      <div class="dnd-hint">Drag a value onto a box — or tap a value, then tap a box. A value can be used once, more than once, or not at all.</div>
    </div>
    <div class="dnd-answer">
      <div class="dnd-col-title">Answer area</div>
      ${targets}
    </div>
  </div>`;
}

function wireDnd(root, q, idx) {
  const dnd = root.querySelector(".dnd");
  if (!dnd) return;
  const locked = () => dnd.classList.contains("locked");
  let selectedChip = null;
  const setSlot = (slot, val) => {
    slot.dataset.val = val || "";
    slot.innerHTML = val ? `<span class="dnd-val">${escapeHtml(val)}</span>` : `<span class="dnd-ph">Drop a value…</span>`;
    slot.classList.toggle("filled", !!val);
  };
  dnd.querySelectorAll(".dnd-chip").forEach(chip => {
    chip.addEventListener("dragstart", e => {
      if (locked()) { e.preventDefault(); return; }
      e.dataTransfer.setData("text/plain", chip.dataset.val);
      e.dataTransfer.effectAllowed = "copy";
    });
    chip.addEventListener("click", () => {
      if (locked()) return;
      if (selectedChip === chip) { chip.classList.remove("selected"); selectedChip = null; return; }
      if (selectedChip) selectedChip.classList.remove("selected");
      selectedChip = chip; chip.classList.add("selected");
    });
  });
  dnd.querySelectorAll(".dnd-slot").forEach(slot => {
    slot.addEventListener("dragover", e => { if (!locked()) { e.preventDefault(); slot.classList.add("over"); } });
    slot.addEventListener("dragleave", () => slot.classList.remove("over"));
    slot.addEventListener("drop", e => {
      e.preventDefault(); slot.classList.remove("over");
      if (locked()) return;
      const val = e.dataTransfer.getData("text/plain");
      if (val) setSlot(slot, val);
    });
    slot.addEventListener("click", () => {
      if (locked() || !selectedChip) return;
      setSlot(slot, selectedChip.dataset.val);
      selectedChip.classList.remove("selected"); selectedChip = null;
    });
  });
  dnd.querySelectorAll(".dnd-clear").forEach(btn => {
    btn.addEventListener("click", () => {
      if (locked()) return;
      const slot = dnd.querySelector(`.dnd-slot[data-blank="${btn.dataset.blank}"]`);
      if (slot) setSlot(slot, "");
    });
  });
}

/* ===================== Mount a single question ===================== */
function mountQuestion(host, q, idx) {
  const div = document.createElement("div");
  div.className = "member";
  div.dataset.midx = idx;

  let inner = `<div class="type-badge">${q.type}${q.subtype ? " · " + q.subtype : ""}</div>`;
  // Grouped questions render only their own text; the shared case-study /
  // scenario body is shown once in the group banner above.
  inner += `<div class="stem">${escapeHtml(q.groupStem || q.stem || "")}</div>`;
  inner += stemExtras(q);
  inner += `<div class="inputs"></div>`;
  div.innerHTML = inner;
  host.appendChild(div);

  const inputs = $(".inputs", div);
  if (q.type === "single" || q.type === "multi") {
    const isMulti = q.type === "multi";
    inputs.innerHTML = `<div class="choices">` + (q.choices || []).map(c =>
      `<label class="choice" data-key="${c.key}">
        <input type="${isMulti ? "checkbox" : "radio"}" name="q${idx}" value="${c.key}">
        <span><span class="ckey">${c.key}.</span> ${escapeHtml(c.text)}</span>
      </label>`).join("") + `</div>`;
  } else if (q.type === "dropdown") {
    inputs.innerHTML = dndHtml(q);
    wireDnd(inputs, q, idx);
  } else if (q.type === "yesno") {
    inputs.innerHTML = (q.statements || []).map((s, j) =>
      `<div class="yn-row" data-stmt="${j}">
        <span class="yn-text">${escapeHtml(s.text || "")}</span>
        <span class="yn-opts">
          <label><input type="radio" name="q${idx}_s${j}" value="Yes"> Yes</label>
          <label><input type="radio" name="q${idx}_s${j}" value="No"> No</label>
        </span>
      </div>`).join("");
  } else if (q.type === "image") {
    let body = "";
    for (const f of (q.questionImages || [])) body += `<img class="q-image" src="/images/${encodeURIComponent(f)}" alt="question">`;
    body += `<p class="muted">Self-graded question — reveal to see the answer, then mark yourself.</p>`;
    inputs.innerHTML = body;
  }

  // source image toggle
  const srcBlock = sourceImagesBlock(q);
  if (srcBlock) div.insertAdjacentHTML("beforeend", srcBlock);

  // "view in source PDF" button — embeds the exam PDF at this question's page inline
  if (q.pdfFile && q.pdfPage) {
    const url = `/pdfs/${encodeURIComponent(q.pdfFile)}#page=${q.pdfPage}`;
    div.insertAdjacentHTML("beforeend",
      `<div class="pdf-link">
        <button type="button" class="pdf-btn" data-pdf-toggle>📄 View this question in the source PDF (page ${q.pdfPage})</button>
        <div class="pdf-embed" hidden>
          <div class="pdf-embed-bar">
            <span class="muted">Source PDF — page ${q.pdfPage}</span>
            <a class="pdf-open-tab" href="${url}" target="_blank" rel="noopener">Open in new tab ↗</a>
          </div>
          <iframe class="pdf-frame" title="Source PDF page ${q.pdfPage}" loading="lazy" data-src="${url}"></iframe>
        </div>
      </div>`);
    const pdfWrap = div.querySelector(".pdf-link");
    const toggleBtn = pdfWrap.querySelector("[data-pdf-toggle]");
    const embed = pdfWrap.querySelector(".pdf-embed");
    const frame = pdfWrap.querySelector(".pdf-frame");
    toggleBtn.onclick = () => {
      const show = embed.hidden;
      if (show && !frame.src) frame.src = frame.dataset.src; // lazy-load on first open
      embed.hidden = !show;
      toggleBtn.classList.toggle("active", show);
      toggleBtn.textContent = show
        ? `📄 Hide the source PDF (page ${q.pdfPage})`
        : `📄 View this question in the source PDF (page ${q.pdfPage})`;
    };
  }

  // grade chooser for disagree questions
  if (q.review && q.review.verdict === "disagree") {
    const gc = document.createElement("div");
    gc.className = "grade-chooser";
    gc.innerHTML = `Reviewer disagrees with the published answer. Grade against:
      <label><input type="radio" name="gc${idx}" value="reviewer" ${gradeSrc(idx) === "reviewer" ? "checked" : ""}> Reviewer’s suggestion (${escapeHtml(q.review.suggestedLabel || "suggested")})</label>
      <label><input type="radio" name="gc${idx}" value="community" ${gradeSrc(idx) === "community" ? "checked" : ""}> Community key (${escapeHtml(q.review.givenLabel || "given")})</label>`;
    div.appendChild(gc);
    $$(`input[name="gc${idx}"]`, gc).forEach(r => r.onchange = () => {
      state.session.gradeSource[idx] = r.value;
    });
  }

  // feedback slot
  div.insertAdjacentHTML("beforeend", `<div class="member-feedback"></div>`);
  return div;
}

/* ===================== Capture answers ===================== */
function memberEl(idx) { return document.querySelector(`.member[data-midx="${idx}"]`); }

function captureAnswer(q, idx) {
  const div = memberEl(idx);
  if (!div) return null;
  if (q.type === "single") {
    const r = $(`input[name="q${idx}"]:checked`, div);
    return r ? r.value : null;
  }
  if (q.type === "multi") {
    return $$(`input[name="q${idx}"]:checked`, div).map(x => x.value);
  }
  if (q.type === "dropdown") {
    return (q.blanks || []).map((_, j) => {
      const slot = $(`.dnd-slot[data-blank="${j}"]`, div);
      const v = slot ? (slot.dataset.val || "") : "";
      return v || null;
    });
  }
  if (q.type === "yesno") {
    return (q.statements || []).map((_, j) => {
      const r = $(`input[name="q${idx}_s${j}"]:checked`, div);
      return r ? r.value : null;
    });
  }
  return null; // image handled via self-mark
}

/* ===================== Reveal answers ===================== */
function revealAnswer(q, idx, captured) {
  const div = memberEl(idx);
  if (!div) return;

  if (q.type === "single" || q.type === "multi") {
    const correct = new Set(q.type === "single" ? [effSingle(q, idx)] : effMulti(q, idx));
    const chosen = new Set(q.type === "single" ? (captured ? [captured] : []) : (captured || []));
    $$(".choice", div).forEach(ch => {
      const k = ch.dataset.key;
      ch.classList.add("locked");
      $("input", ch).disabled = true;
      if (correct.has(k)) ch.classList.add("correct");
      else if (chosen.has(k)) ch.classList.add("wrong");
    });
  } else if (q.type === "dropdown") {
    const correct = effDropdown(q, idx);
    const dnd = $(".dnd", div);
    if (dnd) dnd.classList.add("locked");
    $$(".dnd-chip", div).forEach(c => c.setAttribute("draggable", "false"));
    $$(".dnd-target-row", div).forEach(row => {
      const j = +row.dataset.blank;
      const ok = (captured || [])[j] === correct[j];
      row.classList.add(ok ? "correct" : "wrong");
      if (!ok) $(".dnd-fb", row).textContent = "✓ " + (correct[j] || "");
    });
  } else if (q.type === "yesno") {
    const correct = effYesno(q, idx);
    $$(".yn-row", div).forEach(row => {
      const j = +row.dataset.stmt;
      $$("input", row).forEach(i => i.disabled = true);
      const ok = (captured || [])[j] === correct[j];
      row.classList.add(ok ? "correct" : "wrong");
    });
  } else if (q.type === "image") {
    const inputs = $(".inputs", div);
    for (const f of (q.answerImages || [])) {
      inputs.insertAdjacentHTML("beforeend", `<img class="a-image" src="/images/${encodeURIComponent(f)}" alt="answer">`);
    }
  }

  // review notice
  if (q.review) {
    const note = q.review.verdict === "disagree"
      ? `⚠ Reviewer disagrees with the published key (confidence: ${escapeHtml(q.review.confidence || "n/a")}). Graded against the ${gradeSrc(idx) === "reviewer" ? "reviewer’s suggestion" : "community key"}.`
      : `⚠ Reviewer flagged this question as ambiguous/uncertain (confidence: ${escapeHtml(q.review.confidence || "n/a")}). Community key kept.`;
    div.querySelector(".member-feedback").insertAdjacentHTML("beforeend", `<div class="review-notice">${note}</div>`);
  }
}

function selfMarkBlock(idx, onMark) {
  const div = memberEl(idx);
  const fb = div.querySelector(".member-feedback");
  const box = document.createElement("div");
  box.className = "self-mark";
  box.innerHTML = `<button class="secondary" data-m="1">I was correct ✓</button>
                   <button class="ghost" data-m="0">I was wrong ✗</button>`;
  fb.appendChild(box);
  $$("button", box).forEach(b => b.onclick = () => {
    const ok = b.dataset.m === "1";
    box.remove();
    onMark(ok);
  });
}

/* ===================== Quiz rendering ===================== */
/* ===================== Practice-test timer ===================== */
function formatDuration(ms) {
  if (!ms || ms < 0) ms = 0;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  const pad = n => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function updateQuizTimer() {
  const s = state.session;
  if (!s) return;
  const el = document.getElementById("quizTimer");
  if (!el) return;
  const end = s.finishedAt || Date.now();
  el.textContent = `⏱ ${formatDuration(end - s.startedAt)}`;
}

function startQuizTimer() {
  stopQuizTimer();
  updateQuizTimer();
  state.timerInterval = setInterval(updateQuizTimer, 1000);
}

function stopQuizTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
}

function renderQuiz() {
  view().innerHTML = "";
  view().appendChild(tpl("tpl-quiz"));
  const s = state.session;
  const totalUnits = s.units.length;

  $("#progressBar").style.width = `${s.idx / totalUnits * 100}%`;
  $("#qCounter").textContent = `Question ${s.idx + 1} of ${totalUnits}`;
  updateQuizTimer();
  const badge = $("#modeBadge");
  if (s.mode === "exam") badge.textContent = "Exam mode";
  else badge.classList.add("hidden");

  const unit = s.units[s.idx];
  const host = $("#questionHost");
  host.innerHTML = "";

  if (unit.kind === "series") {
    host.insertAdjacentHTML("beforeend",
      `<div class="type-badge">series · ${escapeHtml(unit.title)}</div>`);
    if (unit.note) host.insertAdjacentHTML("beforeend", `<div class="series-note">${escapeHtml(unit.note)}</div>`);
    if (unit.scenario) host.insertAdjacentHTML("beforeend", `<div class="series-scenario">${escapeHtml(unit.scenario)}</div>`);
    host.insertAdjacentHTML("beforeend", `<div class="series-hint">Each solution below is graded independently.</div>`);
    unit.members.forEach((m, k) => {
      const sub = document.createElement("div");
      sub.className = "sub-card";
      sub.innerHTML = `<h4>Solution ${k + 1} of ${unit.members.length}</h4>`;
      if (m.seriesSolution) sub.insertAdjacentHTML("beforeend", `<div class="series-scenario">${escapeHtml(m.seriesSolution)}</div>`);
      host.appendChild(sub);
      mountQuestion(sub, m, unit._range[0] + k);
    });
  } else {
    if (unit.groupId) host.insertAdjacentHTML("beforeend", groupBanner(unit));
    mountQuestion(host, unit.members[0], unit._range[0]);
  }

  // nav wiring
  const isLast = s.idx === totalUnits - 1;
  const autoOnly = unit.members.every(m => m.type !== "image");
  const revealBtn = $("#revealBtn");
  const nextBtn = $("#nextBtn");
  nextBtn.textContent = isLast ? "Finish ▸" : "Next question ›";

  if (s.mode === "exam" && autoOnly) {
    revealBtn.textContent = isLast ? "Submit & finish" : "Submit answer(s)";
    revealBtn.onclick = () => { submitUnit(unit, false); goNext(); };
  } else {
    revealBtn.textContent = "Show answer(s)";
    revealBtn.onclick = () => revealUnit(unit);
  }
  nextBtn.onclick = goNext;
  $("#quitBtn").onclick = () => { if (confirm("Quit and see your score?")) finishSession(); };
}

// exam-mode silent submit
function submitUnit(unit, reveal) {
  for (let i = unit._range[0]; i < unit._range[1]; i++) {
    const q = state.session.members[i];
    if (q.type === "image") { // cannot auto-grade; default to incorrect if not marked
      if (!state.session.answers[i]) state.session.answers[i] = { captured: false, score: scoreQuestion(q, false, i) };
      continue;
    }
    const captured = captureAnswer(q, i);
    state.session.answers[i] = { captured, score: scoreQuestion(q, captured, i) };
  }
}

// normal reveal (also used when a unit contains a self-graded image)
function revealUnit(unit) {
  const s = state.session;
  let unitEarned = 0, unitPossible = 0;
  let pendingImages = 0;

  for (let i = unit._range[0]; i < unit._range[1]; i++) {
    const q = s.members[i];
    if (q.type === "image") {
      revealAnswer(q, i, null);
      pendingImages++;
      selfMarkBlock(i, ok => {
        s.answers[i] = { captured: ok, score: scoreQuestion(q, ok, i) };
        showMemberScore(i, q);
        pendingImages--;
        if (pendingImages === 0) afterReveal(unit);
      });
      continue;
    }
    const captured = captureAnswer(q, i);
    const score = scoreQuestion(q, captured, i);
    s.answers[i] = { captured, score };
    unitEarned += score.earned; unitPossible += score.possible;
    revealAnswer(q, i, captured);
    showMemberScore(i, q);
  }

  $("#revealBtn").disabled = true;
  if (pendingImages === 0) afterReveal(unit);
}

function showMemberScore(i, q) {
  const div = memberEl(i);
  const fb = div.querySelector(".member-feedback");
  const sc = state.session.answers[i].score;
  const ok = sc.correct;
  fb.insertAdjacentHTML("afterbegin",
    `<div class="score-line ${ok ? "ok" : "no"}">You scored ${sc.earned} / ${sc.possible}</div>`);
  fb.insertAdjacentHTML("beforeend", explanationBlock(q));
}

function afterReveal(unit) {
  const s = state.session;
  const isLast = s.idx === s.units.length - 1;
  if (unit.kind === "single") {
    // relocate Next above the explanation
    const i = unit._range[0];
    const div = memberEl(i);
    const fb = div.querySelector(".member-feedback");
    const inlineNext = document.createElement("button");
    inlineNext.className = "primary inline-next";
    inlineNext.textContent = isLast ? "Finish ▸" : "Next question ›";
    inlineNext.onclick = goNext;
    // insert right after score line, before explanation/deep-dive
    const scoreLine = fb.querySelector(".score-line");
    const anchor = fb.querySelector(".deep-dive, .explanation, .reference");
    if (anchor) fb.insertBefore(inlineNext, anchor);
    else fb.appendChild(inlineNext);
    $("#nextBtn").style.display = "none";
  } else {
    // series: combined score + bottom Next
    let e = 0, p = 0;
    for (let i = unit._range[0]; i < unit._range[1]; i++) {
      e += s.answers[i].score.earned; p += s.answers[i].score.possible;
    }
    $("#questionHost").insertAdjacentHTML("beforeend",
      `<div class="score-line ${e === p ? "ok" : "no"}">Series score: ${e} / ${p}</div>`);
    $("#nextBtn").style.display = "";
  }
}

function goNext() {
  const s = state.session;
  if (s.idx < s.units.length - 1) { s.idx++; renderQuiz(); }
  else finishSession();
}

/* ===================== Finish / results ===================== */
async function finishSession() {
  const s = state.session;
  stopQuizTimer();
  s.finishedAt = Date.now();
  // ensure every member has a score (unanswered → capture now)
  for (let i = 0; i < s.members.length; i++) {
    if (!s.answers[i]) {
      const q = s.members[i];
      const captured = q.type === "image" ? false : captureAnswer(q, i);
      s.answers[i] = { captured, score: scoreQuestion(q, captured, i) };
    }
  }
  renderResults();
}

async function saveSessionOnce(payload) {
  if (state.session.saved) return;
  state.session.saved = true;
  try { await api(`/api/exams/${state.session.examId}/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  }); } catch { /* ignore save errors */ }
}

function renderResults() {
  const s = state.session;
  stopQuizTimer();
  s.finishedAt = s.finishedAt || Date.now();
  view().innerHTML = "";
  view().appendChild(tpl("tpl-results"));

  let earned = 0, possible = 0;
  const qRecords = [];
  s.members.forEach((q, i) => {
    const sc = s.answers[i].score;
    earned += sc.earned; possible += sc.possible;
    qRecords.push({ id: q.id, type: q.type, earned: sc.earned, possible: sc.possible, correct: sc.correct });
  });
  const pct = possible ? Math.round(earned / possible * 100) : 0;
  const unitCount = s.units.length;
  const elapsedMs = s.finishedAt - s.startedAt;

  saveSessionOnce({
    startedAt: s.startedAt, finishedAt: s.finishedAt,
    earned, possible, percentage: pct, unitCount, questions: qRecords,
  });

  const cls = pct >= 80 ? "ok" : "no";
  $("#resultSummary").innerHTML =
    `<div class="big-score ${cls}">${pct}%</div>
     <div class="detail">
       <div><b>${earned} / ${possible}</b> points</div>
       <div>across ${unitCount} question${unitCount > 1 ? "s" : ""}</div>
       <div class="time-spent">⏱ Time spent: <b>${formatDuration(elapsedMs)}</b></div>
       <div>${pct >= 80 ? "🎯 Strong pass range." : pct >= 60 ? "👍 Getting there." : "📚 Needs more review."}</div>
     </div>`;

  // per-unit breakdown
  const bd = $("#resultBreakdown");
  bd.innerHTML = s.units.map((unit, ui) => {
    let e = 0, p = 0;
    for (let i = unit._range[0]; i < unit._range[1]; i++) { e += s.answers[i].score.earned; p += s.answers[i].score.possible; }
    const cls2 = e === p ? "full" : e === 0 ? "zero" : "partial";
    const badge = e === p ? "✓" : `${e}/${p}`;
    const snippet = (q) => {
      const t = q.groupStem || q.stem || "";
      return escapeHtml(t.slice(0, 100)) + (t.length > 100 ? "…" : "");
    };
    const m0 = unit.members[0];
    const title = unit.kind === "series"
      ? `Series: ${escapeHtml(unit.title)} (${unit.members.length} solutions)`
      : (unit.groupId
        ? `<span class="bd-group">${escapeHtml(unit.groupTitle || "")} · Q${unit.groupOrder}/${unit.groupSize}</span> ${snippet(m0)}`
        : snippet(m0));
    let subRows = "";
    if (unit.kind === "series") {
      subRows = `<div class="sub-rows">` + unit.members.map((m, k) => {
        const msc = s.answers[unit._range[0] + k].score;
        return `<div>Solution ${k + 1}: ${msc.earned}/${msc.possible}</div>`;
      }).join("") + `</div>`;
    }
    return `<div class="bd-item">
      <div class="bd-head"><span class="bd-badge ${cls2}">${badge}</span>
        <span class="bd-title">${title}</span></div>${subRows}</div>`;
  }).join("");

  // review incorrect (auto-graded only)
  const wrong = [];
  s.members.forEach((q, i) => {
    if (q.type === "image") return;
    if (!s.answers[i].score.correct) wrong.push({ q, i });
  });
  const rc = $("#reviewCard");
  if (!wrong.length) { rc.style.display = "none"; }
  else {
    $("#resultReview").innerHTML = wrong.map(({ q, i }) => {
      const host = document.createElement("div");
      return renderReviewQuestion(q, i);
    }).join("");
  }

  $("#backToPractice").onclick = () => go("practice");
}

function renderReviewQuestion(q, idx) {
  const captured = state.session.answers[idx].captured;
  const groupTag = q.groupId
    ? `<div class="review-group">${escapeHtml(q.groupTitle || "")} · Question ${q.groupOrder} of ${q.groupSize}</div>`
    : "";
  let body = groupTag
    + `<div class="stem">${escapeHtml(q.groupStem || q.stem || "")}</div>` + stemExtras(q);

  if (q.type === "single" || q.type === "multi") {
    const correct = new Set(q.type === "single" ? [effSingle(q, idx)] : effMulti(q, idx));
    const chosen = new Set(q.type === "single" ? (captured ? [captured] : []) : (captured || []));
    body += `<div class="choices">` + (q.choices || []).map(c => {
      let cls = "choice locked";
      if (correct.has(c.key)) cls += " correct";
      else if (chosen.has(c.key)) cls += " wrong";
      return `<div class="${cls}"><span><span class="ckey">${c.key}.</span> ${escapeHtml(c.text)}</span></div>`;
    }).join("") + `</div>`;
  } else if (q.type === "dropdown") {
    const correct = effDropdown(q, idx);
    body += (q.blanks || []).map((b, j) => {
      const yours = (captured || [])[j] || "—";
      const ok = yours === correct[j];
      return `<div class="blank-row ${ok ? "correct" : "wrong"}">
        <span class="stmt">${escapeHtml(b.statement || "")}</span>
        <span>Your answer: <b>${escapeHtml(yours)}</b>${ok ? "" : ` · Correct: <b>${escapeHtml(correct[j] || "")}</b>`}</span>
      </div>`;
    }).join("");
  } else if (q.type === "yesno") {
    const correct = effYesno(q, idx);
    body += (q.statements || []).map((st, j) => {
      const yours = (captured || [])[j] || "—";
      const ok = yours === correct[j];
      return `<div class="yn-row ${ok ? "correct" : "wrong"}">
        <span class="yn-text">${escapeHtml(st.text || "")}</span>
        <span>You: <b>${escapeHtml(yours)}</b>${ok ? "" : ` · Correct: <b>${escapeHtml(correct[j])}</b>`}</span>
      </div>`;
    }).join("");
  }
  if (q.review) {
    body += `<div class="review-notice">Reviewer verdict: ${escapeHtml(q.review.verdict)} (${escapeHtml(q.review.confidence || "n/a")})</div>`;
  }
  body += sourceImagesBlock(q);
  body += explanationBlock(q);
  return `<div class="review-q">${body}</div>`;
}

/* ===================== Import page ===================== */
function renderImport() {
  view().innerHTML = "";
  view().appendChild(tpl("tpl-import"));
  $("#uploadBtn").onclick = doUpload;
}

async function doUpload() {
  const name = $("#examName").value.trim();
  const file = $("#pdfFile").files[0];
  const status = $("#importStatus");
  if (!file) { status.innerHTML = `<span style="color:var(--red)">Please choose a PDF file.</span>`; return; }
  if (!name) { status.innerHTML = `<span style="color:var(--red)">Please enter an exam name.</span>`; return; }

  const fd = new FormData();
  fd.append("name", name);
  fd.append("pdf", file);
  $("#uploadBtn").disabled = true;
  status.innerHTML = `<span class="spinner"></span> Uploading…`;

  let job;
  try { job = await api("/api/exams", { method: "POST", body: fd }); }
  catch (e) { status.innerHTML = `<span style="color:var(--red)">Upload failed: ${escapeHtml(e.message)}</span>`; $("#uploadBtn").disabled = false; return; }

  const poll = async () => {
    let st;
    try { st = await api(`/api/exams/import/${job.jobId}`); }
    catch { status.innerHTML = `<span style="color:var(--red)">Lost track of the import job.</span>`; $("#uploadBtn").disabled = false; return; }
    if (st.status === "running") {
      status.innerHTML = `<span class="spinner"></span> Parsing “${escapeHtml(st.name)}”… ${st.elapsed}s elapsed (OCR can take a few minutes).`;
      setTimeout(poll, 2000);
    } else if (st.status === "done") {
      const c = st.summary ? Object.entries(st.summary).filter(([k]) => k !== "id").map(([k, v]) => `${k}: ${v}`).join(" · ") : "";
      status.innerHTML = `<span style="color:var(--green)">✓ Imported “${escapeHtml(st.name)}”. ${escapeHtml(c)}</span>`;
      $("#uploadBtn").disabled = false;
    } else {
      status.innerHTML = `<span style="color:var(--red)">Import failed:</span><pre style="white-space:pre-wrap;color:var(--muted)">${escapeHtml(st.detail || "unknown error")}</pre>`;
      $("#uploadBtn").disabled = false;
    }
  };
  poll();
}

/* ===================== boot ===================== */
go("practice");
