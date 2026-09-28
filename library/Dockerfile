FROM python:3.12.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app
COPY pyproject.toml requirements-deploy.lock README.md ./
COPY app ./app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        poppler-utils \
        tesseract-ocr \
        tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --upgrade pip==26.2.1 \
    && pip install --requirement requirements-deploy.lock \
    && pip install . --no-deps

RUN addgroup --system rag && adduser --system --ingroup rag rag
USER rag
EXPOSE 8787

CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8787", "--proxy-headers"]
