"use strict";

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const ROOT = __dirname;
const DATA = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, "data");
const EXAMS_DIR = path.join(DATA, "exams");
const IMAGES_DIR = path.join(DATA, "images");
const HISTORY_DIR = path.join(DATA, "history");
const UPLOADS_DIR = path.join(DATA, "uploads");
const TOOLS_DIR = path.join(ROOT, "tools");
const PUBLIC_DIR = path.join(ROOT, "public");

const PORT = process.env.PORT || 3000;
const PYTHON = process.env.PYTHON || "python3";

for (const d of [EXAMS_DIR, IMAGES_DIR, HISTORY_DIR, UPLOADS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/images", express.static(IMAGES_DIR));

// Health probe (excluded from auth) for App Service / container health checks.
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// ---------------- helpers ----------------
function slugify(name) {
  return String(name || "exam")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "exam";
}

function uniqueExamId(base) {
  let id = base, n = 2;
  while (fs.existsSync(path.join(EXAMS_DIR, `${id}.json`))) {
    id = `${base}-${n++}`;
  }
  return id;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function listExamFiles() {
  return fs.readdirSync(EXAMS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => path.join(EXAMS_DIR, f));
}

function examCounts(questions) {
  const counts = { single: 0, multi: 0, dropdown: 0, yesno: 0, image: 0 };
  for (const q of questions || []) {
    if (counts[q.type] === undefined) counts[q.type] = 0;
    counts[q.type]++;
  }
  return counts;
}

function examMeta(exam) {
  const counts = examCounts(exam.questions);
  const selfGraded = counts.image || 0;
  const total = (exam.questions || []).length;
  return {
    id: exam.id,
    name: exam.name,
    source: exam.source || null,
    totalQuestions: exam.totalQuestions != null ? exam.totalQuestions : total,
    counts,
    autoGraded: total - selfGraded,
    selfGraded,
  };
}

// Analyse the last N finished sessions.
function analyseHistory(sessions, lookback) {
  const windowSize = Math.max(1, parseInt(lookback, 10) || 3);
  const recent = sessions.slice(-windowSize);
  const seen = new Set();
  const lastResult = new Map(); // qid -> correct(bool) most recent in window
  for (const s of recent) {
    for (const q of s.questions || []) {
      seen.add(q.id);
      lastResult.set(q.id, !!q.correct); // later sessions overwrite → most recent wins
    }
  }
  const incorrect = [];
  for (const [id, correct] of lastResult.entries()) {
    if (!correct) incorrect.push(id);
  }
  return {
    windowSize,
    sessionsConsidered: recent.length,
    seen: [...seen],
    incorrect,
  };
}

function summarizeSession(s) {
  return {
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    earned: s.earned,
    possible: s.possible,
    percentage: s.percentage,
    total: s.unitCount != null ? s.unitCount : (s.questions || []).length,
  };
}

function loadHistory(examId) {
  return readJson(path.join(HISTORY_DIR, `${examId}.json`), []);
}

// ---------------- import jobs ----------------
const jobs = new Map(); // jobId -> {status, id, name, startedAt, summary, error}

function startParseJob(pdfPath, examId, name) {
  const jobId = crypto.randomBytes(8).toString("hex");
  const outJson = path.join(EXAMS_DIR, `${examId}.json`);
  const args = [
    path.join(TOOLS_DIR, "parse_pdf.py"),
    pdfPath, examId, name, IMAGES_DIR, outJson,
  ];
  const job = { status: "running", id: examId, name, startedAt: Date.now(), stderr: "" };
  jobs.set(jobId, job);

  const child = spawn(PYTHON, args, { cwd: ROOT });
  let lastStdout = "";
  child.stdout.on("data", d => { lastStdout += d.toString(); });
  child.stderr.on("data", d => {
    job.stderr = (job.stderr + d.toString()).slice(-4096);
  });
  child.on("error", err => {
    job.status = "error";
    job.error = `Failed to spawn ${PYTHON}: ${err.message}`;
  });
  child.on("close", code => {
    if (code === 0 && fs.existsSync(outJson)) {
      let summary = null;
      const lines = lastStdout.trim().split(/\r?\n/);
      try { summary = JSON.parse(lines[lines.length - 1]); } catch { /* ignore */ }
      job.status = "done";
      job.summary = summary;
    } else if (job.status !== "error") {
      job.status = "error";
      job.error = job.stderr.slice(-2048) || `Parser exited with code ${code}`;
    }
    fs.unlink(pdfPath, () => {});
  });

  return jobId;
}

// ---------------- API ----------------
app.get("/api/exams", (req, res) => {
  const out = [];
  for (const file of listExamFiles()) {
    const exam = readJson(file, null);
    if (exam && exam.id) out.push(examMeta(exam));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  res.json(out);
});

app.get("/api/exams/:id", (req, res) => {
  const file = path.join(EXAMS_DIR, `${req.params.id}.json`);
  const exam = readJson(file, null);
  if (!exam) return res.status(404).json({ error: "Exam not found" });
  res.json(exam);
});

app.get("/api/exams/:id/history", (req, res) => {
  const examFile = path.join(EXAMS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(examFile)) return res.status(404).json({ error: "Exam not found" });
  const sessions = loadHistory(req.params.id);
  const analysis = analyseHistory(sessions, req.query.lookback);
  const summaries = sessions.slice().reverse().map(summarizeSession);
  res.json({ count: sessions.length, sessions: summaries, analysis });
});

app.post("/api/exams/:id/sessions", (req, res) => {
  const examFile = path.join(EXAMS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(examFile)) return res.status(404).json({ error: "Exam not found" });
  const body = req.body || {};
  const session = {
    startedAt: body.startedAt || Date.now(),
    finishedAt: body.finishedAt || Date.now(),
    earned: Number(body.earned) || 0,
    possible: Number(body.possible) || 0,
    percentage: Number(body.percentage) || 0,
    unitCount: body.unitCount != null ? body.unitCount : undefined,
    questions: Array.isArray(body.questions) ? body.questions.map(q => ({
      id: q.id, type: q.type,
      earned: Number(q.earned) || 0,
      possible: Number(q.possible) || 0,
      correct: !!q.correct,
    })) : [],
  };
  const histFile = path.join(HISTORY_DIR, `${req.params.id}.json`);
  const sessions = loadHistory(req.params.id);
  sessions.push(session);
  fs.writeFileSync(histFile, JSON.stringify(sessions, null, 2));
  const analysis = analyseHistory(sessions, req.query.lookback);
  res.json({ ok: true, analysis, count: sessions.length });
});

app.delete("/api/exams/:id", (req, res) => {
  const id = req.params.id;
  const examFile = path.join(EXAMS_DIR, `${id}.json`);
  if (!fs.existsSync(examFile)) return res.status(404).json({ error: "Exam not found" });
  fs.unlinkSync(examFile);
  // delete <id>_* images
  try {
    for (const f of fs.readdirSync(IMAGES_DIR)) {
      if (f.startsWith(`${id}_`)) fs.unlinkSync(path.join(IMAGES_DIR, f));
    }
  } catch { /* ignore */ }
  const histFile = path.join(HISTORY_DIR, `${id}.json`);
  if (fs.existsSync(histFile)) fs.unlinkSync(histFile);
  res.json({ ok: true });
});

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.post("/api/exams", upload.single("pdf"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Missing 'pdf' file" });
  const name = (req.body.name || "").trim() || path.parse(req.file.originalname).name;
  const id = uniqueExamId(slugify(name));
  const jobId = startParseJob(req.file.path, id, name);
  res.status(202).json({ jobId, id, name });
});

app.get("/api/exams/import/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
  const out = { status: job.status, id: job.id, name: job.name, elapsed };
  if (job.status === "done") out.summary = job.summary;
  if (job.status === "error") out.detail = (job.error || "").slice(-2048);
  res.json(out);
});

// ---------------- boot ----------------
const server = app.listen(PORT, () => {
  console.log(`Certification Trainer running at http://localhost:${PORT}`);
});
// Relax timeouts so long OCR imports don't get killed.
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 30 * 60 * 1000;
server.timeout = 0;
server.keepAliveTimeout = 65 * 1000;
