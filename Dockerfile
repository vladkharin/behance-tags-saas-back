# --- Этап 1: Сборка ---
FROM node:22-bullseye AS builder

WORKDIR /app

# Системные зависимости
RUN apt-get update && apt-get install -y openssl python3 make g++

# Запрещаем скачивание браузера
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
COPY prisma ./prisma/

# Устанавливаем зависимости
RUN npm install

COPY . .

# Генерируем Prisma и собираем проект
RUN npx prisma generate
RUN npm run build

# Проверяем, куда NestJS положил файл (выведется в логах сборки)
RUN ls -R dist

# --- Этап 2: Запуск ---
FROM ghcr.io/puppeteer/puppeteer:23.0.2

USER root
WORKDIR /app

# Настройки для Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Копируем всё необходимое
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Даем права пользователю
RUN chown -R pptruser:pptruser /app

EXPOSE 3000

USER pptruser

# Попробуем запустить без .js (node сам найдет нужный файл в dist)
CMD ["node", "dist/main"]