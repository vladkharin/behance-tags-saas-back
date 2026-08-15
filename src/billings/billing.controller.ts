import {
  Controller,
  Post,
  Body,
  BadRequestException,
  Logger,
  Headers,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { RobokassaService } from './robokassa.service';
import { PLANS_CONFIG, FUEL_CONFIG } from './billing.constants';
import { PrismaService } from '../prisma/prisma.service';
import { LavaService } from './lava.service';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { CreatePaymentDto } from './dto/billing.dto';
import * as crypto from 'crypto';

@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private prisma: PrismaService,
    private robokassa: RobokassaService,
    private lavatop: LavaService,
    private configService: ConfigService,
  ) {}

  // 1. Создание платежа (Защищено JWT: пользователь платит только за себя)
  @UseGuards(JwtAuthGuard)
  @Post('create-payment')
  async createPayment(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePaymentDto,
  ) {
    const { target, type, currency } = dto;
    this.logger.log(
      `[Create Payment] Запрос: User ${userId}, Target: ${target}, Type: ${type}, Currency: ${currency}`,
    );

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('Пользователь не найден');
    }

    const config =
      type === 'PLAN' ? PLANS_CONFIG[target] : FUEL_CONFIG[target];
    if (!config) {
      throw new BadRequestException('Неверный тариф или пакет');
    }

    // --- ЛОГИКА ДЛЯ РУБЛЕЙ (ROBOKASSA) ---
    if (currency === 'RUB') {
      const payment = await this.prisma.payment.create({
        data: {
          userId,
          amount: config.priceRub,
          currency: 'RUB',
          provider: 'ROBOKASSA',
          type,
          targetName: target,
          status: 'PENDING',
        },
      });

      const url = this.robokassa.generatePaymentUrl(
        userId,
        config.priceRub,
        payment.orderNumber,
        config.label,
      );

      return { url };
    }

    // --- ЛОГИКА ДЛЯ USD/EUR (LAVA API v3) ---
    else {
      const offerId = this.configService.get<string>(config.envOfferKey);
      if (!offerId) {
        this.logger.error(
          `[Lava API] Offer ID не найден в .env для ключа: ${config.envOfferKey}`,
        );
        throw new BadRequestException('Ошибка конфигурации платежного шлюза');
      }

      const amount = config.priceUsd;

      try {
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
        throw new BadRequestException('Ошибка создания счета в Lava.top');
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

    if (!payment) {
      this.logger.error(`[Robokassa Webhook] Платеж #${InvId} не найден`);
      return `OK${InvId}`;
    }

    // Идемпотентность: если уже успешно оплачен, не начисляем повторно
    if (payment.status === 'SUCCESS') {
      this.logger.log(`[Robokassa Webhook] Платеж #${InvId} уже обработан`);
      return `OK${InvId}`;
    }

    const config =
      payment.type === 'PLAN'
        ? PLANS_CONFIG[payment.targetName]
        : FUEL_CONFIG[payment.targetName];

    if (!config) {
      this.logger.error(
        `[Robokassa Webhook] Неизвестный продукт ${payment.targetName}`,
      );
      return `OK${InvId}`;
    }

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
      this.logger.log(`[Robokassa Webhook] ✅ Успешно начислено для #${InvId}`);
      return `OK${InvId}`;
    } catch (error) {
      this.logger.error(`[Robokassa Webhook] Ошибка транзакции: ${error.message}`);
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

    // Безопасная проверка Basic Auth
    const expectedLogin = this.configService.get<string>('LAVA_WEBHOOK_LOGIN') || '';
    const expectedPassword =
      this.configService.get<string>('LAVA_WEBHOOK_PASSWORD') || '';
    const expectedAuth = `Basic ${Buffer.from(
      `${expectedLogin}:${expectedPassword}`,
    ).toString('base64')}`;

    const authBuf = Buffer.from(authHeader || '');
    const expBuf = Buffer.from(expectedAuth);

    const isAuthValid =
      authBuf.length === expBuf.length &&
      crypto.timingSafeEqual(authBuf, expBuf);

    if (!isAuthValid) {
      this.logger.error('[Lava Webhook] ❌ ОШИБКА АВТОРИЗАЦИИ ВЕБХУКА');
      throw new UnauthorizedException();
    }

    const { status, amount, offerId, email, id: transactionId } = body;
    if (status !== 'success') return { status: 'ignored' };

    const externalIdStr = String(transactionId || '');

    // Идемпотентность: проверяем, не был ли этот платеж уже зачислен
    if (externalIdStr) {
      const existingPayment = await this.prisma.payment.findUnique({
        where: { externalId: externalIdStr },
      });
      if (existingPayment && existingPayment.status === 'SUCCESS') {
        this.logger.log(
          `[Lava Webhook] Платеж ${externalIdStr} уже был успешно обработан ранее`,
        );
        return { status: 'success' };
      }
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      this.logger.error(
        `[Lava Webhook] Пользователь с email ${email} не найден`,
      );
      return { status: 'error', message: 'User not found' };
    }

    // Определяем продукт по offerId
    let target = '';
    let type: 'PLAN' | 'FUEL' = 'PLAN';

    const dailyOffer = this.configService.get('LAVA_OFFER_ID_DAILY_FRESH');
    const proOffer = this.configService.get('LAVA_OFFER_ID_PRO_STREAM');
    const fuel500Offer = this.configService.get('LAVA_OFFER_ID_500');
    const fuel2000Offer = this.configService.get('LAVA_OFFER_ID_2000');

    if (offerId === dailyOffer) {
      target = 'DAILY_FRESH';
      type = 'PLAN';
    } else if (offerId === proOffer) {
      target = 'PRO_STREAM';
      type = 'PLAN';
    } else if (offerId === fuel500Offer) {
      target = '500';
      type = 'FUEL';
    } else if (offerId === fuel2000Offer) {
      target = '2000';
      type = 'FUEL';
    }

    const config = type === 'PLAN' ? PLANS_CONFIG[target] : FUEL_CONFIG[target];
    if (!config) {
      this.logger.error(`[Lava Webhook] Неизвестный offerId: ${offerId}`);
      return { status: 'error', message: 'Unknown product' };
    }

    try {
      await this.prisma.$transaction([
        this.prisma.payment.create({
          data: {
            userId: user.id,
            amount: Number(amount) || config.priceUsd,
            currency: 'USD',
            provider: 'LAVA',
            type,
            targetName: target,
            status: 'SUCCESS',
            externalId: externalIdStr || undefined,
          },
        }),
        this.prisma.user.update({
          where: { id: user.id },
          data: {
            plan: type === 'PLAN' ? (target as any) : user.plan,
            tagBalance: { increment: config.tags },
            planExpiresAt:
              type === 'PLAN'
                ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
                : user.planExpiresAt,
          },
        }),
      ]);

      this.logger.log(
        `[Lava Webhook] ✅ УСПЕХ: Начислено ${config.tags} тегов пользователю ${user.email}`,
      );
      return { status: 'success' };
    } catch (err) {
      this.logger.error(`[Lava Webhook] Ошибка БД: ${err.message}`);
      return { status: 'error' };
    }
  }
}
