import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class LavaService {
  private readonly logger = new Logger(LavaService.name);
  private readonly apiUrl = 'https://gate.lava.top/api/v3/invoice';

  constructor(private config: ConfigService) {}

  async createInvoice(
    email: string,
    offerId: string,
    amount: number,
    currency: string,
  ) {
    const apiKey = this.config.get('LAVA_API_KEY');

    try {
      const response = await axios.post(
        this.apiUrl,
        {
          email: email, // Email плательщика (обязательно для v3)
          offerId: offerId, // ID конкретного товара
          currency: currency, // EUR или USD
          amount: amount,
        },
        {
          headers: {
            Accept: 'application/json',
            'X-Api-Key': apiKey,
            'Content-Type': 'application/json',
          },
        },
      );

      // В ответе API v3 ссылка на оплату обычно лежит в response.data.url
      return response.data.url;
    } catch (error) {
      this.logger.error(
        `[Lava API v3] Ошибка: ${error.response?.data?.message || error.message}`,
      );
      throw error;
    }
  }
}
