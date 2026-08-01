import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class LavaService {
  private readonly logger = new Logger(LavaService.name);

  // URL из твоего Сваггера
  private readonly apiUrl = 'https://gate.lava.top/api/v3/invoice';

  constructor(private config: ConfigService) {}

  // src/billing/lava.service.ts

  async createInvoice(
    email: string,
    offerId: string,
    amount: number,
    currency: string,
  ) {
    const apiKey = this.config.get('LAVA_SECRET_KEY');

    const requestData = {
      email: email,
      offerId: offerId,
      currency: currency,
      amount: amount,
    };

    try {
      const response = await axios.post(this.apiUrl, requestData, {
        headers: {
          Accept: 'application/json',
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json',
        },
      });

      // ЛОГИРУЕМ ВЕСЬ ОТВЕТ, ЧТОБЫ УВИДЕТЬ СТРУКТУРУ
      this.logger.log(
        `[Lava API v3] Ответ сервера: ${JSON.stringify(response.data)}`,
      );

      // Пробуем достать ссылку из разных мест (зависит от версии API)
      const paymentUrl = response.data.paymentUrl;

      if (!paymentUrl) {
        this.logger.error(
          '[Lava API v3] ❌ Ссылка на оплату не найдена в ответе сервера',
        );
      }

      return paymentUrl;
    } catch (error) {
      const errorData = error.response?.data;
      this.logger.error(
        `[Lava API v3] ❌ Ошибка: ${JSON.stringify(errorData)}`,
      );
      throw error;
    }
  }
}
