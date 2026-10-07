# Stdio MCP server (thin proxy to https://emission-factors.com). Used by MCP directories
# (e.g. Glama) to build and introspect the server; most users want the hosted remote URL.
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm cache clean --force
ENTRYPOINT ["node", "dist/index.js"]
