import {
  Controller,
  Post,
  Body,
  BadRequestException,
  Param,
  Get,
  Delete,
  Query,
  Logger,
  Patch,
} from '@nestjs/common';
import { ScraperService } from './scraper.service';

@Controller('scraper')
export class ScraperController {
  constructor(private readonly scraperService: ScraperService) {}

  /**
   * 1. Импорт нового кейса
   */
  @Post('import-case')
  async importCase(@Body('url') url: string, @Body('userId') userId: string) {
    if (!url || !userId)
      throw new BadRequestException('URL и userId обязательны');

    // Теперь это асинхронно через очередь
    return this.scraperService.queueImportCase(url, userId);
  }

  @Patch('projects/:id/schedule')
  async toggleSchedule(
    @Param('id') id: string,
    @Body('isScheduled') isScheduled: boolean,
  ) {
    return await this.scraperService.toggleSchedule(id, isScheduled);
  }

  @Post(':id/analyze')
  async analyze(@Param('id') projectId: string, @Body('tags') tags?: string[]) {
    await this.scraperService.queueProjectAnalysis(projectId, tags);
    return { success: true, message: 'Задача на анализ добавлена в очередь' };
  }

  /**
   * 3. ПОЛУЧЕНИЕ ИСТОРИИ ПО ОДНОМУ КЕЙСУ
   * Используется для построения графиков на фронтенде
   */
  @Get(':id/history')
  async getHistory(@Param('id') projectId: string) {
    return await this.scraperService.getProjectAnalyticsHistory(projectId);
  }

  /**
   * 4. Общая аналитика пользователя (Matrix)
   * ИСПРАВЛЕНО: Изменено с @Body на @Query, так как это GET запрос
   */
  @Get('analytics')
  async getAnalyticsData(@Query('userId') userId: string) {
    if (!userId) {
      throw new BadRequestException('userId обязателен');
    }
    return await this.scraperService.getAnalytics(userId);
  }

  /**
   * 5. Список всех проектов пользователя
   */
  @Get('projects')
  async getMyProjects(@Query('userId') userId: string) {
    if (!userId) {
      throw new BadRequestException('userId обязателен');
    }
    return await this.scraperService.getUserProjects(userId);
  }

  /**
   * 6. Удаление проекта
   */
  @Delete('projects/:id')
  async deleteMyProject(
    @Param('id') projectId: string,
    @Query('userId') userId: string,
  ) {
    if (!userId) {
      throw new BadRequestException('userId обязателен');
    }
    return await this.scraperService.deleteProject(projectId, userId);
  }

  @Get('project/:id')
  async getSingleProject(@Param('id') projectId: string) {
    return await this.scraperService.getSingleProjectAnalytics(projectId);
  }

  @Patch(':id/tags/chart')
  async toggleTag(
    @Param('id') projectId: string,
    @Body() body: { tagName: string; state: boolean },
  ) {
    return await this.scraperService.toggleTagOnChart(
      projectId,
      body.tagName,
      body.state,
    );
  }
}
