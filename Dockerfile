FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first so code changes do not bust the layer cache.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Tracking state lives here; mount a volume so it survives restarts.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
