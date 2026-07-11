# Используем образ с установленным Chromium и зависимостями
FROM ghcr.io/puppeteer/puppeteer:22.10.0

USER root

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем конфиги зависимостей
COPY package*.json ./
COPY yarn.lock ./

# Устанавливаем зависимости (пропускаем установку встроенного браузера, он уже есть в образе)
RUN npm install

# Копируем весь код проекта
COPY . .

# Генерируем клиент Prisma
RUN npx prisma generate

# Собираем проект
RUN npm run build

# Открываем порт NestJS
EXPOSE 3000

# Запуск приложения
CMD ["npm", "run", "start:prod"]