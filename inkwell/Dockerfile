# Inkwell production image
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=3000 \
    INKWELL_DATA_DIR=/data \
    INKWELL_DB_PATH=/data/inkwell.db \
    INKWELL_UPLOAD_DIR=/data/uploads \
    INKWELL_SKIP_SEED=1 \
    TRUST_PROXY=1
WORKDIR /app
# Fonts for the share-card images rendered with sharp.
RUN apt-get update && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core && rm -rf /var/lib/apt/lists/* \
 && addgroup --system inkwell && adduser --system --ingroup inkwell inkwell \
 && mkdir -p /data/uploads && chown -R inkwell:inkwell /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
USER inkwell
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
