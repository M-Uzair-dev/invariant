# syntax=docker/dockerfile:1

# ---- build stage: all deps, generate Prisma client, compile ----
FROM node:24-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npx nest build

# ---- runtime stage: prod deps + compiled output ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# RDS CA bundle. node-postgres treats sslmode=require as verify-full, so Node has to
# trust the RDS CA: NODE_EXTRA_CA_CERTS adds it to the default store.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /certs/rds-global-bundle.pem
RUN chmod 755 /certs && chmod 644 /certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/certs/rds-global-bundle.pem

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Migrations + CLI config, so the container can run `prisma migrate deploy` on start
COPY prisma ./prisma
COPY prisma.config.ts ./

# The Prisma client is generated into src/generated, so it's compiled into dist
COPY --from=build /app/dist ./dist

USER node
EXPOSE 3000
# Apply pending migrations, then start. exec replaces the shell with node, so
# docker stop's SIGTERM reaches node directly and enableShutdownHooks runs.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/src/main.js"]
