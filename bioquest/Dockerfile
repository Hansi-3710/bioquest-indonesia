FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 10001 --create-home bioquest && mkdir -p /data/vault /data/models && chown -R bioquest /data
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=bioquest package*.json ./
COPY --chown=bioquest src ./src
COPY --chown=bioquest db ./db
COPY --chown=bioquest scripts ./scripts
COPY --chown=bioquest public ./public
USER bioquest
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
