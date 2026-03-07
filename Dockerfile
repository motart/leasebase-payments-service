FROM node:20-alpine AS builder
WORKDIR /app

# GitHub Packages auth for @leasebase/* scoped packages
ARG NODE_AUTH_TOKEN
COPY .npmrc package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -g 1001 -S appgroup && adduser -S appuser -u 1001

# Copy only production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Remove .npmrc so token doesn't leak into runtime image
USER appuser
EXPOSE 3000
CMD ["node", "dist/index.js"]
