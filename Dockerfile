# secret-desk Portal als Container.
# Das Portal ist nur fuer localhost gedacht. Im Container lauscht es auf allen
# Schnittstellen, der Port wird deshalb nur an 127.0.0.1 des Hosts veroeffentlicht:
#   docker run --rm -p 127.0.0.1:4747:4747 -v secret-desk-data:/data ghcr.io/pineflight/secret-desk
FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm CI=1
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm run build

FROM node:24-slim
ENV NODE_ENV=production PNPM_HOME=/pnpm HOME=/data
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --from=build --chown=node:node /app /app
USER node
# Start ohne pnpm/corepack, damit der Container ohne Internet hochkommt.
WORKDIR /app/apps/desk
VOLUME /data
EXPOSE 4747
CMD ["./node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "4747"]
