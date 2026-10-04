FROM node:22-alpine

RUN apk add --no-cache su-exec ffmpeg

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    PHOTO_DIR=/photos \
    CONFIG_DIR=/config \
    PUID=99 \
    PGID=100

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY views ./views
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

VOLUME ["/photos", "/config"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/api/status >/dev/null || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
