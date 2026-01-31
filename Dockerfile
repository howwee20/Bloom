FROM node:20-slim

WORKDIR /app

# Install native build dependencies for better-sqlite3 and curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

COPY . .

# API binds to 0.0.0.0:3000 by default
EXPOSE 3000

CMD ["pnpm", "start"]
