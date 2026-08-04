# Certification Trainer

A self-contained web app for practising Microsoft-style certification exams
(e.g. **SC-900**, **DP-900**) that were captured as **CertyIQ-style PDF dumps**.
Pick an exam, answer questions of several types with instant grading and
explanations, then review a per-question breakdown and your score history.

Ships with a hand-authored **SC-900 (sample)** exam so it is usable immediately.

---

## Requirements
- **Node.js >= 18** and **npm** (required — runs the server and serves the app).
- **Python 3** with `pdfplumber` (+ optional `pymupdf`, `rapidocr-onnxruntime`,
  `numpy`, `pillow`) — **only needed to import new PDFs**. The app runs fine
  without Python if you just use existing/sample exams.

## Install & run
```bash
./install.sh          # checks Node>=18, installs npm + Python deps
./start.sh            # starts the server on PORT (default 3000)
# open http://localhost:3000
./stop.sh             # stops the server
```
`install.sh` options: `--no-python` (Node only), `--help`. Override the
interpreter with `PYTHON=/path/to/python ./install.sh`.

## Using the app
1. **Practice** tab: choose an exam, the number of questions, and a *look-back
   window* (how many recent sessions to analyse). Optionally prioritise questions
   you recently got wrong, include questions you haven't seen recently, or turn on
   *exam mode* (answers revealed only at the end).
2. Answer each question (single / multiple choice / drop-downs / yes-no / self-
   graded image), press **Show answer(s)** to see the result and explanation, then
   **Next**.
3. **End** the session (or finish) to see your **score, per-question breakdown,
   and a review of everything you got wrong**. Sessions are saved per exam.

### Question types
- **single** — one correct choice (1 pt).
- **multi** — 2+ correct; +1 per correct box, −1 per wrong box, floored at 0.
- **dropdown** — one graded blank per drop-down (also models matching/ordering).
- **yesno** — one point per statement.
- **image** — self-graded fallback for hotspot/drag-drop items (you mark yourself).

Repeated-scenario "case" questions are grouped into a **series**: shown together
on one screen, counted as one question, but each member is still scored 1 point.

## Importing a PDF
Use the **Add exam (PDF)** tab, or run the parser directly:
```bash
python3 tools/parse_pdf.py <pdf> <exam-id> "<Exam Name>" data/images data/exams/<exam-id>.json
# add VERBOSE=1 or -v for per-question logging
```
The parser reads questions in reading order with `pdfplumber`, auto-grades
single/multiple-choice questions, and renders HOTSPOT/DRAG-DROP pages to images
as **self-graded** questions when they can't be graded reliably (so imports never
fail). PyMuPDF/OCR/NumPy are optional and only enrich image handling.

## Data layout
```
data/
  exams/     <exam-id>.json      # one file per exam (edit freely; no restart needed)
  images/    <exam-id>_q*.png    # question/answer/exhibit images
  history/   <exam-id>.json      # saved sessions per exam
  uploads/   (temp PDF uploads)
```
> **Note:** the server lists exams by globbing `data/exams/*.json`, so never keep
> backup JSONs there — put them in `data/exams_backups/` (git-ignored) instead.

## Ports & env
- `PORT` — server port (default `3000`).
- `PYTHON` — interpreter used to spawn the PDF parser (default `python3`).
- `DATA_DIR` — override the data directory (used in Azure to point at persistent
  `/home/data`; defaults to `./data`).

## Deploy to Azure (App Service container + Entra ID login)

The app is deployed as a **Linux container on Azure App Service** (Node + Python),
protected by **Microsoft Entra ID** via built-in App Service Authentication ("Easy Auth"),
so it is reachable from any device over HTTPS and only after signing in with a
Microsoft account in the tenant.

**Why App Service (not a VM):** managed HTTPS on `*.azurewebsites.net`, zero-code
Entra login, no OS to patch, and lower cost than a 24/7 VM.

Infrastructure lives in [`infra/main.bicep`](infra/main.bicep):
Azure Container Registry, B1 Linux App Service plan, the container Web App
(managed-identity ACR pull), Application Insights + Log Analytics.

### One-time deploy
```bash
SUB=<subscription-id>
RG=rg-certification-trainer
LOC=westeurope
ACR=ctacr$(openssl rand -hex 3)

az account set --subscription "$SUB"
az group create -n "$RG" -l "$LOC"
az acr create -n "$ACR" -g "$RG" --sku Basic

# Build the image in the cloud (no local Docker needed)
az acr build --registry "$ACR" --image certification-trainer:latest --file Dockerfile .

# Provision compute + monitoring
az deployment group create -g "$RG" --template-file infra/main.bicep \
  --parameters location="$LOC" namePrefix=ct acrName="$ACR" \
               imageName=certification-trainer:latest

# Enable Entra ID login (Easy Auth) — see .azure/deployment-plan.md for the exact
# app-registration + authsettingsV2 steps.
```

### Persistence
Session history and imported exams are stored under **`/home/data`** (App Service
built-in persistent storage; `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` +
`DATA_DIR=/home/data`). The container seeds `/home/data` from the baked-in sample
exams on first boot. Azure Files (customer storage account) is intentionally **not**
used because the subscription policy disables storage-account shared-key access.

### Update the running app
```bash
az acr build --registry "$ACR" --image certification-trainer:latest --file Dockerfile .
az webapp restart -g "$RG" -n <web-app-name>
```
