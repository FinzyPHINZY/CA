FROM python:3.11-slim

# install system dependencies for pdf2image (poppler) and other libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    libglib2.0-0 \
    libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 3005

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD python -c "import httpx; httpx.get('http://localhost:3005/health').raise_for_status()"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3005"]
