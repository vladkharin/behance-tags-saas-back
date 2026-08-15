import {
  Controller,
  Post,
  Body,
  Param,
  Get,
  Delete,
  Patch,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import {
  AnalyzeProjectDto,
  ImportCaseDto,
  ToggleAllTagsChartDto,
  ToggleScheduleDto,
  ToggleTagChartDto,
} from './dto/scraper.dto';

@Controller('scraper')
export class ScraperController {
  constructor(private readonly scraperService: ScraperService) {}

  /**
   * 1. Демо проект (Публичный эндпоинт для превью)
   */
  @Get('demo')
  async getDemo() {
    const project = await this.scraperService.getDemoProject();
    if (!project) {
      throw new NotFoundException('Демо проекты недоступны');
    }
    return project;
  }

  /**
   * 2. Сводная аналитика дашборда (KPI, распределение по Топ-10/50/100, лучшие теги)
   */
  @UseGuards(JwtAuthGuard)
  @Get('analytics/summary')
  async getDashboardSummary(@CurrentUser('id') userId: string) {
    return await this.scraperService.getDashboardSummary(userId);
  }

  /**
   * 3. Обзорная статистика по всем проектам пользователя
   */
  @UseGuards(JwtAuthGuard)
  @Get('projects/overview')
  async getProjectsOverview(@CurrentUser('id') userId: string) {
    return await this.scraperService.getProjectsOverview(userId);
  }

  /**
   * 4. Импорт нового кейса
   */
  @UseGuards(JwtAuthGuard)
  @Post('import-case')
  async importCase(
    @CurrentUser('id') userId: string,
    @Body() dto: ImportCaseDto,
  ) {
    return this.scraperService.queueImportCase(dto.url, userId);
  }

  /**
   * 5. Включение / выключение авто-обновления по расписанию
   */
  @UseGuards(JwtAuthGuard)
  @Patch('projects/:id/schedule')
  async toggleSchedule(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ToggleScheduleDto,
  ) {
    return await this.scraperService.toggleSchedule(id, userId, dto.isScheduled);
  }

  /**
   * 6. Запуск анализа проекта по тегам
   */
  @UseGuards(JwtAuthGuard)
  @Post(':id/analyze')
  async analyze(
    @Param('id') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: AnalyzeProjectDto,
  ) {
    return await this.scraperService.queueProjectAnalysis(
      projectId,
      userId,
      dto.tags,
    );
  }

  /**
   * 7. Получение истории позиций по конкретному проекту
   */
  @UseGuards(JwtAuthGuard)
  @Get(':id/history')
  async getHistory(
    @Param('id') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return await this.scraperService.getProjectAnalyticsHistory(
      projectId,
      userId,
    );
  }

  /**
   * 8. Общая аналитика пользователя (Матрица тегов) - для совместимости с фронтендом
   */
  @UseGuards(JwtAuthGuard)
  @Get('analytics')
  async getAnalyticsData(@CurrentUser('id') userId: string) {
    return await this.scraperService.getAnalytics(userId);
  }

  /**
   * 9. Список всех проектов пользователя - для совместимости с фронтендом
   */
  @UseGuards(JwtAuthGuard)
  @Get('projects')
  async getMyProjects(@CurrentUser('id') userId: string) {
    return await this.scraperService.getUserProjects(userId);
  }

  /**
   * 10. Удаление проекта
   */
  @UseGuards(JwtAuthGuard)
  @Delete('projects/:id')
  async deleteMyProject(
    @Param('id') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return await this.scraperService.deleteProject(projectId, userId);
  }

  /**
   * 10.1 Удаление тега из мониторинга проекта (мягкое отключение без удаления из БД)
   */
  @UseGuards(JwtAuthGuard)
  @Delete('projects/:id/tags/:tagName')
  async removeTagFromProject(
    @Param('id') projectId: string,
    @Param('tagName') tagName: string,
    @CurrentUser('id') userId: string,
  ) {
    return await this.scraperService.removeTagFromProject(
      projectId,
      userId,
      tagName,
    );
  }

  /**
   * 11. Получение детальной информации по проекту (матрица, статус, баланс)
   */
  @UseGuards(JwtAuthGuard)
  @Get('project/:id')
  async getSingleProject(
    @Param('id') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return await this.scraperService.getSingleProjectAnalytics(
      projectId,
      userId,
    );
  }

  /**
   * 12. Переключение отображения конкретного тега на графике
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id/tags/chart')
  async toggleTag(
    @Param('id') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ToggleTagChartDto,
  ) {
    return await this.scraperService.toggleTagOnChart(
      projectId,
      userId,
      dto.tagName,
      dto.state,
    );
  }

  /**
   * 13. Массовое переключение отображения всех тегов на графике
   */
  @UseGuards(JwtAuthGuard)
  @Patch('projects/:id/tags/chart/bulk')
  async toggleAllTags(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ToggleAllTagsChartDto,
  ) {
    return await this.scraperService.toggleAllTagsOnChart(id, userId, dto.state);
  }
}
