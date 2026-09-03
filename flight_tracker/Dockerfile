FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    BGS_DIR=/data/bgs

RUN apk add --no-cache ca-certificates curl gzip

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

# Refresh reference data during image builds. The updater keeps a bundled
# copy if either upstream source is temporarily unavailable.
RUN chmod +x /app/update-aircraft-db.sh \
    && /app/update-aircraft-db.sh

RUN mkdir -p /data /data/bgs

EXPOSE 3002

CMD ["node", "server.js"]
