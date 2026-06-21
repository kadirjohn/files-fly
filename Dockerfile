FROM node:22-alpine

# Güvenlik: non-root kullanıcı oluştur
RUN addgroup -g 1000 nodegroup && \
    adduser -u 1000 -G nodegroup -s /bin/sh -D nodeuser

WORKDIR /usr/src/app

# Önce package.json'ı kopyala (layer caching için)
COPY package.json ./
RUN npm install --production && npm cache clean --force

# Uygulama kodlarını kopyala
COPY server.js ./
COPY seed.js ./
COPY middleware/ ./middleware/
COPY services/ ./services/
COPY routes/ ./routes/
COPY migrations/ ./migrations/
COPY public/ ./public/

# Upload dizinini oluştur ve yetkilendir
RUN mkdir -p /data/uploads && chown -R nodeuser:nodegroup /data/uploads /usr/src/app

# Non-root kullanıcıya geç
USER nodeuser

EXPOSE 9392

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:9392/ || exit 1

CMD ["node", "server.js"]
