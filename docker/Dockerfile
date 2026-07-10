# Self-contained Glama-deployable MCP image: the pineforge-release base (the
# pineforge-engine runtime + the bundled codegen transpiler, g++, the prebuilt
# libpineforge.a, entrypoint.sh) plus the Node MCP server. Runs every tool with
# no host Docker daemon — the local entrypoint (dist/index.local.js) execs the
# base image entrypoint in-process.
#
# Build: docker build -f docker/Dockerfile -t pineforge-backtest-mcp .

# The baked pineforge-release version is supplied by CI as a build-arg (resolved
# at release time; recorded in the release tag message `release=`, read back by
# publish.yml). It tags the base image AND is exported as PINEFORGE_VERSION so
# engine_info can report it. No default — building without
# `--build-arg PINEFORGE_RELEASE_VERSION` fails fast at the FROM below.
# Declared before the first FROM so it's usable in the final stage's FROM line.
ARG PINEFORGE_RELEASE_VERSION

# --- build MCP dist + prod deps (reproducible: committed lockfile + npm ci) ---
FROM node:22-slim AS mcp
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# --- final: pineforge-release image + node runtime + MCP server ---
FROM ghcr.io/pineforge-4pass/pineforge-release:${PINEFORGE_RELEASE_VERSION}
ARG PINEFORGE_RELEASE_VERSION
# We copy only the `node` binary onto the release base. This is sound ONLY while
# the base stays Debian/glibc-compatible with node:22-slim (node is
# dynamically linked against glibc + libstdc++). If the engine base ever moves
# to Alpine/musl or a divergent glibc, node will fail at load — switch to
# installing node in the final stage instead of copying the binary.
# Root ONLY for build-time setup (COPY is root-owned; the chown below needs
# root). The engine base went non-root (USER pineforge, uid 10001) in 0.10.1 —
# we keep that hardened default and drop back to it before ENTRYPOINT.
USER root
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=mcp /app/dist ./dist
COPY --from=mcp /app/node_modules ./node_modules
COPY --from=mcp /app/package.json ./
# Reports default to cwd (= /app) when no host workdir is mounted; engine temp
# work already goes to world-writable /tmp. Give the non-root runtime user
# ownership of /app so report offload works out of the box.
RUN chown -R 10001 /app
ENV PINEFORGE_PREFIX=/opt/pineforge \
    PINEFORGE_ALLOW_ANYWHERE=1 \
    PINEFORGE_VERSION=${PINEFORGE_RELEASE_VERSION}
# Ownership annotation for the official MCP Registry — its validator checks this
# label on the published image and requires it to match the `name` in server.json.
LABEL io.modelcontextprotocol.server.name="io.github.pineforge-4pass/pineforge-backtest-mcp"
# Drop privileges: run the MCP server as the engine base's non-root user (uid
# 10001). To write reports into a HOST bind-mount (-v <hostdir>:/work -w /work),
# pass --user $(id -u):$(id -g) so the files carry your ownership.
USER 10001
ENTRYPOINT ["node", "dist/index.local.js"]
