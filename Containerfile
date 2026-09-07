# syntax=docker/dockerfile:1.7
#
# ===================================
#
# Stage graph (site):
#   base             : Ubuntu 22.04 + LDC toolchain (apt cache mounted)
#   builder-common   : dub fetch + shared `common` library build (site)
#   builder-backend  : gateway binary (`irc-fiber`) — from builder-common
#   frontend-builder : vite build (node:20-bookworm) — frontend + public/dist
#   runtime-gateway  : slim Ubuntu + gateway binary + public/dist
#
# builder-backend and frontend-builder are independent: BuildKit runs them
# concurrently and a change on one side never invalidates the other. The SPA
# shell (views/index.dt) links the bundle at runtime from
# public/dist/.vite/manifest.json (ircfiber.web.assets), so the D compile no
# longer waits for vite.
#
# Caching: the build context is a git checkout, so BuildKit's content hashing
# of every COPY is the whole invalidation story — there are no CACHE_BUST
# sentinels and no `dub --force`. The dub/npm cache mounts persist across
# builds on the builder host, so a one-file change is an incremental compile.
# Build identity (commit, describe, time) lives in an ENV-only layer at the
# very end of runtime-gateway: metadata, no bytes, invalidates nothing above.
#
# Site-only image: never compiles engine sources.
# Build: docker buildx build --target runtime-gateway -f Containerfile . -t test-site
#
# ============================================================================
# Stage: base — Ubuntu + toolchain
# ============================================================================
FROM ubuntu:22.04 AS base

ARG LDC_VERSION=1.41.0
ARG TARGETARCH

# Docker ships an apt-clean hook that empties /var/cache/apt on every RUN,
# defeating cache mounts. Remove it so the cache mount persists.
RUN rm -f /etc/apt/apt.conf.d/docker-clean

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        curl \
        xz-utils \
        build-essential \
        libssl-dev \
        zlib1g-dev \
        git \
        ca-certificates

# $TARGETARCH is set automatically by buildx (amd64 | arm64 | 386 | arm/v7).
# Previous version used `uname -m` which silently broke on multi-platform
# builds (always returned the kernel arch, not the requested target).
RUN case "$TARGETARCH" in \
        amd64)  LDC_ARCH=x86_64  ;; \
        arm64)  LDC_ARCH=aarch64 ;; \
        *) echo "Unsupported TARGETARCH: $TARGETARCH"; exit 1 ;; \
    esac && \
    mkdir -p /opt && \
    curl -fsSL -o /tmp/ldc.tar.xz \
        "https://github.com/ldc-developers/ldc/releases/download/v${LDC_VERSION}/ldc2-${LDC_VERSION}-linux-${LDC_ARCH}.tar.xz" && \
    tar -xf /tmp/ldc.tar.xz -C /opt && \
    ln -s "/opt/ldc2-${LDC_VERSION}-linux-${LDC_ARCH}" /opt/ldc2 && \
    rm /tmp/ldc.tar.xz

ENV PATH="/opt/ldc2/bin:${PATH}"
WORKDIR /build
# Every RUN below fails on the first failing command; /bin/sh (dash) has no pipefail.
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]


# ============================================================================
# Stage: builder-common — fetch deps + build the shared common library.
#
# `dub build --parallel` parallelizes LDC compile jobs within a config.
# Without `--force`, dub reuses the incremental module cache in the
# /build/.dub + /root/.dub cache mounts, so editing one file recompiles
# only that module.
# ============================================================================
FROM base AS builder-common

COPY common/dub.sdl common/dub.selections.json ./common/
COPY common/source/ ./common/source/

RUN --mount=type=cache,target=/build/.dub,sharing=locked \
    --mount=type=cache,target=/root/.dub,sharing=locked \
    dub build --root=common --compiler=ldc2 --build=release --parallel


