# Minimal image for MCP directory listings (e.g. Glama) that build + start the
# server to verify it responds to introspection (tools/list).
#
# NOTE: normal usage is `npx -y @pineforge/codegen-mcp` on the host — the server
# shells out to the host Docker daemon to transpile + backtest. This image only
# needs to *start* and list tools; backtest tools require host Docker at runtime.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund
COPY . .
RUN npm run build
ENTRYPOINT ["node", "dist/index.js"]
