# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
# Copy .npmrc too (legacy-peer-deps) so install resolves React 19 peers.
# `npm install` (not `npm ci`) so the build is robust to a lockfile generated
# on another platform.
COPY package*.json .npmrc ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# ── Serve stage ──────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
