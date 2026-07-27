import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { RobokassaService } from './robokassa.service';
import { PLANS_CONFIG, FUEL_CONFIG } from './billing.constants';
import { PrismaService } from 'src/prisma/prisma.service';

@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

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
    this.logger.log(
      `[Create Payment] Запрос от пользователя ${userId} на ${type}:${target}`,
    );

    // Определяем цену
    const config = type === 'PLAN' ? PLANS_CONFIG[target] : FUEL_CONFIG[target];
    if (!config) {
      this.logger.error(`[Create Payment] Неверная цель платежа: ${target}`);
      throw new BadRequestException('Invalid target');
    }

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

    this.logger.log(
      `[Create Payment] Создан платеж в базе. ID: ${payment.id}, OrderNumber: ${payment.orderNumber}`,
    );

    // Генерируем URL
    const url = this.robokassa.generatePaymentUrl(
      userId,
      config.price,
      payment.orderNumber,
      config.label,
    );

    return { url };
  }

  // 2. WEBHOOK от Робокассы
  @Post('robokassa/result')
  async robokassaResult(@Body() body: any) {
    this.logger.log('--- [Robokassa Webhook] ПРИШЕЛ ЗАПРОС ---');
    this.logger.log(`[Robokassa Webhook] Payload: ${JSON.stringify(body)}`);

    const { OutSum, InvId, SignatureValue, shp_userId } = body;

    // 1. Проверяем подпись
    const isValid = this.robokassa.verifySignature(
      OutSum,
      InvId,
      SignatureValue,
      shp_userId,
    );

    if (!isValid) {
      this.logger.error(
        '[Robokassa Webhook] Неверная подпись (SignatureValue)',
      );
      return 'bad sign';
    }

    // 2. Ищем платеж
    const payment = await this.prisma.payment.findUnique({
      where: { orderNumber: Number(InvId) },
      include: { user: true },
    });

    if (!payment) {
      this.logger.error(
        `[Robokassa Webhook] Платеж с InvId ${InvId} не найден в базе данных`,
      );
      return `error: payment not found`;
    }

    if (payment.status === 'SUCCESS') {
      this.logger.warn(
        `[Robokassa Webhook] Платеж ${InvId} уже был обработан ранее`,
      );
      return `OK${InvId}`;
    }

    this.logger.log(
      `[Robokassa Webhook] Платеж найден. Пользователь: ${payment.user.email}, Сумма: ${OutSum}`,
    );

    // 3. Определяем, что начислять
    const config =
      payment.type === 'PLAN'
        ? PLANS_CONFIG[payment.targetName]
        : FUEL_CONFIG[payment.targetName];

    try {
      this.logger.log(
        `[Robokassa Webhook] Начинаю начисление: +${config.tags} тегов`,
      );

      await this.prisma.$transaction([
        // Обновляем статус платежа
        this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'SUCCESS', externalId: String(InvId) },
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

      this.logger.log(
        `[Robokassa Webhook] ✅ УСПЕХ: Баланс пользователя ${payment.user.email} обновлен`,
      );
      return `OK${InvId}`;
    } catch (error) {
      this.logger.error(
        `[Robokassa Webhook] ❌ ОШИБКА ПРИ ОБНОВЛЕНИИ БАЗЫ: ${error.message}`,
      );
      return 'error internal';
    }
  }
}
