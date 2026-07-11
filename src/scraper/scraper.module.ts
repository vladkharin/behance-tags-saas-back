// src/scraper/scraper.module.ts

import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs'; // Импорт
import { ExpressAdapter } from '@bull-board/express'; // Импорт
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'; // Импорт адаптера
import { ScraperService } from './scraper.service';
import { ScraperController } from './scraper.controller';
import { ScraperProcessor } from './scraper.processor';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule, ConfigService } from '@nestjs/config';

@Module({
  imports: [
    PrismaModule,

    // 1. Конфигурируем подключение к Redis
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST') || 'localhost',
          port: config.get<number>('REDIS_PORT') || 6379,
        },
      }),
      inject: [ConfigService],
    }),

    // 2. Регистрируем саму очередь задач
    BullModule.registerQueue({
      name: 'scraper-queue',
    }),

    // 3. Инициализируем глобальный UI админки
    BullBoardModule.forRoot({
      route: '/admin/queues', // Адрес: http://localhost:3000/admin/queues
      adapter: ExpressAdapter,
    }),

    // 4. Добавляем нашу конкретную очередь в этот UI
    BullBoardModule.forFeature({
      name: 'scraper-queue',
      adapter: BullMQAdapter,
    }),

    ConfigModule,
  ],
  controllers: [ScraperController],
  providers: [ScraperService, ScraperProcessor],
  exports: [ScraperService],
})
export class ScraperModule {}
