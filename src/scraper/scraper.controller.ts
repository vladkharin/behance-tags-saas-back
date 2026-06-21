import {
  Controller,
  Post,
  Body,
  BadRequestException,
  Param,
  Get,
} from '@nestjs/common';
import { ScraperService } from './scraper.service';

@Controller('scraper')
export class ScraperController {
  constructor(private readonly scraperService: ScraperService) {}

  @Post('import-case')
  async importCase(
    @Body('url') url: string,
    @Body('userId') userId: string, // Пока авторизации нет, передаем userId в теле запроса вручную для тестов
  ) {
    if (!url) {
      throw new BadRequestException('Параметр url обязателен');
    }
    if (!userId) {
      throw new BadRequestException('Параметр userId обязателен');
    }

    // Изменили название метода на importCase, чтобы он соответствовал сервису
    return this.scraperService.importCase(url, userId);
  }

  @Post(':id/analyze')
  async analyze(@Param('id') projectId: string) {
    return await this.scraperService.analyzeProjectPositions(projectId);
  }

  @Get(':id/history')
  async getHistory(@Param('id') projectId: string) {
    return await this.scraperService.getProjectAnalyticsHistory(projectId);
  }

  @Get('analytics')
  async getAnalyticsData(@Body('userId') userId: string) {
    // Когда прикрутишь полноценную JWT-авторизацию, userId будешь брать из @Req() req.user.id
    if (!userId) {
      throw new BadRequestException('userId обязателен');
    }
    return await this.scraperService.getAnalytics(userId);
  }
}
