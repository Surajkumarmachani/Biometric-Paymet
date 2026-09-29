# REGAL LAB API — container for Google Cloud Run.
#
# Next.js "standalone" output: the build traces exactly the files the server
# needs, so the runtime image carries no dev dependencies and no source.
#
# No secrets and no keys go into this image. Everything is read from the
# environment when the container starts (Cloud Run: Variables & Secrets), so
# one image serves test and live keys alike and a key rotation is a restart,
# not a rebuild. NEXT_PUBLIC_* values are deliberately NOT set at build time:
# Next only inlines the ones present during `next build`, so the server code
# that reads them (Clerk, Razorpay key id) falls back to runtime env. The one
# browser-only use — Supabase Realtime on the terminal tile — is optional and
# belongs to the website on Vercel, not to this API.

# ---- deps: install exactly the lockfile -------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080

# Run as the image's unprivileged `node` user, never root.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node

EXPOSE 8080
# Cloud Run sends PORT; Next's standalone server reads PORT and HOSTNAME.
CMD ["node", "server.js"]
