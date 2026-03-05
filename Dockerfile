FROM node:20-alpine AS builder
WORKDIR /app
COPY packages/service-common /app/packages/service-common
WORKDIR /app/packages/service-common
RUN npm ci && npm run build
WORKDIR /app/service
COPY leasebase-payments-service/package.json leasebase-payments-service/package-lock.json* ./
RUN npm ci
COPY leasebase-payments-service/tsconfig.json ./
COPY leasebase-payments-service/src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001
COPY --from=builder /app/packages/service-common /app/packages/service-common
COPY --from=builder /app/service/dist ./dist
COPY --from=builder /app/service/node_modules ./node_modules
COPY --from=builder /app/service/package.json ./
USER appuser
EXPOSE 3000
CMD ["node", "dist/index.js"]
