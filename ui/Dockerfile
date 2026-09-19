# Builds and serves the dogFoodChain dashboard as a static production build.
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 5173
# `vite preview` serves the production build — not the dev server — and needs
# --host to be reachable from outside the container (Vite binds to localhost only
# by default).
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "5173"]
