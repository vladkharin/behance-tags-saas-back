import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { RobokassaService } from './robokassa.service';
import { PLANS_CONFIG, FUEL_CONFIG } from './billing.constants';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('billing')
export class BillingController {
  constructor(
    private prisma: PrismaService,
    private robokassa: RobokassaService,
  ) {}

  // 1. Фронтенд просит ссылку на оплату
  @Post('create-payment')
  async createPayment(
    @Body() body: { userId: string; target: string; type: 'PLAN' | 'FUEL' },
  ) {
    const { userId, target, type } = body;

    // Определяем цену
    const config = type === 'PLAN' ? PLANS_CONFIG[target] : FUEL_CONFIG[target];
    if (!config) throw new BadRequestException('Invalid target');

    // Создаем запись в таблице Payment (статус PENDING)
    const payment = await this.prisma.payment.create({
      data: {
        userId,
        amount: config.price,
        provider: 'ROBOKASSA',
        type,
        targetName: target,
        status: 'PENDING',
      },
    });

    // Генерируем URL (в качестве InvId передаем ID платежа из нашей базы)
    const url = this.robokassa.generatePaymentUrl(
      userId,
      config.price,
      payment.orderNumber,
      config.label,
    );

    return { url };
  }

  // 2. WEBHOOK от Робокассы (сюда они шлют POST запрос)
  @Post('robokassa/result')
  async robokassaResult(@Body() body: any) {
    const { OutSum, InvId, SignatureValue, shp_userId } = body;

    // Проверяем, что это реальная Робокасса, а не хакер
    const isValid = this.robokassa.verifySignature(
      OutSum,
      InvId,
      SignatureValue,
      shp_userId,
    );
    if (!isValid) return 'bad sign';

    // Находим платеж в нашей базе
    const payment = await this.prisma.payment.findUnique({
      where: { orderNumber: Number(InvId) },
      include: { user: true },
    });

    if (!payment || payment.status === 'SUCCESS') return `OK${InvId}`;

    // НАЧИСЛЯЕМ ЛИМИТЫ
    const config =
      payment.type === 'PLAN'
        ? PLANS_CONFIG[payment.targetName]
        : FUEL_CONFIG[payment.targetName];

    await this.prisma.$transaction([
      // Обновляем статус платежа
      this.prisma.payment.update({
        where: { id: InvId },
        data: { status: 'SUCCESS', externalId: InvId },
      }),
      // Обновляем баланс юзера и его план
      this.prisma.user.update({
        where: { id: shp_userId },
        data: {
          plan:
            payment.type === 'PLAN'
              ? (payment.targetName as any)
              : payment.user.plan,
          tagBalance: { increment: config.tags },
          planExpiresAt:
            payment.type === 'PLAN'
              ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
              : payment.user.planExpiresAt,
        },
      }),
    ]);

    return `OK${InvId}`; // Робокасса требует такой ответ
  }
}
