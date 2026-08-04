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
  $("#selectionNote").textContent = note;
}

function renderRecentSessions() {
  const host = $("#recentSessions");
  const sessions = (state.history || []).slice(0, 10);
  if (!sessions.length) { host.innerHTML = `<p class="muted">No sessions yet.</p>`; return; }
  host.innerHTML = sessions.map(s => {
    const pct = Math.round(s.percentage);
    const color = pct >= 80 ? "#3fb950" : pct >= 60 ? "#d29922" : "#f85149";
    const d = new Date(s.finishedAt);
    return `<div class="recent-item">
      <span class="pct" style="color:${color}">${pct}%</span>
      <span>${s.earned}/${s.possible} pts · ${s.total} questions</span>
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
      units.push({ kind: "single", members: [q] });
    }
  }
  return units;
}

function unitHasMember(unit, idSet) { return unit.members.some(m => idSet.has(m.id)); }

function selectUnits(units, n, analysis, optWrong, optUnseen) {
  if (!optWrong && !optUnseen) return shuffle(units).slice(0, n);

  const incorrect = new Set(analysis.incorrect || []);
  const seen = new Set(analysis.seen || []);
  const isUnseenUnit = u => u.members.some(m => !seen.has(m.id));

  const tier1 = optWrong ? units.filter(u => unitHasMember(u, incorrect)) : [];
  const t1set = new Set(tier1);
  const tier2 = optUnseen ? units.filter(u => !t1set.has(u) && isUnseenUnit(u)) : [];
  const t2set = new Set(tier2);
  const tier3 = units.filter(u => !t1set.has(u) && !t2set.has(u));

  const ordered = [...shuffle(tier1), ...shuffle(tier2), ...shuffle(tier3)];
  const out = [];
  const seenUnit = new Set();
  for (const u of ordered) {
    if (seenUnit.has(u)) continue;
    seenUnit.add(u); out.push(u);
    if (out.length >= n) break;
  }
  return out;
}

function ensureOneSeries(picks, allUnits, n) {
  const allSeries = allUnits.filter(u => u.kind === "series");
  if (!allSeries.length) return picks;
  if (picks.some(u => u.kind === "series")) return picks;
  const pickSet = new Set(picks);
  const candidate = shuffle(allSeries).find(u => !pickSet.has(u)) || allSeries[0];
  if (picks.length < n) picks.push(candidate);
  else picks[picks.length - 1] = candidate;
  return picks;
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
  let picks = selectUnits(units, n, state.analysis, optWrong, optUnseen);
  picks = ensureOneSeries(picks, units, n);

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
  if (usesReviewer(q, idx)) return q.review.suggested.slice();
  return (q.blanks || []).map(b => b.correctIndex);
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

/* ===================== Mount a single question ===================== */
function mountQuestion(host, q, idx) {
  const div = document.createElement("div");
  div.className = "member";
  div.dataset.midx = idx;

  let inner = `<div class="type-badge">${q.type}${q.subtype ? " · " + q.subtype : ""}</div>`;
  inner += `<div class="stem">${escapeHtml(q.stem || "")}</div>`;
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
    inputs.innerHTML = (q.blanks || []).map((b, j) =>
      `<div class="blank-row" data-blank="${j}">
        <span class="stmt">${escapeHtml(b.statement || "")}</span>
        <select data-blank="${j}">
          <option value="-1">— choose —</option>
          ${(b.options || []).map((o, oi) => `<option value="${oi}">${escapeHtml(o)}</option>`).join("")}
        </select>
        <span class="blank-fb"></span>
      </div>`).join("");
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
      const s = $(`select[data-blank="${j}"]`, div);
      return s ? parseInt(s.value, 10) : -1;
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
    $$(".blank-row", div).forEach(row => {
      const j = +row.dataset.blank;
      const sel = $("select", row); sel.disabled = true;
      const ok = (captured || [])[j] === correct[j];
      row.classList.add(ok ? "correct" : "wrong");
      if (!ok) $(".blank-fb", row).textContent = "✓ " + (q.blanks[j].options[correct[j]] || "");
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
function renderQuiz() {
  view().innerHTML = "";
  view().appendChild(tpl("tpl-quiz"));
  const s = state.session;
  const totalUnits = s.units.length;

  $("#progressBar").style.width = `${s.idx / totalUnits * 100}%`;
  $("#qCounter").textContent = `Question ${s.idx + 1} of ${totalUnits}`;
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

  saveSessionOnce({
    startedAt: s.startedAt, finishedAt: Date.now(),
    earned, possible, percentage: pct, unitCount, questions: qRecords,
  });

  const cls = pct >= 80 ? "ok" : "no";
  $("#resultSummary").innerHTML =
    `<div class="big-score ${cls}">${pct}%</div>
     <div class="detail">
       <div><b>${earned} / ${possible}</b> points</div>
       <div>across ${unitCount} question${unitCount > 1 ? "s" : ""}</div>
       <div>${pct >= 80 ? "🎯 Strong pass range." : pct >= 60 ? "👍 Getting there." : "📚 Needs more review."}</div>
     </div>`;

  // per-unit breakdown
  const bd = $("#resultBreakdown");
  bd.innerHTML = s.units.map((unit, ui) => {
    let e = 0, p = 0;
    for (let i = unit._range[0]; i < unit._range[1]; i++) { e += s.answers[i].score.earned; p += s.answers[i].score.possible; }
    const cls2 = e === p ? "full" : e === 0 ? "zero" : "partial";
    const badge = e === p ? "✓" : `${e}/${p}`;
    const title = unit.kind === "series"
      ? `Series: ${escapeHtml(unit.title)} (${unit.members.length} solutions)`
      : escapeHtml((unit.members[0].stem || "").slice(0, 100)) + ((unit.members[0].stem || "").length > 100 ? "…" : "");
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
  let body = `<div class="stem">${escapeHtml(q.stem || "")}</div>` + stemExtras(q);

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
      const sel = (captured || [])[j];
      const ok = sel === correct[j];
      const yours = sel >= 0 ? b.options[sel] : "—";
      return `<div class="blank-row ${ok ? "correct" : "wrong"}">
        <span class="stmt">${escapeHtml(b.statement || "")}</span>
        <span>Your answer: <b>${escapeHtml(yours)}</b>${ok ? "" : ` · Correct: <b>${escapeHtml(b.options[correct[j]] || "")}</b>`}</span>
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
