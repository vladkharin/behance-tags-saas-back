import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class RobokassaService {
  constructor(private config: ConfigService) {}

  private get isTest() {
    return this.config.get('ROBO_IS_TEST') === '1';
  }

  private get passwords() {
    return {
      p1: this.isTest
        ? this.config.get('ROBO_TEST_PASSWORD_1')
        : this.config.get('ROBO_PASSWORD_1'),
      p2: this.isTest
        ? this.config.get('ROBO_TEST_PASSWORD_2')
        : this.config.get('ROBO_PASSWORD_2'),
    };
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
    const signature = crypto
      .createHash('md5')
      .update(`${login}:${amount}:${invId}:${p1}:shp_userId=${userId}`)
      .digest('hex');

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
    // Формула ответа: OutSum:InvId:Pass2:shp_userId=...
    const signature = crypto
      .createHash('md5')
      .update(`${amount}:${invId}:${p2}:shp_userId=${userId}`)
      .digest('hex');

    return signature.toLowerCase() === receivedSig.toLowerCase();
  }
}
