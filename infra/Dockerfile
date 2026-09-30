# NMQ Robot — produkcijski image.
# Zero-dep jezgro: nema `npm install`, nema build koraka → image je mali i brz.
FROM node:22-alpine

LABEL org.opencontainers.image.title="NMQ Robot" \
      org.opencontainers.image.description="Univerzalni multi-tenant AI agent (gateway, orchestracija, MCP, memorija, observability)" \
      org.opencontainers.image.vendor="NMQ — Dejan Milošević PR"

WORKDIR /app
ENV NODE_ENV=production \
    NMQ_HOST=0.0.0.0 \
    NMQ_PORT=8787 \
    NMQ_DATA_DIR=/data \
    NMQ_LOG_LEVEL=info

# samo ono što treba — bez node_modules
COPY package.json ./
COPY src ./src
COPY config ./config
COPY public ./public
COPY mcp ./mcp
COPY scripts ./scripts

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NMQ_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "scripts/serve.mjs"]
