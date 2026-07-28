import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { PrismaService } from '../prisma/prisma.service'; // Убедись, что путь правильный
import { RobokassaService } from './robokassa.service';
import { ConfigModule } from '@nestjs/config';
import { LavaService } from './lava.service';

@Module({
  imports: [ConfigModule],
  controllers: [BillingController],
  providers: [RobokassaService, PrismaService, LavaService],
  exports: [RobokassaService], // Экспортируем, если понадобится в других модулях
})
export class BillingModule {}
