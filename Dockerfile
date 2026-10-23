# syntax=docker/dockerfile:1
# Talaia Hub in a container: the server and its screen. From the repository's root:
#   docker build -t talaia-hub .
# For linux/amd64 and linux/arm64. Nothing is compiled: the only native piece (serialport) comes prebuilt for both in
# its npm package, so the build stage runs on the building machine's own architecture and only the last stage is the
# target's. How to run it: docker/compose.yaml.

ARG NODE=24-bookworm-slim

FROM --platform=$BUILDPLATFORM node:${NODE} AS build
WORKDIR /src
COPY codigo/package.json codigo/package-lock.json ./
COPY codigo/nucleo/package.json nucleo/
COPY codigo/app/package.json app/
COPY codigo/servidor/package.json servidor/
RUN npm ci -w @talaia/app -w @talaia/servidor --omit=dev --no-audit --no-fund --loglevel=error
COPY codigo/nucleo nucleo
COPY codigo/app app
COPY codigo/servidor servidor
RUN npm run build -w @talaia/app --silent
# What the image carries: the server, the core, the built screen and only the server's dependencies.
RUN mkdir -p /out/app /out/dist \
 && cp -a package.json package-lock.json nucleo servidor /out/ \
 && cp app/package.json /out/app/ \
 && cp -a dist/app /out/dist/ \
 && rm -rf /out/servidor/test /out/servidor/sistema /out/servidor/instalar.sh /out/nucleo/test \
 && cd /out && npm ci -w @talaia/servidor --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error

FROM node:${NODE}
ARG VERSION=dev
LABEL org.opencontainers.image.title="Talaia Hub" \
      org.opencontainers.image.description="24/7 watch over Meshtastic nodes and MQTT devices, with alarms, history and Home Assistant" \
      org.opencontainers.image.source="https://github.com/Dani-NRos/talaia-hub" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}"
ENV NODE_ENV=production \
    TALAIA_DOCKER=1 \
    TALAIA_DATA=/data \
    TALAIA_CONFIG=/data/config.json
# The service's user, uid 4404 like its port (Mosquitto's image does the same with 1883), in dialout for the USB node.
RUN groupadd --system --gid 4404 talaia \
 && useradd --system --uid 4404 --gid talaia --groups dialout --home-dir /data --no-create-home --shell /usr/sbin/nologin talaia \
 && mkdir -p /data /broker \
 && chown talaia:talaia /data
COPY --from=build /out /opt/talaia
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/talaia-entrypoint
COPY --chmod=755 docker/talaia /usr/local/bin/talaia
VOLUME /data
EXPOSE 4404
HEALTHCHECK --interval=30s --timeout=6s --start-period=60s --start-interval=2s --retries=3 CMD ["talaia", "--salud"]
ENTRYPOINT ["talaia-entrypoint"]
CMD ["talaia"]
