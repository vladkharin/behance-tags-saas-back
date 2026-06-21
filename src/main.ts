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
    origin: 'http://localhost:5173', // URL твоего React-клиента (Vite по умолчанию)
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true, // Нужно, если будешь передавать куки или заголовки авторизации
    allowedHeaders: 'Content-Type, Accept, Authorization',
  });

  await app.listen(3000);
}
bootstrap();
