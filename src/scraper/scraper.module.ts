import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ScraperService } from './scraper.service';
import { ScraperController } from './scraper.controller';
import { ScraperProcessor } from './scraper.processor';
import { PrismaModule } from '../prisma/prisma.module'; // <-- Добавь этот импорт (путь может немного отличаться, проверь у себя)

@Module({
  imports: [
    PrismaModule, // <-- Добавь PrismaModule сюда, чтобы ScraperService видел PrismaService!

    // Конфигурируем подключение к Redis
    BullModule.forRoot({
      connection: {
        host: 'localhost',
        port: 6379,
      },
    }),
    // Регистрируем саму очередь задач
    BullModule.registerQueue({
      name: 'scraper-queue',
    }),
  ],
  controllers: [ScraperController],
  providers: [ScraperService, ScraperProcessor],
  exports: [ScraperService],
})
export class ScraperModule {}
