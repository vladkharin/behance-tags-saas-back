# --- Этап 1: Сборка ---
FROM node:22-bullseye-slim AS builder

WORKDIR /app

# Устанавливаем системные зависимости для сборки и работы с архивами
RUN apt-get update && apt-get install -y \
    openssl \
    python3 \
    make \
    g++ \
    tar \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Запрещаем скачивание браузера на всех уровнях
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package*.json ./
COPY prisma ./prisma/

# Устанавливаем зависимости, игнорируя скрипты Puppeteer (чтобы он не лез качать Chrome)
RUN npm install --ignore-scripts

COPY . .

# Генерируем Prisma вручную (так как мы игнорировали скрипты)
RUN npx prisma generate
RUN npm run build

# --- Этап 2: Запуск (Prod) ---
FROM ghcr.io/puppeteer/puppeteer:latest

USER root
WORKDIR /app

# Повторяем запрет на скачивание
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Копируем результаты сборки
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/prisma ./prisma

# Указываем путь к Chrome, который УЖЕ есть в этом образе
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

EXPOSE 3000

# Запуск от имени специального пользователя для безопасности
USER pptruser

CMD ["node", "dist/main.js"]