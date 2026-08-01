import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class LavaService {
  private readonly logger = new Logger(LavaService.name);

  // URL из твоего Сваггера
  private readonly apiUrl = 'https://gate.lava.top/api/v3/invoice';

  constructor(private config: ConfigService) {}

  async createInvoice(
    email: string,
    offerId: string,
    amount: number,
    currency: string,
  ) {
    const apiKey = this.config.get('LAVA_API_KEY');

    const requestData = {
      email: email,
      offerId: offerId,
      currency: currency, // Должно быть "USD" или "EUR"
      amount: amount,
    };

    this.logger.log(`[Lava API v3] Попытка создания счета для ${email}`);
    this.logger.log(`[Lava API v3] Payload: ${JSON.stringify(requestData)}`);

    try {
      const response = await axios.post(this.apiUrl, requestData, {
        headers: {
          Accept: 'application/json',
          'X-Api-Key': apiKey, // Ключ из панели Lava API
          'Content-Type': 'application/json',
        },
      });

      // Согласно докам, ссылка на оплату лежит в поле url
      this.logger.log(`[Lava API v3] ✅ Счет создан успешно`);
      return response.data.url;
    } catch (error) {
      const errorData = error.response?.data;
      this.logger.error(
        `[Lava API v3] ❌ Ошибка ${error.response?.status}: ${JSON.stringify(errorData)}`,
      );
      throw error;
    }
  }
}
