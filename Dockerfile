# syntax=docker/dockerfile:1.7

# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /build

# Install build deps for native modules (libsignal, mysql2, canvas)
RUN apk add --no-cache \
    python3 make g++ pkgconf \
    cairo-dev pango-dev pixman-dev jpeg-dev giflib-dev

COPY package*.json .npmrc ./
# postinstall runs patch-package automatically
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache \
    python3 make g++ pkgconf \
    cairo-dev pango-dev pixman-dev jpeg-dev giflib-dev && \
    addgroup -S zyra && adduser -S zyra -G zyra

WORKDIR /app

COPY package*.json ./
COPY scripts/ ./scripts/
COPY docs/ ./docs/
COPY --from=builder /build/node_modules ./node_modules/
COPY --from=builder /build/dist ./dist/

RUN mkdir -p data/auth data/media data/antiban && \
    chown -R zyra:zyra /app

USER zyra

VOLUME ["/app/data"]

# API, Prometheus antiban metrics, health
EXPOSE 3000 9108 9109

ENV NODE_ENV=production \
    WA_AUTH_DIR=data/auth \
    WA_ANTIBAN_STATE_DIR=data/antiban \
    WA_MEDIA_DOWNLOAD_DIR=data/media \
    WA_PRINT_QR=true \
    WA_ANTIBAN_ENABLED=true \
    WA_ANTIBAN_METRICS_ENABLED=true \
    WA_ANTIBAN_METRICS_HOST=0.0.0.0 \
    WA_ANTIBAN_METRICS_PORT=9108

CMD ["node", "dist/index.js"]
