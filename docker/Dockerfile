FROM node:22-alpine AS build
WORKDIR /app
# better-sqlite3 i @node-rs/argon2 wymagają narzędzi budowania na etapie instalacji.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# Adres źródeł w etykiecie wiąże obraz z repozytorium także przy budowaniu lokalnym;
# pozostałe etykiety OCI (wersja, commit) dokłada workflow wydania.
LABEL org.opencontainers.image.source="https://github.com/sqlik/multiinfo-gate"
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
