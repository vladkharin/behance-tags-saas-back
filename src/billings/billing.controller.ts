import {
  Controller,
  Post,
  Body,
  BadRequestException,
  Logger,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { RobokassaService } from './robokassa.service';
import { PLANS_CONFIG, FUEL_CONFIG } from './billing.constants';
import { PrismaService } from 'src/prisma/prisma.service';
import { LavaService } from './lava.service';
import { ConfigService } from '@nestjs/config';

@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private prisma: PrismaService,
    private robokassa: RobokassaService,
    private lavatop: LavaService,
    private configService: ConfigService, // Добавили для доступа к Offer ID
  ) {}

  // 1. Создание платежа (Универсальный метод для Робокассы и Лавы)
  @Post('create-payment')
  async createPayment(
    @Body()
    body: {
      userId: string;
      target: string;
      type: 'PLAN' | 'FUEL';
      currency: 'RUB' | 'USD' | 'EUR';
    },
  ) {
    const { userId, target, type, currency } = body;
    this.logger.log(
      `[Create Payment] Запрос: User ${userId}, Target: ${target}, Currency: ${currency}`,
    );

    // Находим пользователя, так как для Лавы нам нужен его Email
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    // Определяем конфиг (цены/теги)
    const config = type === 'PLAN' ? PLANS_CONFIG[target] : FUEL_CONFIG[target];
    if (!config) throw new BadRequestException('Invalid target');

    // --- ЛОГИКА ДЛЯ РУБЛЕЙ (ROBOKASSA) ---
    if (currency === 'RUB') {
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

      const url = this.robokassa.generatePaymentUrl(
        userId,
        config.price,
        payment.orderNumber,
        config.label,
      );

      return { url };
    }

    // --- ЛОГИКА ДЛЯ USD/EUR (LAVA API v3) ---
    else {
      // Вытаскиваем нужный Offer ID из .env (например: LAVA_OFFER_ID_PRO_STREAM)
      const envKey = `LAVA_OFFER_ID_${target}`;
      const offerId = this.configService.get<string>(envKey);

      if (!offerId) {
        this.logger.error(
          `[Lava API] Offer ID не найден в .env для ключа: ${envKey}`,
        );
        throw new BadRequestException('Payment provider configuration error');
      }

      // Определяем цену для Лавы (если в конфиге нет отдельной цены под USD, берем базовую)
      const amount =
        target === 'DAILY_FRESH'
          ? 9.99
          : target === 'PRO_STREAM'
            ? 24.99
            : target === '500'
              ? 2.99
              : 6.99;

      try {
        // Создаем инвойс через API v3
        const url = await this.lavatop.createInvoice(
          user.email,
          offerId,
          amount,
          currency,
        );

        this.logger.log(`[Lava API] Ссылка создана для ${user.email}: ${url}`);
        return { url };
      } catch (err) {
        this.logger.error(`[Lava API] Ошибка создания счета: ${err.message}`);
        throw new BadRequestException('Lava.top API error');
      }
    }
  }

  // 2. WEBHOOK от Робокассы
  @Post('robokassa/result')
  async robokassaResult(@Body() body: any) {
    this.logger.log('--- [Robokassa Webhook] ПРИШЕЛ ЗАПРОС ---');
    this.logger.log(`Payload: ${JSON.stringify(body)}`);

    const { OutSum, InvId, SignatureValue, shp_userId } = body;

    const isValid = this.robokassa.verifySignature(
      OutSum,
      InvId,
      SignatureValue,
      shp_userId,
    );
    if (!isValid) return 'bad sign';

    const payment = await this.prisma.payment.findUnique({
      where: { orderNumber: Number(InvId) },
      include: { user: true },
    });

    if (!payment || payment.status === 'SUCCESS') return `OK${InvId}`;

    const config =
      payment.type === 'PLAN'
        ? PLANS_CONFIG[payment.targetName]
        : FUEL_CONFIG[payment.targetName];

    try {
      await this.prisma.$transaction([
        this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'SUCCESS', externalId: String(InvId) },
        }),
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
      return `OK${InvId}`;
    } catch (error) {
      return 'error internal';
    }
  }

  // 3. WEBHOOK от Lava.top (v3)
  @Post('lava/webhook')
  async lavaWebhook(
    @Body() body: any,
    @Headers('authorization') authHeader: string,
  ) {
    this.logger.log('--- [Lava Webhook] ПРИШЕЛ ЗАПРОС ---');
    this.logger.log(`Payload: ${JSON.stringify(body)}`);

    // Проверка Basic Auth
    const expectedAuth = `Basic ${Buffer.from(`${process.env.LAVA_WEBHOOK_LOGIN}:${process.env.LAVA_WEBHOOK_PASSWORD}`).toString('base64')}`;
    if (!authHeader || authHeader !== expectedAuth) {
      this.logger.error('[Lava Webhook] ❌ ОШИБКА АВТОРИЗАЦИИ');
      throw new UnauthorizedException();
    }

    const { status, amount, offerId, email } = body;
    if (status !== 'success') return { status: 'ignored' };

    // Находим пользователя по email (так как Лава v3 присылает email плательщика)
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      this.logger.error(
        `[Lava Webhook] Пользователь с email ${email} не найден`,
      );
      return { status: 'error' };
    }

    // Определяем, что начислить (ищем, какому тарифу соответствует этот offerId)
    let target = '';
    let type: 'PLAN' | 'FUEL' = 'PLAN';

    if (offerId === process.env.LAVA_OFFER_ID_DAILY_FRESH)
      target = 'DAILY_FRESH';
    else if (offerId === process.env.LAVA_OFFER_ID_PRO_STREAM)
      target = 'PRO_STREAM';
    else if (offerId === process.env.LAVA_OFFER_ID_500) {
      target = '500';
      type = 'FUEL';
    } else if (offerId === process.env.LAVA_OFFER_ID_2000) {
      target = '2000';
      type = 'FUEL';
    }

    const config = type === 'PLAN' ? PLANS_CONFIG[target] : FUEL_CONFIG[target];
    if (!config) return { status: 'error', message: 'Unknown product' };

    try {
      await this.prisma.$transaction([
        this.prisma.payment.create({
          data: {
            userId: user.id,
            amount: Number(amount),
            currency: 'USD',
            provider: 'LAVA',
            type,
            targetName: target,
            status: 'SUCCESS',
            externalId: String(body.id),
          },
        }),
        this.prisma.user.update({
          where: { id: user.id },
          data: {
            plan: type === 'PLAN' ? (target as any) : undefined,
            tagBalance: { increment: config.tags },
            planExpiresAt:
              type === 'PLAN'
                ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
                : undefined,
          },
        }),
      ]);
      this.logger.log(
        `[Lava Webhook] ✅ УСПЕХ: Начислено ${config.tags} тегов юзеру ${user.email}`,
      );
      return { status: 'success' };
    } catch (err) {
      this.logger.error(`[Lava Webhook] Ошибка БД: ${err.message}`);
      return { status: 'error' };
    }
  }
}
