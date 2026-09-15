FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# su-exec lets the entrypoint drop from root to the app user after fixing
# permissions on the mounted volume.
RUN apk add --no-cache su-exec

# Install dependencies first so code changes do not bust the layer cache.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Tracking state lives here; mount a volume so it survives restarts.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data

EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Starts as root, chowns the volume, then runs the bot as the node user.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
