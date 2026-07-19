import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Получаем доступ к PrismaService
  const prismaService = app.get(PrismaService);

  // Создаем тестового пользователя, если таблица пустая
  const testUser = await prismaService.user.upsert({
    where: { email: 'admin@example.com' }, // или какой там у тебя email
    update: {},
    create: {
      email: 'admin@example.com',
      name: 'Vlad',
      passwordHash: 'qwerlkjh', // 👈 ДОБАВЬ СЮДА ЭТУ СТРОКУ
    },
  });

  console.log('----------------------------------------------------');
  console.log(`ТЕСТОВЫЙ USER ID ДЛЯ ЗАПРОСОВ: ${testUser.id}`);
  console.log('----------------------------------------------------');

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
