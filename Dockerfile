# Certification Trainer — Node 20 + Python 3 (for PDF OCR import tooling)
FROM node:20-bookworm-slim

# System deps: python3 + pip for tools/parse_pdf.py, plus libs needed by
# pymupdf / onnxruntime / opencv (used transitively by rapidocr).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      libglib2.0-0 \
      libgl1 \
      libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080 \
    PYTHON=python3 \
    NODE_ENV=production

WORKDIR /app

# Python OCR dependencies (installed into a venv to avoid PEP 668 issues).
COPY tools/requirements.txt ./tools/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r ./tools/requirements.txt
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHON=/opt/venv/bin/python3

# Node dependencies (production only).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source.
COPY server.js ./
COPY public ./public
COPY tools ./tools

# Seed data baked into the image; copied into the (possibly Azure Files-mounted)
# /app/data volume at startup when the volume is empty. See docker-entrypoint.sh.
COPY data ./seed-data

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
