# xiao.sh TUI server (web :8787 + ssh :2222) on Bun.
FROM oven/bun:1
WORKDIR /app

# deps first for layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# app source (see .dockerignore for exclusions)
COPY . .

ENV NODE_ENV=production PORT=8787 SSH_PORT=2222
EXPOSE 8787 2222
CMD ["bun", "run", "start"]
