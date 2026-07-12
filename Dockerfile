# --- Этап 1: Сборка ---
FROM node:20-bullseye AS builder
WORKDIR /app
# Запрещаем скачивание браузера на этапе сборки
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
COPY prisma ./prisma/
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build

# --- Этап 2: Запуск ---
# Используем образ Puppeteer v21
FROM ghcr.io/puppeteer/puppeteer:21.11.0

USER root
WORKDIR /app

# Настройки среды
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

COPY package*.json ./
COPY prisma ./prisma/
# Устанавливаем зависимости заново для Linux
RUN npm install --omit=dev

# Копируем билд
COPY --from=builder /app/dist ./dist

RUN chown -R pptruser:pptruser /app
EXPOSE 3000
USER pptruser

# Запускаем через правильный путь
CMD ["node", "dist/src/main.js"]