FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies (including Node.js for WebTorrent)
RUN apt-get update && \
    apt-get install -y --no-install-recommends gcc ffmpeg curl ca-certificates libarchive-tools && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Copy requirements (Python and Node.js) first for better caching
COPY requirements.txt package.json package-lock.json* ./
RUN pip install --no-cache-dir -r requirements.txt && \
    npm ci || npm install

# Copy application code
COPY . .

# Create staging directory
RUN mkdir -p /app/staging /app/sessions

# Ensure Python prints logs immediately (unbuffered)
ENV PYTHONUNBUFFERED=1

# Expose FTP ports
EXPOSE 2121
EXPOSE 60000-60100
# Expose HTTP streaming + WebDAV
EXPOSE 8080
EXPOSE 8085

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD python -c "import socket; s=socket.socket(); s.settimeout(5); s.connect(('localhost', 2121)); s.close()" || exit 1

CMD ["python", "main.py"]
