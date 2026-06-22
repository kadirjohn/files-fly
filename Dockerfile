FROM node:22-alpine

# Set heap limit at image level (more reliable than CMD arg or compose env)
ENV NODE_OPTIONS=--max-old-space-size=4096

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
    CMD node -e "require('http').get('http://localhost:9392/',r=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "--max-old-space-size=4096", "server.js"]
