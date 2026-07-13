FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/prisma ./prisma
COPY --from=builder --chown=appuser:appgroup /app/config.json ./
COPY --from=builder --chown=appuser:appgroup /app/cli.ts ./cli.ts
COPY --from=builder --chown=appuser:appgroup /app/scripts ./scripts

RUN mkdir -p /app/logs && chown -R appuser:appgroup /app/logs

USER appuser

EXPOSE 3000

CMD ["node", "dist/main.js"]
