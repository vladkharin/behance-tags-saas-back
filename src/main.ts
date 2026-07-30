import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(json({ limit: '10mb' }));

  app.enableCors({
    origin: [
      'https://beranked.domcraft.digital', // Твой боевой фронтенд
      'http://localhost:5173', // Локалка Vite
      'http://localhost:3000', // Локалка (на случай смены порта)
      'http://127.0.0.1:5173', // Иногда браузер использует IP вместо localhost
    ], // URL твоего React-клиента (Vite по умолчанию)
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true, // Нужно, если будешь передавать куки или заголовки авторизации
    allowedHeaders: 'Content-Type, Accept, Authorization',
  });

  await app.listen(3000);
}
bootstrap();