# ============================================================================
# Stage: frontend-builder — vite build. `npm ci` gets its own layer keyed on
# the lockfile alone; sources are copied below it so an edit under src/
# reruns only `npm run build`.
# ============================================================================
FROM node:20-bookworm AS frontend-builder
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    cd frontend && npm ci --ignore-scripts
COPY frontend/bun.lock* frontend/tsconfig.json frontend/svelte.config.js frontend/vite.config.ts frontend/index.html frontend/admin.html frontend/postbuild.js ./frontend/
COPY frontend/src ./frontend/src/
COPY frontend/wasm-img2irc ./frontend/wasm-img2irc/
COPY public/ ./public/
RUN cd frontend && npm run build && \
    test -f ../public/dist/.vite/manifest.json


# ============================================================================
# Stage: builder-backend — gateway binary only (irc-fiber + irc-fiber-gateway)
# ============================================================================
FROM builder-common AS builder-backend

COPY backend/dub.sdl backend/dub.selections.json ./backend/
COPY backend/source/ ./backend/source/
# Diet templates are CTFE-compiled into the binary; they come straight from
# the context, not from the frontend stage — the shell has no build-time
# asset URLs in it any more.
COPY backend/views/ ./backend/views/

# `--config=gateway` was a second full backend compile whose output was
# discarded (the image ships the default-config binary under both names).
# Dropped in the split — see runtime-gateway.
RUN --mount=type=cache,target=/build/.dub,sharing=locked \
    --mount=type=cache,target=/root/.dub,sharing=locked \
    dub build --root=backend --compiler=ldc2 --build=release --parallel && \
    cp backend/irc-fiber ./irc-fiber && \
    cp backend/irc-fiber ./irc-fiber-gateway && \
    test -f ./irc-fiber
RUN strip ./irc-fiber ./irc-fiber-gateway


# ============================================================================
# Stage: runtime-gateway — slim Ubuntu + gateway binary only.
# COPYs come from builder-backend (never builder-engine), so building this
# target does NOT compile engine sources. config/views come from the build
# context so asset/config changes don't pull the builder stages.
# ============================================================================
FROM ubuntu:22.04 AS runtime-gateway

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        libssl3 \
        zlib1g \
        curl \
        ffmpeg \
        procps \
        ca-certificates \
        tini \
        util-linux && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Gateway binary under both names (both are the default-config binary today;
# the GatewayOnly config compile was dropped as dead work).
COPY --from=builder-backend /build/irc-fiber-gateway /app/irc-fiber-gateway
COPY --from=builder-backend /build/irc-fiber /app/irc-fiber
COPY --from=frontend-builder /build/public ./public/
# Views are CTFE-compiled into the binary and never read at runtime; they
# ship only for debugging.
COPY backend/views/ ./views/
COPY config/ ./config/
# Data dirs.
RUN mkdir -p /app/data /app/uploads && \
    if [ ! -f /app/irc-fiber ]; then echo "gateway binary missing" && exit 1; fi

EXPOSE 8090

ENTRYPOINT ["/usr/bin/tini", "--"]

# ── Build identity ─────────────────────────────────────────────────────────
# Last, after every COPY: an ENV-only layer is metadata — no pushed bytes and
# nothing above it is invalidated when the commit changes. The gateway reads
# these at runtime (ircfiber.build_info) for /api/version.
ARG GIT_HASH=dev
ARG GIT_SHORT=dev
ARG GIT_DESCRIBE=dev
ARG GIT_BRANCH=dev
ARG BUILD_TIME=dev
ARG GIT_MESSAGE=""
ENV IRCFIBER_VERSION=0.3.0 \
    IRCFIBER_BUILD_COMMIT=$GIT_HASH \
    IRCFIBER_BUILD_SHORT=$GIT_SHORT \
    IRCFIBER_BUILD_DESCRIBE=$GIT_DESCRIBE \
    IRCFIBER_BUILD_BRANCH=$GIT_BRANCH \
    IRCFIBER_BUILD_TIME=$BUILD_TIME \
    IRCFIBER_BUILD_HOST=builder \
    IRCFIBER_BUILD_MESSAGE=$GIT_MESSAGE \
    IRCFIBER_BUILD_COMMIT_URL=https://github.com/kevinpostal/ircfiber-site/commit/$GIT_HASH
LABEL org.opencontainers.image.revision=$GIT_HASH
