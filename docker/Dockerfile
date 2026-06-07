# Self-contained Glama-deployable MCP image: the pineforge-engine (g++, the
# prebuilt libpineforge.a, the bundled codegen, entrypoint.sh) plus the Node
# MCP server. Runs every tool with no host Docker daemon — the local entrypoint
# (dist/index.local.js) execs the engine entrypoint in-process.
#
# Build: docker build -f docker/Dockerfile -t pineforge-codegen-mcp .

# Single source of truth for the baked engine version: it tags the base image
# AND is exported as PINEFORGE_VERSION so engine_info can report it. Declared
# before the first FROM so it's usable in the final stage's FROM line.
ARG ENGINE_VERSION=0.8.0

# --- build MCP dist + prod deps (reproducible: committed lockfile + npm ci) ---
FROM node:22-slim AS mcp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# --- final: engine image + node runtime + MCP server ---
FROM ghcr.io/pineforge-4pass/pineforge-engine:${ENGINE_VERSION}
ARG ENGINE_VERSION
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
ENV PINEFORGE_PREFIX=/opt/pineforge \
    PINEFORGE_ALLOW_ANYWHERE=1 \
    PINEFORGE_VERSION=${ENGINE_VERSION}
# Ownership annotation for the official MCP Registry — its validator checks this
# label on the published image and requires it to match the `name` in server.json.
LABEL io.modelcontextprotocol.server.name="io.github.pineforge-4pass/pineforge-codegen-mcp"
ENTRYPOINT ["node", "dist/index.local.js"]
