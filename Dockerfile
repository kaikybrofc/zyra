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
RUN --mount=type=secret,id=npm_token \
    sh -c 'TOKEN="$(cat /run/secrets/npm_token)" && \
    printf "%s\n%s\n%s\n" \
      "legacy-peer-deps=true" \
      "@kaikybrofc:registry=https://npm.pkg.github.com" \
      "//npm.pkg.github.com/:_authToken=${TOKEN}" > /tmp/.npmrc && \
    NPM_CONFIG_USERCONFIG=/tmp/.npmrc npm ci && \
    rm -f /tmp/.npmrc'

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache \
    python3 make g++ pkgconf \
    cairo-dev pango-dev pixman-dev jpeg-dev giflib-dev && \
    addgroup -S zyra && adduser -S zyra -G zyra

WORKDIR /app

COPY package*.json .npmrc patches/ ./
RUN --mount=type=secret,id=npm_token \
    sh -c 'TOKEN="$(cat /run/secrets/npm_token)" && \
    printf "%s\n%s\n%s\n" \
      "legacy-peer-deps=true" \
      "@kaikybrofc:registry=https://npm.pkg.github.com" \
      "//npm.pkg.github.com/:_authToken=${TOKEN}" > /tmp/.npmrc && \
    NPM_CONFIG_USERCONFIG=/tmp/.npmrc npm ci --omit=dev && \
    rm -f /tmp/.npmrc'

COPY --from=builder /build/dist ./dist/

RUN mkdir -p data/auth data/media data/antiban && \
    chown -R zyra:zyra /app

USER zyra

VOLUME ["/app/data"]

# Prometheus antiban metrics
EXPOSE 9108

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
