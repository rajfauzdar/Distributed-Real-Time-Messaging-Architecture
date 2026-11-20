# ---- stage 1: build the React app ----
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- stage 2: slim runtime image (API + sockets + built frontend) ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY backend ./backend
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
USER node
EXPOSE 5000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD wget -qO- http://localhost:5000/healthz || exit 1
CMD ["node", "backend/server.js"]
