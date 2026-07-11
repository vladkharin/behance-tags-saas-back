# --- Этап 1: Сборка ---
FROM node:22-slim AS builder

WORKDIR /app

# Устанавливаем системные зависимости для Prisma
RUN apt-get update && apt-get install -y openssl python3 make g++

# Отключаем загрузку браузера при npm install (сэкономит время и место)
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
COPY prisma ./prisma/

# Устанавливаем зависимости
RUN npm install

# Копируем исходный код
COPY . .

# Генерируем клиент Prisma и собираем проект
RUN npx prisma generate
RUN npm run build

# --- Этап 2: Запуск (Prod) ---
# Используем свежий образ Puppeteer, подходящий под Node 22
FROM ghcr.io/puppeteer/puppeteer:23.0.2

USER root
WORKDIR /app

# Отключаем загрузку браузера и здесь
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Копируем из первого этапа только то, что нужно
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# На сервере Puppeteer должен использовать системный Chrome, установленный в этом образе
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

EXPOSE 3000

# Запуск через пользователя pptruser для безопасности
USER pptruser

CMD ["node", "dist/main"]