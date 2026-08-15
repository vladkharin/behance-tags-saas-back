import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class RobokassaService {
  private readonly logger = new Logger(RobokassaService.name);

  constructor(private config: ConfigService) {}

  private get isTest() {
    return this.config.get('ROBO_IS_TEST') === '1';
  }

  private get passwords() {
    const p1 = this.isTest
      ? this.config.get('ROBO_TEST_PASSWORD_1')
      : this.config.get('ROBO_PASSWORD_1');
    const p2 = this.isTest
      ? this.config.get('ROBO_TEST_PASSWORD_2')
      : this.config.get('ROBO_PASSWORD_2');

    return { p1, p2 };
  }

  // Генерация ссылки на оплату
  generatePaymentUrl(
    userId: string,
    amount: number,
    invId: number,
    desc: string,
  ) {
    const login = this.config.get('ROBO_MERCHANT_LOGIN');
    const { p1 } = this.passwords;

    // Формула: MerchantLogin:OutSum:InvId:Pass1:shp_userId=...
    const signatureSource = `${login}:${amount}:${invId}:${p1}:shp_userId=${userId}`;
    const signature = crypto
      .createHash('md5')
      .update(signatureSource)
      .digest('hex');

    this.logger.log(`[Robokassa] Генерирую ссылку для User: ${userId}, InvId: ${invId}`);

    let url = `https://auth.robokassa.ru/Merchant/Index.aspx?MerchantLogin=${login}&OutSum=${amount}&InvId=${invId}&Description=${encodeURIComponent(desc)}&SignatureValue=${signature}&shp_userId=${userId}`;

    if (this.isTest) url += '&isTest=1';

    return url;
  }

  // Проверка подписи ответа (Webhook)
  verifySignature(
    amount: string,
    invId: string,
    receivedSig: string,
    userId: string,
  ): boolean {
    const { p2 } = this.passwords;
    if (!receivedSig || !p2) {
      this.logger.error('[Robokassa Webhook] Отсутствует подпись или пароль #2');
      return false;
    }

    // Формула ответа (Result URL): OutSum:InvId:Pass2:shp_userId=...
    const signatureSource = `${amount}:${invId}:${p2}:shp_userId=${userId}`;
    const expectedSignature = crypto
      .createHash('md5')
      .update(signatureSource)
      .digest('hex')
      .toLowerCase();

    const expectedBuf = Buffer.from(expectedSignature);
    const receivedBuf = Buffer.from(receivedSig.toLowerCase());

    if (expectedBuf.length !== receivedBuf.length) {
      this.logger.error('[Robokassa Webhook] ❌ Неверная длина подписи');
      return false;
    }

    const isValid = crypto.timingSafeEqual(expectedBuf, receivedBuf);

    if (isValid) {
      this.logger.log(`[Robokassa Webhook] ✅ Подпись верна!`);
    } else {
      this.logger.error(
        `[Robokassa Webhook] ❌ ОШИБКА ПОДПИСИ! Проверьте Password #2`,
      );
    }

    return isValid;
  }
}
