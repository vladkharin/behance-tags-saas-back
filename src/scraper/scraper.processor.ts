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

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.log(`[Queue] Запуск задачи #${job.id} [${job.name}]`);

    switch (job.name) {
      case 'import-project': {
        const { projectId, url, userId } = job.data;
        return await this.scraperService.importCaseLogic(
          projectId,
          url,
          userId,
        );
      }

      case 'analyze-project': {
        const { projectId, tags } = job.data;
        return await this.scraperService.analyzeProjectPositions(
          projectId,
          tags,
        );
      }

      default:
        this.logger.warn(`Неизвестная задача: ${job.name}`);
    }
  }
}
