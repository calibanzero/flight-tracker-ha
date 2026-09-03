FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    BGS_DIR=/data/bgs

RUN apk add --no-cache ca-certificates

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

RUN mkdir -p /data /data/bgs

EXPOSE 3002

CMD ["node", "server.js"]
