import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit() {
    // Подключаемся к базе при старте приложения
    await this.$connect();
  }

  async onModuleDestroy() {
    // Отключаемся от базы при остановке
    await this.$disconnect();
  }
}
