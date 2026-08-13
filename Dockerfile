FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --gid 10001 xsignal \
    && useradd --uid 10001 --gid xsignal --create-home xsignal \
    && mkdir -p /data \
    && chown xsignal:xsignal /data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER xsignal
EXPOSE 7345
CMD ["node", "dist/src/app.js"]
