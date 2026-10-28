# Build: install everything, generate the Prisma client, compile, then drop dev dependencies.
FROM node:24-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx prisma generate && npm run build && npm prune --omit=dev

# Runtime: only compiled code, production dependencies and the migrations.
FROM node:24-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
USER node
EXPOSE 3000
# Migrations run on boot because Render's free plan has no pre-deploy step.
# exec makes node PID 1, so it receives SIGTERM and shuts down cleanly.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node dist/server.js"]
