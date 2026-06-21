FROM node:22-alpine

# node:22-alpine already has a non-root 'node' user (UID 1000, GID 1000).
# We use that instead of creating a new one to avoid GID conflicts.

WORKDIR /usr/src/app

# Copy package.json first (layer caching)
COPY package.json ./
RUN npm install --production && npm cache clean --force

# Copy application code
COPY server.js ./
COPY seed.js ./
COPY middleware/ ./middleware/
COPY services/ ./services/
COPY routes/ ./routes/
COPY migrations/ ./migrations/
COPY public/ ./public/

# Create upload directory and set ownership
RUN mkdir -p /data/uploads && chown -R node:node /data/uploads /usr/src/app

# Switch to non-root user (already exists in base image)
USER node

EXPOSE 9392

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:9392/ || exit 1

CMD ["node", "server.js"]
