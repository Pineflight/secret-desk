# secret-desk browser sidecar: a real, headed Chromium on a virtual display, reachable from a normal web browser through
# noVNC, and drivable by secret-desk over the Chrome DevTools Protocol. Meant for a headless host such as a Raspberry Pi:
# the human signs in once per provider in the noVNC window, the profile (cookies) stays in the /profile volume.
#
#   docker build -t secret-desk-browser docker/browser
#
# Ports: 6080 noVNC (put it behind a reverse proxy with authentication), 9222 DevTools (compose network only, never publish).
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc novnc websockify socat curl ca-certificates \
      fonts-liberation fonts-noto-color-emoji dumb-init \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/share/novnc/vnc.html /usr/share/novnc/index.html \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin browser \
 && mkdir /profile && chown browser:browser /profile

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

LABEL org.opencontainers.image.title="secret-desk-browser" \
      org.opencontainers.image.description="Headed Chromium with noVNC and a DevTools endpoint for secret-desk browser automation" \
      org.opencontainers.image.source="https://github.com/Pineflight/secret-desk" \
      org.opencontainers.image.licenses="MIT"

USER browser
ENV HOME=/home/browser DISPLAY=:99
VOLUME /profile
EXPOSE 6080 9222
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:9223/json/version >/dev/null && curl -fsS http://127.0.0.1:6080/vnc.html >/dev/null || exit 1
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/entrypoint.sh"]
