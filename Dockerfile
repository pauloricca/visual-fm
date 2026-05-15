FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache openssl

COPY index.html README.md ./
COPY src ./src
COPY scripts ./scripts
COPY patches ./patches

EXPOSE 8839 8843 8844

CMD ["node", "scripts/serve.mjs"]
