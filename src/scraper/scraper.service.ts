import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { AnalysisStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

puppeteer.use(StealthPlugin());

interface SearchResult {
  ids: string[];
  hasNext: boolean;
  cursor: string | null;
}

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);
  private readonly GRAPHQL_URL = 'https://www.behance.net/v3/graphql';
  private readonly MAX_RETRIES = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectQueue('scraper-queue') private readonly scraperQueue: Queue,
  ) {}

  /**
   * Инициализация браузера (Оптимизировано для обхода 403 и экономии трафика)
   */
  private async initBrowser() {
    const host = this.configService.get<string>('PROXY_HOST') || '';
    const port = this.configService.get<string>('PROXY_PORT') || '';
    const user = this.configService.get<string>('PROXY_USERNAME') || '';
    const pass = this.configService.get<string>('PROXY_PASSWORD') || '';

    const sessionId = randomUUID().substring(0, 8);
    const dynamicUser = `${user}-session-${sessionId}`;

    const browser = await puppeteer.launch({
      headless: true,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        `--proxy-server=http://${host}:${port}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,720',
      ],
    });

    const page = await browser.newPage();

    // ПЕРЕХВАТ: Блокируем мусор, разрешаем API и скрипты Behance
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const type = request.resourceType();
      const url = request.url();
      const isAllowed =
        url.includes('behance.net') || url.includes('adobe.com');

      if (
        ['image', 'font', 'media', 'stylesheet'].includes(type) ||
        !isAllowed ||
        url.includes('analytics')
      ) {
        request.abort().catch(() => {});
      } else {
        request.continue().catch(() => {});
      }
    });

    await page.authenticate({ username: dynamicUser, password: pass });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    );

    return { browser, page, sessionId };
  }

  /**
   * ПРОДЮСЕР ИМПОРТА (Контроллер)
   */
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

  /**
   * ПРОДЮСЕР АНАЛИЗА (Контроллер)
   */
  async queueProjectAnalysis(projectId: string, tags?: string[]) {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisStatus: AnalysisStatus.PENDING },
    });
    await this.scraperQueue.add(
      'analyze-project',
      { projectId, tags },
      { removeOnComplete: true },
    );
  }

  /**
   * ВОРКЕР: Логика импорта
   */
  async importCaseLogic(projectId: string, url: string, userId: string) {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisStatus: AnalysisStatus.PROCESSING },
    });

    let attempt = 0;
    let success = false;

    while (!success && attempt < 10) {
      attempt++;
      const { browser, page } = await this.initBrowser();
      try {
        this.logger.log(`[Import] Попытка ${attempt} для ${url}`);
        await page.goto('https://www.behance.net/search/projects', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });
        await new Promise((r) => setTimeout(r, 6000));

        const cookies = await page.cookies();
        const bcp = cookies.find((c) => c.name === 'bcp')?.value || '';
        const behanceIdFromUrl = url.match(/gallery\/([0-9]+)/)?.[1];

        const data = await page.evaluate(
          async (id, bcpToken) => {
            const GQL = `query ProjectPage($projectId: ProjectId!) {
            project(id: $projectId) { id name url tags { title } stats { appreciations { all } views { all } } }
          }`;
            const r = await fetch('https://www.behance.net/v3/graphql', {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                'x-adobe-app': 'behance',
                'x-bcp': bcpToken,
              },
              body: JSON.stringify({
                query: GQL,
                variables: { projectId: id },
              }),
            });
            const json = await r.json();
            const res = Array.isArray(json) ? json[0] : json;
            return res.data?.project;
          },
          behanceIdFromUrl,
          bcp,
        );

        if (!data) throw new Error('Empty API response');

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
            const tRec = await tx.tag.upsert({
              where: { name },
              update: {},
              create: { name },
            });
            await tx.projectTag.create({ data: { projectId, tagId: tRec.id } });
          }
        });

        success = true;
        await browser.close();
        this.logger.log(`[Import] ✅ Успешно. Запускаю анализ.`);
        await this.queueProjectAnalysis(projectId);
      } catch (e) {
        await browser.close();
        this.logger.warn(`[Import Fail] ${attempt}: ${e.message}`);
        if (attempt === 10) {
          await this.prisma.project.update({
            where: { id: projectId },
            data: { analysisStatus: AnalysisStatus.IDLE },
          });
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  /**
   * ВОРКЕР: Логика анализа
   */
  async analyzeProjectPositions(projectId: string, customTags?: string[]) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        tags: { include: { tag: true }, orderBy: { tag: { name: 'asc' } } },
      },
    });

    if (!project) return;

    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisStatus: AnalysisStatus.PROCESSING },
    });

    const dbTags = project.tags.map((pt) => pt.tag.name);
    const combinedTags = Array.from(new Set([...dbTags, ...(customTags || [])]))
      .map((t) => t.replace('#', '').trim().toLowerCase())
      .filter((t) => t.length > 0)
      .sort();

    // Сброс всех тегов в null перед стартом (Checking...)
    for (const name of combinedTags) {
      const tagRec = await this.prisma.tag.upsert({
        where: { name },
        update: {},
        create: { name },
      });
      await this.prisma.projectTag.upsert({
        where: { projectId_tagId: { projectId: project.id, tagId: tagRec.id } },
        update: { currentRank: null },
        create: { projectId: project.id, tagId: tagRec.id, currentRank: null },
      });
    }

    let instance: { browser: any; page: any; sessionId: string } | null = null;

    try {
      for (const tagName of combinedTags) {
        let tagSuccess = false;
        let tagAttempt = 0;

        while (!tagSuccess && tagAttempt < 5) {
          tagAttempt++;
          try {
            if (!instance) {
              instance = await this.initBrowser();
              this.logger.log(`[Analytics] Прогрев IP: ${instance.sessionId}`);
              await instance.page.goto(
                'https://www.behance.net/search/projects',
                { waitUntil: 'networkidle2', timeout: 45000 },
              );
              await new Promise((r) => setTimeout(r, 7000));
            }

            const cookies = await instance.page.cookies();
            const bcp = cookies.find((c) => c.name === 'bcp')?.value || '';
            if (!bcp) throw new Error('BCP missing');

            const ids = await instance.page.evaluate(
              async (term, bcpToken) => {
                // ИСПОЛЬЗУЕМ ТОЛЬКО ТЕ ПЕРЕМЕННЫЕ, КОТОРЫЕ ОБЪЯВЛЕНЫ
                const query = `query ProjectsSearchPage($query: query, $filter: SearchResultFilter, $first: Int!) {
                search(query: $query, type: PROJECT, filter: $filter, first: $first, alwaysHasNext: true) {
                  nodes { ... on Project { id } }
                }
              }`;
                const r = await fetch('https://www.behance.net/v3/graphql', {
                  method: 'POST',
                  credentials: 'include',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-adobe-app': 'behance',
                    'x-bcp': bcpToken,
                    'x-requested-with': 'XMLHttpRequest',
                  },
                  body: JSON.stringify({
                    query,
                    variables: { query: term, filter: {}, first: 48 },
                  }),
                });
                const j = await r.json();
                const res = Array.isArray(j) ? j[0] : j;
                return (
                  res.data?.search?.nodes?.map((n: any) => String(n.id)) || []
                );
              },
              tagName,
              bcp,
            );

            const rank =
              ids.indexOf(project.behanceId) !== -1
                ? ids.indexOf(project.behanceId) + 1
                : -1;
            const tagRecord = await this.prisma.tag.findUnique({
              where: { name: tagName },
            });

            await this.prisma.projectTag.update({
              where: {
                projectId_tagId: {
                  projectId: project.id,
                  tagId: tagRecord!.id,
                },
              },
              data: { currentRank: rank, updatedAt: new Date() },
            });
            if (rank !== -1) {
              await this.prisma.tagPositionHistory.create({
                data: { projectId: project.id, tagId: tagRecord!.id, rank },
              });
            }
            tagSuccess = true;
            this.logger.log(`[Result] #${tagName} -> Rank: ${rank}`);
          } catch (e) {
            if (instance) {
              await instance.browser.close();
              instance = null;
            }
            await new Promise((r) => setTimeout(r, 4000));
          }
        }

        // Если все попытки для тега провалены, ставим -1 чтобы не вешать поллинг
        if (!tagSuccess) {
          const tagRecord = await this.prisma.tag.findUnique({
            where: { name: tagName },
          });
          await this.prisma.projectTag.update({
            where: {
              projectId_tagId: { projectId: project.id, tagId: tagRecord!.id },
            },
            data: { currentRank: -1 },
          });
        }
      }
    } finally {
      // ВОЗВРАЩАЕМ В IDLE - ЭТО ОСТАНОВИТ ПОЛЛИНГ НА ФРОНТЕ
      await this.prisma.project.update({
        where: { id: projectId },
        data: { analysisStatus: AnalysisStatus.IDLE },
      });
      if (instance) await instance.browser.close();
    }
  }

  // --- МЕТОДЫ ПОЛУЧЕНИЯ ДАННЫХ (API) ---

  async getSingleProjectAnalytics(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        tags: { include: { tag: true }, orderBy: { tag: { name: 'asc' } } },
      },
    });
    if (!project) throw new NotFoundException('Проект не найден');
    return {
      activeProject: project,
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
    if (!project) throw new NotFoundException('Проект не найден');
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
}
