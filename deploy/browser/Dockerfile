FROM mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07

USER root
ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DISPLAY=:99
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl fluxbox novnc tini websockify x11vnc xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/x-signal-browser /data/profile /data/.vnc \
    && chown -R pwuser:pwuser /opt/x-signal-browser /data

WORKDIR /opt/x-signal-browser
RUN npm init -y >/dev/null \
    && npm install --omit=dev --save-exact playwright-core@1.62.0 \
    && npm cache clean --force
COPY --chown=pwuser:pwuser deploy/browser/launcher.mjs ./launcher.mjs
COPY deploy/browser/entrypoint.sh ./entrypoint.sh
RUN sed -i 's/\r$//' ./entrypoint.sh \
    && chmod 0755 ./entrypoint.sh

EXPOSE 6080 9222 9223
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/x-signal-browser/entrypoint.sh"]
