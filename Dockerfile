FROM node:22-slim

# Устанавливаем системные зависимости для работы Puppeteer (Chromium) внутри Linux
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Создаем рабочую директорию
WORKDIR /app

# Копируем файлы зависимостей
COPY package.json yarn.lock ./

# Устанавливаем зависимости через Yarn
RUN yarn install --frozen-lockfile

# Копируем схему Prisma и генерируем клиент
COPY prisma ./prisma/
RUN npx prisma generate

# Копируем весь остальной код и собираем проект
COPY . .
RUN yarn build

# Открываем порт
EXPOSE 3000

# Команда запуска (миграции + старт приложения)
CMD ["sh", "-c", "npx prisma migrate deploy && yarn start:prod"]