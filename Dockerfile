# --- Этап 1: Сборка ---
FROM node:22-bullseye AS builder

WORKDIR /app

# Системные зависимости для Prisma
RUN apt-get update && apt-get install -y openssl python3 make g++

# Запрещаем скачивание браузера на этапе сборки
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

COPY package*.json ./
COPY prisma ./prisma/

# Устанавливаем зависимости (здесь НЕ игнорируем скрипты, чтобы Prisma сгенерировалась)
RUN npm install

COPY . .

# Генерируем Prisma и собираем проект
RUN npx prisma generate
RUN npm run build

# --- Этап 2: Запуск ---
FROM ghcr.io/puppeteer/puppeteer:23.0.2

USER root
WORKDIR /app

# Копируем из builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Проверяем что файлы скопировались (увидим в логах сборки)
RUN ls -R dist

# Настройки Puppeteer для работы внутри Docker
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Даем права
RUN chown -R pptruser:pptruser /app

EXPOSE 3000

USER pptruser

# Запускаем через node напрямую
CMD ["node", "dist/main"]