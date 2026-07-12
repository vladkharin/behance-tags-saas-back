# Используем официальный образ Puppeteer
FROM ghcr.io/puppeteer/puppeteer:23.1.0

USER root
WORKDIR /app

# Настройки среды
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

COPY package*.json ./
COPY prisma ./prisma/

# Устанавливаем зависимости
RUN npm install

COPY . .

# Генерируем Prisma и собираем проект
RUN npx prisma generate
RUN npm run build

# Даем права пользователю
RUN chown -R pptruser:pptruser /app

EXPOSE 3000
USER pptruser

CMD ["node", "dist/src/main.js"]