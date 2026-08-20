# The service image.
#
# Multi-stage, and the stages exist for different reasons. The build stage needs the whole
# workspace and every dev dependency; the runtime stage needs none of it, and shipping it would
# mean shipping a TypeScript compiler and a test runner into production.
#
# The toolchain is baked in rather than reached for through the host's Docker socket. Mounting that
# socket is the usual shortcut for "my container needs to run a container", and it hands the
# container root on the host -- an unattractive trade for the ability to compile a sketch.

# --- toolchain -----------------------------------------------------------------------------------
# arduino-cli and the AVR core, pinned. Compilation has to be hermetic and reproducible: the golden
# firmware tests assert exact bytes, and a core downloaded at run time would drift out from under
# them.
FROM debian:bookworm-slim AS toolchain

ARG ARDUINO_CLI_VERSION=1.3.1
ARG AVR_CORE_VERSION=1.8.6

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
      | BINDIR=/usr/local/bin sh -s ${ARDUINO_CLI_VERSION} \
 && arduino-cli version

ENV ARDUINO_DIRECTORIES_DATA=/opt/arduino/data \
    ARDUINO_DIRECTORIES_DOWNLOADS=/opt/arduino/downloads \
    ARDUINO_DIRECTORIES_USER=/opt/arduino/user

RUN arduino-cli core update-index \
 && arduino-cli core install arduino:avr@${AVR_CORE_VERSION} \
 && arduino-cli core list \
 # Downloads are the unpacked archives; keeping them doubles the layer for nothing.
 && rm -rf /opt/arduino/downloads

# --- build ---------------------------------------------------------------------------------------
FROM node:26-bookworm-slim AS build
WORKDIR /app

# Manifests first, so `npm ci` is only re-run when a dependency actually changes rather than on
# every source edit.
COPY package.json package-lock.json ./
COPY packages/sim-core/package.json    packages/sim-core/
COPY packages/parts/package.json       packages/parts/
COPY packages/assistant/package.json   packages/assistant/
COPY packages/datasheet/package.json   packages/datasheet/
COPY packages/accounts/package.json    packages/accounts/
COPY packages/compile-service/package.json packages/compile-service/
COPY apps/studio/package.json          apps/studio/
RUN npm ci

COPY tsconfig*.json ./
COPY packages/ packages/
COPY apps/ apps/

RUN npm run build \
 && npm run build -w @robo-journey/studio

# Reinstall without dev dependencies, into a tree that is copied wholesale into the runtime image.
RUN npm ci --omit=dev

# --- runtime -------------------------------------------------------------------------------------
FROM node:26-bookworm-slim AS runtime

# The toolchain needs python3 at run time; nothing else from the build image is carried over.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=toolchain /usr/local/bin/arduino-cli /usr/local/bin/arduino-cli
COPY --from=toolchain /opt/arduino /opt/arduino

# The root filesystem is read-only, and arduino-cli wants three writable directories regardless:
# somewhere to download to even with nothing to download, a user directory, and a build cache under
# the XDG cache path. All three point at the tmpfs, so the container still cannot write to its own
# application directory. The core it compiles against stays in /opt/arduino/data, which it reads.
ENV ARDUINO_DIRECTORIES_DATA=/opt/arduino/data \
    ARDUINO_DIRECTORIES_DOWNLOADS=/tmp/arduino/downloads \
    ARDUINO_DIRECTORIES_USER=/tmp/arduino/user \
    XDG_CACHE_HOME=/tmp/cache \
    NODE_ENV=production \
    RJ_COMPILER_MODE=local \
    RJ_STATIC_DIR=/app/public

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/sim-core/dist        ./packages/sim-core/dist
COPY --from=build /app/packages/sim-core/package.json ./packages/sim-core/
COPY --from=build /app/packages/parts/dist           ./packages/parts/dist
COPY --from=build /app/packages/parts/package.json   ./packages/parts/
COPY --from=build /app/packages/assistant/dist       ./packages/assistant/dist
COPY --from=build /app/packages/assistant/package.json ./packages/assistant/
COPY --from=build /app/packages/datasheet/dist       ./packages/datasheet/dist
COPY --from=build /app/packages/datasheet/package.json ./packages/datasheet/
COPY --from=build /app/packages/accounts/dist        ./packages/accounts/dist
COPY --from=build /app/packages/accounts/package.json ./packages/accounts/
COPY --from=build /app/packages/compile-service/dist ./packages/compile-service/dist
COPY --from=build /app/packages/compile-service/package.json ./packages/compile-service/
COPY --from=build /app/apps/studio/dist              ./public

# The compiler writes each sketch to a temporary directory, so the account needs somewhere to
# write -- but nowhere else. Running as root inside a container is the default and is worth
# undoing: a process that only ever compiles a sketch has no reason to be able to modify its own
# application code.
RUN useradd --system --create-home --uid 10001 robo \
 && chown -R robo:robo /opt/arduino
USER robo

EXPOSE 28610

# Container-level liveness. Deliberately /health and not /ready: restarting a container because
# Postgres blinked turns one dependency's bad minute into a crash loop across every instance.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RJ_SERVICE_PORT||28610)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node as PID 1 with an explicit signal handler in the app, rather than through a shell that would
# swallow SIGTERM and make every deploy wait for the kill timeout.
CMD ["node", "packages/compile-service/dist/main.js"]
