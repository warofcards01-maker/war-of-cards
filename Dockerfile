FROM node:22-bookworm-slim

WORKDIR /app

# 1. Copy package files first
COPY package.json package-lock.json* ./

# 2. Install dependencies (pg install avutundi ikkada)
RUN npm install

# 3. Copy the rest of the application files
COPY server.js game.js tournaments.js database.js setup.js ./
COPY public ./public

# 4. Create data directory and set permissions
RUN mkdir -p /app/data && chown -R node:node /app

# 5. Switch to non-root user
USER node

# Environment Variables
ENV PORT=3000
ENV NODE_ENV=production
ENV DATA_DIR=/app/data

EXPOSE 3000

CMD ["node", "server.js"]
