FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY ops/prepare-assets.mjs ops/asset-lock.json ./ops/
RUN node ops/prepare-assets.mjs
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /build/dist ./dist
USER node
EXPOSE 18880
CMD ["node", "dist/service/main.js"]
