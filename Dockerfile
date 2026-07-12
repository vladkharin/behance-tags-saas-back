# --- Этап 1: Сборка ---
FROM node:22-bullseye AS builder
WORKDIR /app
# Запрещаем скачивание браузера при npm install
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN apt-get update && apt-get install -y openssl python3 make g++
COPY package*.json ./
COPY prisma ./prisma/
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build

# --- Этап 2: Запуск ---
FROM ghcr.io/puppeteer/puppeteer:23.1.0
USER root
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
COPY package*.json ./
COPY prisma ./prisma/
# Устанавливаем только продакшн зависимости
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist
RUN chown -R pptruser:pptruser /app
EXPOSE 3000
USER pptruser
CMD ["node", "dist/src/main.js"]