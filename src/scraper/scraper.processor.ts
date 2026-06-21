import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { ScraperService } from './scraper.service';

@Processor('scraper-queue')
export class ScraperProcessor extends WorkerHost {
  private readonly logger = new Logger(ScraperProcessor.name);

  constructor(private readonly scraperService: ScraperService) {
    super();
  }

  // Сюда прилетают задачи из очереди
  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(
      `[Queue] Начинаем обработку задачи #${job.id} класса [${job.name}]`,
    );

    switch (job.name) {
      case 'analyze-project': {
        const { projectId } = job.data;
        // Просто вызываем наш готовый метод парсинга
        return await this.scraperService.analyzeProjectPositions(projectId);
      }

      default:
        this.logger.warn(`[Queue] Неизвестный тип задачи: ${job.name}`);
        break;
    }
  }
}
