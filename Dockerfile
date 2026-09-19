# Builds the dogFoodChain node/CLI image. One image, reused for all three node
# services in docker-compose.yml (writer/confirmer-b/confirmer-c) — which role a
# container plays is set entirely by env vars at container-start time (see
# docker/entrypoint.sh), not by building separate images.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY fixtures/dev-certs ./fixtures/dev-certs
COPY fixtures/docker-genesis.jsonl ./fixtures/docker-genesis.jsonl
COPY docker/entrypoint.sh ./docker/entrypoint.sh

ENTRYPOINT ["./docker/entrypoint.sh"]
