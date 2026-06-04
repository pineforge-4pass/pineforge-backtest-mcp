# Self-contained Glama-deployable MCP image: the pineforge-engine (g++, the
# prebuilt libpineforge.a, the bundled codegen, entrypoint.sh) plus the Node
# MCP server. Runs every tool with no host Docker daemon — the server execs
# the engine entrypoint in-process (PINEFORGE_ENGINE_MODE=local).
#
# Build: docker build -f docker/Dockerfile -t pineforge-codegen-mcp .

# --- build MCP dist + prod deps ---
# package-lock.json is gitignored in this repo, so CI checkouts don't have it
# and `npm ci` can't run. Use `npm install` against package.json alone.
FROM node:22-slim AS mcp
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# --- final: engine image + node runtime + MCP server ---
FROM ghcr.io/pineforge-4pass/pineforge-engine:0.8.0
# We copy only the `node` binary onto the engine base. This is sound ONLY while
# the engine base stays Debian/glibc-compatible with node:22-slim (node is
# dynamically linked against glibc + libstdc++). If the engine base ever moves
# to Alpine/musl or a divergent glibc, node will fail at load — switch to
# installing node in the final stage instead of copying the binary.
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=mcp /app/dist ./dist
COPY --from=mcp /app/node_modules ./node_modules
COPY --from=mcp /app/package.json ./
ENV PINEFORGE_ENGINE_MODE=local \
    PINEFORGE_PREFIX=/opt/pineforge \
    PINEFORGE_ALLOW_ANYWHERE=1
ENTRYPOINT ["node", "dist/index.js"]
