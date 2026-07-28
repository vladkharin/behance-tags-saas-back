import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class LavaService {
  private readonly logger = new Logger(LavaService.name);

  constructor(private config: ConfigService) {}

  // Проверка подписи запроса от Lava
  verifySignature(body: any, signature: string): boolean {
    const secret = this.config.get('LAVA_SECRET_KEY');

    // В Lava подпись обычно строится на основе JSON-тела запроса и секретного ключа
    // Сортируем ключи, чтобы порядок всегда был одинаковым
    const sortedData = Object.keys(body)
      .sort()
      .filter((key) => key !== 'signature') // Исключаем саму подпись из расчета
      .map((key) => `${key}:${body[key]}`)
      .join('|');

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(sortedData)
      .digest('hex');

    return expectedSignature === signature;
  }
}
