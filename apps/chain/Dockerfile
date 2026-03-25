FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace manifests for dependency install
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/chain/package.json ./apps/chain/
RUN npm install

# Build shared package first (chain depends on its type declarations)
COPY packages/shared/src ./packages/shared/src
COPY packages/shared/tsconfig.json ./packages/shared/
RUN npm run build -w @lagrangefi/shared

# Build chain
COPY apps/chain/src ./apps/chain/src
COPY apps/chain/tsconfig.json ./apps/chain/
RUN npm run build -w @lagrangefi/chain

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy workspace manifests for prod install
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/chain/package.json ./apps/chain/
RUN npm install --omit=dev

# Copy built artifacts
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/apps/chain/dist ./apps/chain/dist

EXPOSE 3001
WORKDIR /app/apps/chain
CMD ["node", "dist/index.js"]
