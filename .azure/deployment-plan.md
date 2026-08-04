# Deployment Plan — Certification Trainer

**Status:** Deployed & verified

## 1. Workspace analysis
- Mode: MODIFY (add Azure deployment to an existing app).
- App: `certification-trainer` — Node.js 18+ / Express, vanilla JS SPA, Python OCR tooling for PDF import.
- Persistence: JSON + PNG files on local disk under `data/` (exams, images, history, uploads). No DB.

## 2. Requirements
- Access the app from any corporate device, even when the laptop is off (always-on, public HTTPS).
- Sign in with the user's Microsoft (Entra ID) credentials.
- Test end-to-end, then commit to GitHub `JRmon42/TrainingSite`.

## 3. Codebase scan
- Backend: `server.js` (Express, reads `PORT`, default 3000). Spawns `python3 tools/parse_pdf.py` for imports.
- Frontend: `public/` static assets (index.html, app.js, style.css).
- Python tooling: pdfplumber, pymupdf, rapidocr-onnxruntime, numpy (`PYTHON` env override).
- Seed data: `data/exams/*.json`, `data/history/*.json`, `data/images/*` (~20 KB total).

## 4. Recipe: Bicep (+ az CLI for image build & auth)
The app needs a custom container (Node AND Python OCR deps), an ACR image build, an Azure Files
persistent mount, and Easy Auth (Entra ID). These are most deterministic with Bicep infra + targeted
`az` commands rather than azd's code-centric flow. `az acr build` builds the image in the cloud (no local Docker).

## 5. Architecture — App Service for Linux Containers
Chosen over the user's "VM + expose + auth" idea because it is simpler, cheaper, and more secure:
managed HTTPS on *.azurewebsites.net, built-in Entra login (Easy Auth, zero code), no OS to patch.

| Component | Azure service | Notes |
|-----------|---------------|-------|
| Web app (Node 20 + Python 3 container) | App Service (Linux, container) on B1, Always On | Runs node server.js on PORT=8080 |
| Container image | Azure Container Registry (Basic) | Built via az acr build; pulled via managed identity (AcrPull) |
| Persistent data (/app/data) | Storage Account + Azure Files share | Mounted at /app/data; seeded from baked-in /app/seed-data on first boot |
| Authentication | App Service Easy Auth + Entra app registration | Single-tenant; requireAuthentication, redirect to login |
| Observability | Application Insights + Log Analytics | Wired via app settings |

### App changes (minimal, non-breaking)
- Add GET /health endpoint (App Service health check).
- Add Dockerfile (Node 20 + Python 3 + OCR deps) and tools/requirements.txt.
- Add .dockerignore.
- Entrypoint seeds /app/data from /app/seed-data when the mounted share is empty.

## 6. Decisions
- Subscription: 77e2f61e-ceb7-42a0-baa1-1baa32a396b2 (HPC-EDA-Sub-JRP), user admin@MngEnv995349.onmicrosoft.com.
- Resource group: rg-certification-trainer (new).
- Region: westeurope.
- Auth model: single-tenant Entra app; any user in the tenant can sign in.
- GitHub: commit full app + infra to JRmon42/TrainingSite after successful test.

## Execution steps
1. App changes: /health, Dockerfile, tools/requirements.txt, .dockerignore, entrypoint seed.
2. infra/main.bicep (+ params): ACR, plan, web app (container, MI, AcrPull), storage + file share + mount,
   app settings, App Insights, Easy Auth settings.
3. Deploy: RG -> ACR -> az acr build -> Bicep -> create Entra app + secret -> configure Easy Auth -> restart.
4. Test: health, auth redirect when anonymous, authenticated page load, exam list API.
5. Commit to JRmon42/TrainingSite.


## Outcome (deployed)
- Resource group: `rg-certification-trainer` (westeurope).
- ACR: `ctacrf71465`; image `certification-trainer:latest` (Node 20 + Python OCR deps).
- Web app: `ct-app-qpmbyitznxm6u` -> https://ct-app-qpmbyitznxm6u.azurewebsites.net
- App Service plan: B1 Linux, Always On; App Insights + Log Analytics.
- **Persistence pivot:** subscription policy enforces `allowSharedKeyAccess=false` and
  `publicNetworkAccess=Disabled` on storage accounts, so App Service Azure Files (key-based)
  mounts fail with `InvalidCredentials`. Switched to App Service built-in persistent storage:
  `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` + `DATA_DIR=/home/data`. The entrypoint seeds
  `/home/data` from the baked-in `/app/seed-data` on first boot. The customer storage account
  in the Bicep is no longer used and was removed from the template.
- **Auth:** Easy Auth v2 (Entra single-tenant app `Certification Trainer`,
  clientId `3bd6145a-3018-4dc0-a4a9-ffc805ee95af`), `requireAuthentication=true`,
  redirect to Microsoft login; `/health` excluded for platform probes.
- Verified: `/health` 200 anonymous; `/` and `/api/exams` 401 for API clients / 302 to
  `login.microsoftonline.com` for browsers; exams seeded and served.
