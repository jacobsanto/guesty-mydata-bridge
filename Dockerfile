# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
      ca-certificates \
      curl \
      dumb-init \
      fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3001 \
    DB_CLIENT=pg \
    MYDATA_ENV=sandbox \
    MYDATA_PRODUCTION_ENABLED=false \
    DAILY_CLOSE_ENABLED=false

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node . .

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent --show-error http://127.0.0.1:3001/health/ready >/dev/null || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
