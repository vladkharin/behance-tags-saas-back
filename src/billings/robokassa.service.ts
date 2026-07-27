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
    invId: number, // Тип изменен на number
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

    this.logger.log(`[Robokassa] Генерирую ссылку для User: ${userId}`);
    this.logger.log(
      `[Robokassa] Режим: ${this.isTest ? 'ТЕСТОВЫЙ' : 'БОЕВОЙ'}`,
    );
    this.logger.log(`[Robokassa] Исходная строка подписи: ${signatureSource}`);

    let url = `https://auth.robokassa.ru/Merchant/Index.aspx?MerchantLogin=${login}&OutSum=${amount}&InvId=${invId}&Description=${desc}&SignatureValue=${signature}&shp_userId=${userId}`;

    if (this.isTest) url += '&isTest=1';

    return url;
  }

  // Проверка подписи ответа (Webhook)
  verifySignature(
    amount: string,
    invId: string,
    receivedSig: string,
    userId: string,
  ) {
    const { p2 } = this.passwords;

    // Формула ответа (Result URL): OutSum:InvId:Pass2:shp_userId=...
    const signatureSource = `${amount}:${invId}:${p2}:shp_userId=${userId}`;
    const expectedSignature = crypto
      .createHash('md5')
      .update(signatureSource)
      .digest('hex');

    this.logger.log(`[Robokassa Webhook] Проверка подписи...`);
    this.logger.log(
      `[Robokassa Webhook] Данные: Sum=${amount}, InvId=${invId}, User=${userId}`,
    );
    this.logger.log(
      `[Robokassa Webhook] Исходная строка для MD5: ${signatureSource}`,
    );
    this.logger.log(`[Robokassa Webhook] Ожидаем MD5: ${expectedSignature}`);
    this.logger.log(
      `[Robokassa Webhook] Получили MD5: ${receivedSig?.toLowerCase()}`,
    );

    const isValid =
      expectedSignature.toLowerCase() === receivedSig?.toLowerCase();

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
