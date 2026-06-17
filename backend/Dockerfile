# Gamedo backend — Express + Mongoose + Socket.IO
FROM node:20-alpine

WORKDIR /app

# Install production deps first for better layer caching. `npm install` (not
# `npm ci`) so the build is robust to a lockfile generated on another platform.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# Uploads live on a mounted volume in production; create the default dir.
RUN mkdir -p /app/uploads

ENV NODE_ENV=production
EXPOSE 5000

# Lightweight healthcheck hitting the public health route.
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/api/health || exit 1

CMD ["node", "server.js"]
