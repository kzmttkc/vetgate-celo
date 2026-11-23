FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY contracts ./contracts
COPY src ./src
COPY tsconfig.json ./
COPY foundry.toml ./

EXPOSE 8080
CMD ["npx", "tsx", "src/server.ts"]