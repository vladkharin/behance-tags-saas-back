import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { RobokassaService } from './robokassa.service';
import { ConfigModule } from '@nestjs/config';
import { LavaService } from './lava.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [BillingController],
  providers: [RobokassaService, LavaService],
  exports: [RobokassaService, LavaService],
})
export class BillingModule {}
