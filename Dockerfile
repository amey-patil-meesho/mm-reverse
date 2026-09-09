# MM Reverse — single linux/amd64 image: one Node process serves the built React SPA + /api.
# node:sqlite is built into Node 24, so there is no native module to compile.

# ---- Frontend build (Vite → static assets) ----
FROM node:24-bookworm-slim AS frontend-build
# Office network (Netskope) intercepts TLS; trust its CA so npm can download.
COPY corporate-ca.crt /usr/local/share/ca-certificates/corporate-ca.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/corporate-ca.crt
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# ---- Backend deps (pure JS: express, cors) ----
FROM node:24-bookworm-slim AS backend-build
COPY corporate-ca.crt /usr/local/share/ca-certificates/corporate-ca.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/corporate-ca.crt
WORKDIR /build/backend
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY backend/ ./

# ---- Runtime ----
FROM node:24-bookworm-slim
WORKDIR /app/backend
COPY --from=backend-build /build/backend ./
COPY --from=frontend-build /build/frontend/dist ./public
ENV NODE_ENV=production
ENV PORT=9080
# Deployed demo runs on the safe sample seed (the real export with customer_ids is not baked in).
ENV SEED_CSV=/app/backend/seed/sample_pp_pc.csv
# Admin (data downloads) restricted to Amey; rotate ADMIN_ACCESS_CODE after judging.
ENV ADMIN_EMAILS=amey.patil1@meesho.com
ENV ADMIN_ACCESS_CODE=mmreverse-admin
# To auto-pull live data instead of the sample, set at deploy time:
#   METABASE_API_KEY=... METABASE_URL=... (and optionally GSHEET_ID + GOOGLE_SA_* for the sheet)
EXPOSE 9080
CMD ["node", "src/server.js"]
