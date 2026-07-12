# --- Этап 1: Сборка ---
FROM node:22-bullseye AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y openssl python3 make g++
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package*.json ./
COPY prisma ./prisma/
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build

# --- Этап 2: Запуск ---
FROM ghcr.io/puppeteer/puppeteer:23.0.2

USER root
WORKDIR /app

# Настройки для работы Puppeteer в Docker
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Копируем всё из билдера
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Даем права
RUN chown -R pptruser:pptruser /app

EXPOSE 3000
USER pptruser

# Запускаем из папки src внутри dist (как показал твой find)
CMD ["node", "dist/src/main.js"]