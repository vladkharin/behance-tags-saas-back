# --- Этап 1: Сборка ---
FROM node:20-slim AS builder

WORKDIR /app

# Устанавливаем зависимости для сборки (нужны для Prisma и некоторых модулей)
RUN apt-get update && apt-get install -y openssl python3 make g++

COPY package*.json ./
COPY prisma ./prisma/

# Устанавливаем ВСЕ зависимости (включая dev)
RUN npm install

# Копируем исходный код
COPY . .

# Генерируем клиент Prisma и собираем проект
RUN npx prisma generate
RUN npm run build

# --- Этап 2: Запуск (Prod) ---
FROM ghcr.io/puppeteer/puppeteer:22.10.0

USER root
WORKDIR /app

# Копируем из первого этапа только то, что нужно для работы
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Проверяем права (на всякий случай)
RUN chown -R pptruser:pptruser /app

# Переключаемся на пользователя puppeteer для безопасности
USER pptruser

EXPOSE 3000

# Запуск через node напрямую (так стабильнее в Docker)
CMD ["node", "dist/main"]