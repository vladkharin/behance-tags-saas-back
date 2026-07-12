# --- Этап 1: Сборка ---
FROM node:22-bullseye AS builder
WORKDIR /app

# Устанавливаем системные зависимости для Prisma
RUN apt-get update && apt-get install -y openssl python3 make g++

# Запрещаем скачивание браузера при установке пакетов
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package*.json ./
COPY prisma ./prisma/

# Устанавливаем ВСЕ зависимости для сборки
RUN npm install

COPY . .

# Генерируем Prisma и билдим проект
RUN npx prisma generate
RUN npm run build

# --- Этап 2: Запуск ---
# Используем официальный образ Puppeteer (там Node 22 и Chrome уже внутри)
FROM ghcr.io/puppeteer/puppeteer:23.1.0

USER root
WORKDIR /app

# Настройки среды
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

# Копируем конфиги
COPY package*.json ./
COPY prisma ./prisma/

# Устанавливаем только чистые продакшн-зависимости прямо здесь
# Это гарантирует, что все бинарные связи (Prisma, Puppeteer) будут работать в Linux
RUN npm install --omit=dev

# Копируем готовый билд из первого этапа
COPY --from=builder /app/dist ./dist

# Даем права пользователю
RUN chown -R pptruser:pptruser /app

EXPOSE 3000
USER pptruser

# Запускаем через исправленный путь
CMD ["node", "dist/src/main.js"]