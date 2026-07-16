import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { randomUUID } from 'node:crypto';
import { AnalysisStatus, Plan } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { subHours } from 'date-fns';

puppeteer.use(StealthPlugin());

// Константы интервалов обновления в часах согласно твоей бизнес-логике
const PLAN_UPDATE_INTERVALS = {
  FREE: 168, // 7 дней
  DAILY_FRESH: 72, // 3 дня
  PRO_STREAM: 24, // 1 день
};

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);

  // Увеличиваем лимит попыток.
  private readonly MAX_RETRIES = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectQueue('scraper-queue') private readonly scraperQueue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledAnalysis() {
    this.logger.log('[Cron] Проверка очереди проектов по расписанию...');
    const now = new Date();

    // Находим проекты, которым пора обновляться исходя из их тарифа
    const projectsToUpdate = await this.prisma.project.findMany({
      where: {
        isScheduled: true, // <--- ДОБАВЬ ЭТО: Робот сработает только если он ВКЛЮЧЕН
        OR: [
          {
            user: { plan: Plan.FREE },
            lastAnalyzedAt: { lte: subHours(now, PLAN_UPDATE_INTERVALS.FREE) },
          },
          {
            user: { plan: Plan.DAILY_FRESH },
            lastAnalyzedAt: {
              lte: subHours(now, PLAN_UPDATE_INTERVALS.DAILY_FRESH),
            },
          },
          {
            user: { plan: Plan.PRO_STREAM },
            lastAnalyzedAt: {
              lte: subHours(now, PLAN_UPDATE_INTERVALS.PRO_STREAM),
            },
          },
        ],
      },
      include: { user: true },
    });

    if (projectsToUpdate.length === 0) {
      this.logger.log('[Cron] Нет проектов для авто-обновления в этом часу.');
      return;
    }

    this.logger.log(
      `[Cron] Найдено ${projectsToUpdate.length} проектов. Добавление в очередь...`,
    );

    for (const project of projectsToUpdate) {
      // Ставим в очередь BullMQ
      await this.queueProjectAnalysis(project.id);

      // Сдвигаем дату сразу, чтобы крон не подхватил проект повторно, пока воркер занят
      await this.prisma.project.update({
        where: { id: project.id },
        data: { lastAnalyzedAt: new Date() },
      });
    }
  }

  /**
   * Инициализация браузера
   */
  private async initBrowser() {
    const host = this.configService.get<string>('PROXY_HOST') || '';
    const port = this.configService.get<string>('PROXY_PORT') || '';
    const user = this.configService.get<string>('PROXY_USERNAME') || '';
    const pass = this.configService.get<string>('PROXY_PASSWORD') || '';

    const sessionId = randomUUID().substring(0, 8);
    const dynamicUser = `${user}-session-${sessionId}`;

    try {
      const browser = await puppeteer.launch({
        headless: true,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          `--proxy-server=http://${host}:${port}`,
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      });

      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(60000);

      await page.authenticate({ username: dynamicUser, password: pass });

      return { browser, page, sessionId };
    } catch (err) {
      this.logger.error(
        `[Browser Launch Error] Не удалось запустить браузер: ${err.message}`,
      );
      throw err;
    }
  }

  /**
   * ВОРКЕР: Логика импорта проекта
   */
  async importCaseLogic(projectId: string, url: string, userId: string) {
    this.logger.log(`[Import] Начало: ${url}`);

    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisStatus: AnalysisStatus.PROCESSING },
    });

    let attempt = 0;
    let success = false;

    while (!success && attempt < this.MAX_RETRIES) {
      attempt++;
      let instance: any = null;
      try {
        instance = await this.initBrowser();

        await instance.page.goto('https://www.behance.net/search/projects', {
          waitUntil: 'networkidle2',
          timeout: 40000,
        });

        await new Promise((r) => setTimeout(r, 5000));

        const cookies = await instance.page.cookies();
        const bcp = cookies.find((c) => c.name === 'bcp')?.value || '';
        const behanceIdFromUrl = url.match(/gallery\/([0-9]+)/)?.[1];

        if (!behanceIdFromUrl) throw new Error('Не удалось спарсить ID из URL');

        const data = await instance.page.evaluate(
          async (id, bcpToken) => {
            const GQL = `query ProjectPage($projectId: ProjectId!) {
              project(id: $projectId) { 
                id name tags { title } 
                stats { appreciations { all } views { all } } 
              }
            }`;
            const r = await fetch('https://www.behance.net/v3/graphql', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-adobe-app': 'behance',
                'x-bcp': bcpToken,
                'x-requested-with': 'XMLHttpRequest',
              },
              body: JSON.stringify({
                query: GQL,
                variables: { projectId: id },
              }),
            });
            const json = await r.json();
            return json.data?.project;
          },
          behanceIdFromUrl,
          bcp,
        );

        if (!data)
          throw new Error('Behance вернул пустой объект (возможно блок)');

        await this.prisma.$transaction(async (tx) => {
          await tx.project.update({
            where: { id: projectId },
            data: {
              behanceId: String(data.id),
              title: data.name,
              views: data.stats.views.all,
              appreciations: data.stats.appreciations.all,
            },
          });

          await tx.projectTag.deleteMany({ where: { projectId } });
          for (const t of data.tags) {
            const name = t.title.trim().toLowerCase();
            const tagRecord = await tx.tag.upsert({
              where: { name },
              update: {},
              create: { name },
            });
            await tx.projectTag.create({
              data: { projectId, tagId: tagRecord.id },
            });
          }
        });

        success = true;
        this.logger.log(`[Import] ✅ Успешно: ${data.name}`);
        await this.queueProjectAnalysis(projectId);
      } catch (e) {
        this.logger.warn(
          `[Import Fail] Попытка ${attempt}/${this.MAX_RETRIES}: ${e.message}`,
        );
        await new Promise((r) =>
          setTimeout(r, Math.min(attempt * 5000, 30000)),
        );
      } finally {
        if (instance) await instance.browser.close();
      }
    }

    if (!success) {
      this.logger.error(
        `[Import Fatal] Не удалось импортировать проект после ${this.MAX_RETRIES} попыток`,
      );
      await this.prisma.project.update({
        where: { id: projectId },
        data: { analysisStatus: AnalysisStatus.IDLE },
      });
    }
  }

  /**
   * ВОРКЕР: Анализ позиций по тегам
   */
  async analyzeProjectPositions(projectId: string, customTags?: string[]) {
    this.logger.log(`[Analyze] Старт: ${projectId}`);

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { tags: { include: { tag: true } } },
    });

    if (!project) return;

    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisStatus: AnalysisStatus.PROCESSING },
    });

    const dbTags = project.tags.map((pt) => pt.tag.name);
    const combinedTags = Array.from(new Set([...dbTags, ...(customTags || [])]))
      .map((t) => t.replace('#', '').trim().toLowerCase())
      .filter((t) => t.length > 0);

    let instance: any = null;

    try {
      instance = await this.initBrowser();
      await instance.page.goto('https://www.behance.net/search/projects', {
        waitUntil: 'networkidle2',
      });
      await new Promise((r) => setTimeout(r, 6000));

      for (const tagName of combinedTags) {
        this.logger.log(`[Analyze] Проверка тега: ${tagName}`);
        const cookies = await instance.page.cookies();
        const bcp = cookies.find((c) => c.name === 'bcp')?.value || '';

        const ids = await instance.page.evaluate(
          async (term, bcpToken) => {
            const query = `query ProjectsSearch($query: query, $first: Int!) {
            search(query: $query, type: PROJECT, first: $first) {
              nodes { ... on Project { id } }
            }
          }`;
            const r = await fetch('https://www.behance.net/v3/graphql', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-adobe-app': 'behance',
                'x-bcp': bcpToken,
                'x-requested-with': 'XMLHttpRequest',
              },
              body: JSON.stringify({
                query,
                variables: { query: term, first: 48 },
              }),
            });
            const j = await r.json();
            return j.data?.search?.nodes?.map((n: any) => String(n.id)) || [];
          },
          tagName,
          bcp,
        );

        const rank =
          ids.indexOf(project.behanceId) !== -1
            ? ids.indexOf(project.behanceId) + 1
            : -1;

        const tagRec = await this.prisma.tag.upsert({
          where: { name: tagName },
          update: {},
          create: { name: tagName },
        });

        await this.prisma.projectTag.upsert({
          where: { projectId_tagId: { projectId, tagId: tagRec.id } },
          update: { currentRank: rank },
          create: { projectId, tagId: tagRec.id, currentRank: rank },
        });

        if (rank !== -1) {
          await this.prisma.tagPositionHistory.create({
            data: { projectId, tagId: tagRec.id, rank },
          });
        }

        await new Promise((r) => setTimeout(r, 2000 + Math.random() * 2000));
      }

      // После успешного завершения обновляем время анализа
      await this.prisma.project.update({
        where: { id: projectId },
        data: { lastAnalyzedAt: new Date() },
      });
    } catch (e) {
      this.logger.error(`[Analyze Error] Критическая ошибка: ${e.message}`);
    } finally {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { analysisStatus: AnalysisStatus.IDLE },
      });
      if (instance) await instance.browser.close();
    }
  }

  // --- API Методы ---

  async queueImportCase(url: string, userId: string) {
    const idMatch = url.match(/gallery\/([0-9]+)/);
    const behanceId = idMatch ? idMatch[1] : `pending-${randomUUID()}`;
    const project = await this.prisma.project.upsert({
      where: { behanceId },
      update: { analysisStatus: AnalysisStatus.PENDING },
      create: {
        url,
        userId,
        behanceId,
        title: 'Importing...',
        analysisStatus: AnalysisStatus.PENDING,
      },
    });
    await this.scraperQueue.add('import-project', {
      projectId: project.id,
      url,
      userId,
    });
    return project;
  }

  async queueProjectAnalysis(projectId: string, tags?: string[]) {
    // 1. Сначала обновляем статус в БД
    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisStatus: AnalysisStatus.PENDING },
    });

    // 2. Добавляем в очередь
    await this.scraperQueue.add(
      'analyze-project',
      {
        projectId: projectId, // Ключ должен называться projectId (как ждет воркер)
        tags: tags, // Передаем теги, иначе ручной анализ придет пустым
      },
      {
        jobId: `analyze-${projectId}-${Date.now()}`, // Это опция BullMQ для уникальности (опционально)
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async getSingleProjectAnalytics(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        user: true,
        tags: {
          include: { tag: true },
          orderBy: { tag: { name: 'asc' } },
        },
      },
    });

    if (!project) throw new NotFoundException('Project not found');

    return {
      activeProject: project,
      // Теперь это будет работать:
      plan: project.user.plan,
      lastAnalyzedAt: project.lastAnalyzedAt,
      tagsMatrix: project.tags.map((pt) => ({
        tag: pt.tag.name,
        currentRank: pt.currentRank,
        onChart: pt.onChart,
      })),
      status: project.analysisStatus,
      isScraping: project.analysisStatus !== AnalysisStatus.IDLE,
    };
  }

  async getUserProjects(userId: string) {
    return await this.prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        tags: { include: { tag: true }, orderBy: { tag: { name: 'asc' } } },
      },
    });
  }

  async deleteProject(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });
    if (!project) throw new NotFoundException('Project not found');
    return await this.prisma.$transaction(async (tx) => {
      await tx.tagPositionHistory.deleteMany({ where: { projectId } });
      await tx.projectTag.deleteMany({ where: { projectId } });
      return await tx.project.delete({ where: { id: projectId } });
    });
  }

  async getProjectAnalyticsHistory(projectId: string) {
    const history = await this.prisma.tagPositionHistory.findMany({
      where: { projectId },
      include: { tag: true },
      orderBy: { createdAt: 'asc' },
    });
    const formatted: Record<string, any[]> = {};
    for (const entry of history) {
      if (!formatted[entry.tag.name]) formatted[entry.tag.name] = [];
      formatted[entry.tag.name].push({
        date: entry.createdAt.toISOString().split('T')[0],
        rank: entry.rank,
      });
    }
    return { success: true, analytics: formatted };
  }

  async toggleTagOnChart(projectId: string, tagName: string, state: boolean) {
    const tag = await this.prisma.tag.findUnique({ where: { name: tagName } });
    if (!tag) throw new NotFoundException('Tag not found');
    return await this.prisma.projectTag.update({
      where: { projectId_tagId: { projectId, tagId: tag.id } },
      data: { onChart: state },
    });
  }

  async getAnalytics(userId: string) {
    const projectTags = await this.prisma.projectTag.findMany({
      where: { project: { userId } },
      include: { project: true, tag: true },
    });
    const tagsMap: Record<string, any> = {};
    for (const pt of projectTags) {
      const name = pt.tag.name;
      if (!tagsMap[name])
        tagsMap[name] = {
          tag: name,
          totalViews: 0,
          totalAppreciations: 0,
          count: 0,
          currentRank: pt.currentRank,
        };
      tagsMap[name].totalViews += pt.project.views;
      tagsMap[name].totalAppreciations += pt.project.appreciations;
      tagsMap[name].count += 1;
    }
    const activeProject = await this.prisma.project.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      user: { id: userId },
      activeProject,
      tagsMatrix: Object.values(tagsMap),
    };
  }

  async toggleSchedule(projectId: string, state: boolean) {
    this.logger.log(
      `[Schedule] Проект ${projectId} -> Авто-обновление: ${state}`,
    );
    return await this.prisma.project.update({
      where: { id: projectId },
      data: { isScheduled: state },
    });
  }
}
