# ══════════════════════════════════════════════════════════
#  Encodium — Dockerfile
#  Multi-stage build: lightweight Node.js + ffmpeg
# ══════════════════════════════════════════════════════════

FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ──────────────────────────────────────────────────────────
FROM node:20-slim

LABEL maintainer="HeartBtz"
LABEL description="Encodium — Video encoding & library management"

# Install ffmpeg and VA-API capability detection/drivers.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg vainfo mesa-va-drivers && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy node_modules from builder stage
COPY --from=builder --chown=node:node /app/node_modules ./node_modules

# Copy application code
COPY --chown=node:node . .

# Create required data directories
RUN mkdir -p data/logs data/encoded data/thumbs data/media && chown -R node:node /app/data

# Default environment variables (override via docker-compose or .env)
# DB_PASS is REQUIRED — container will exit without it.
# JWT_SECRET is recommended to persist sessions across restarts.
ENV NODE_ENV=production \
    PORT=4000 \
    DB_HOST=db \
    DB_PORT=3306 \
    DB_USER=encodium \
    DB_NAME=encodium \
    MEDIA_DIR=/media \
    ENCODE_DIR=/app/data/encoded \
    THUMB_DIR=/app/data/thumbs \
    MAX_WORKERS=2

EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:${PORT}/api/health').then(r=>{if(!r.ok)throw r;process.exit(0)}).catch(()=>process.exit(1))" || exit 1

USER node
CMD ["node", "server.js"]
