# Rundan backend — Express + Mongoose + Socket.IO
FROM node:20-alpine

WORKDIR /app

# Install production deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Uploads live on a mounted volume in production; create the default dir.
RUN mkdir -p /app/uploads

ENV NODE_ENV=production
EXPOSE 5000

# Lightweight healthcheck hitting the public health route.
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:5000/api/health || exit 1

CMD ["node", "server.js"]
