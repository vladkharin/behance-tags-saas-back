import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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

const PLAN_UPDATE_INTERVALS = {
  FREE: 168, // 7 дней
  DAILY_FRESH: 72, // 3 дня
  PRO_STREAM: 24, // 24 часа
};

const DEMO_PROJECT_ID = 'demo-showcase-project';

const DEMO_SHOWCASE_PROJECT = {
  id: DEMO_PROJECT_ID,
  behanceId: '218492041',
  title: 'LOOP - Motion Design & 3D Brand Showcase 2026',
  url: 'https://www.behance.net/gallery/218492041/LOOP-Motion-Design-Festival',
  views: 48920,
  appreciations: 4150,
  comments: 312,
  userId: 'demo-user',
  lastAnalyzedAt: new Date().toISOString(),
  isScheduled: true,
  analysisStatus: 'IDLE',
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: new Date().toISOString(),
};

const DEMO_SHOWCASE_TAGS_MATRIX = [
  { tag: 'motion design', currentRank: 1, bestRank: 1, previousRank: 2, rankDelta: 1, onChart: true },
  { tag: '3d animation', currentRank: 2, bestRank: 2, previousRank: 3, rankDelta: 1, onChart: true },
  { tag: 'ui/ux', currentRank: 3, bestRank: 3, previousRank: 3, rankDelta: 0, onChart: true },
  { tag: 'branding', currentRank: 4, bestRank: 4, previousRank: 5, rankDelta: 1, onChart: true },
  { tag: 'graphic design', currentRank: 5, bestRank: 5, previousRank: 6, rankDelta: 1, onChart: true },
  { tag: 'logotype', currentRank: 7, bestRank: 7, previousRank: 9, rankDelta: 2, onChart: true },
  { tag: 'cyberpunk', currentRank: 8, bestRank: 8, previousRank: 10, rankDelta: 2, onChart: true },
  { tag: 'art direction', currentRank: 10, bestRank: 10, previousRank: 12, rankDelta: 2, onChart: true },
  { tag: '3d render', currentRank: 12, bestRank: 11, previousRank: 15, rankDelta: 3, onChart: false },
  { tag: 'visual identity', currentRank: 14, bestRank: 12, previousRank: 18, rankDelta: 4, onChart: false },
  { tag: 'web design', currentRank: 16, bestRank: 15, previousRank: 20, rankDelta: 4, onChart: false },
  { tag: 'typography', currentRank: 21, bestRank: 19, previousRank: 25, rankDelta: 4, onChart: false },
  { tag: 'poster design', currentRank: 25, bestRank: 22, previousRank: 30, rankDelta: 5, onChart: false },
  { tag: 'cgi', currentRank: 28, bestRank: 24, previousRank: 32, rankDelta: 4, onChart: false },
  { tag: 'figma', currentRank: 34, bestRank: 30, previousRank: 38, rankDelta: 4, onChart: false },
  { tag: 'cinema 4d', currentRank: 42, bestRank: 38, previousRank: 45, rankDelta: 3, onChart: false },
  { tag: 'octane render', currentRank: 48, bestRank: 42, previousRank: 52, rankDelta: 4, onChart: false },
  { tag: 'blender 3d', currentRank: 55, bestRank: 50, previousRank: 60, rankDelta: 5, onChart: false },
  { tag: 'digital art', currentRank: 63, bestRank: 58, previousRank: 68, rankDelta: 5, onChart: false },
  { tag: 'after effects', currentRank: 71, bestRank: 65, previousRank: 75, rankDelta: 4, onChart: false },
];

const DEMO_SHOWCASE_SUGGESTED_TAGS = [
  'motion design 3d', '3d animation showcase', 'cyberpunk ui', 'logotype 3d', 'branding festival',
  'visual identity 2026', 'cgi motion graphics', 'abstract 3d render', 'creative art direction',
  '3d typography', 'octane 3d animation', 'ui/ux motion', 'behance top 3d', 'futuristic branding',
  'dizajn logotipa 3d', 'firmennyj stil motion', 'brending festivalya', '3d logo design',
  'blender motion graphics', 'cinema 4d art', '3d brandbook', 'brand identity 3d'
];

function getDemoShowcaseHistory() {
  const history: Record<string, Array<{ date: string; rank: number }>> = {};
  const tagsTrendData: Record<string, number[]> = {
    'motion design': [12, 11, 9, 8, 7, 6, 5, 5, 4, 3, 3, 2, 2, 1],
    '3d animation': [18, 16, 15, 12, 10, 9, 7, 6, 5, 4, 3, 3, 2, 2],
    'ui/ux': [10, 9, 8, 7, 6, 5, 5, 4, 4, 3, 3, 3, 3, 3],
    'branding': [14, 13, 11, 10, 8, 7, 6, 5, 5, 4, 4, 5, 4, 4],
    'graphic design': [16, 14, 12, 11, 9, 8, 7, 6, 5, 5, 5, 6, 5, 5],
    'logotype': [20, 18, 16, 14, 12, 11, 9, 8, 8, 7, 7, 9, 7, 7],
    'cyberpunk': [22, 20, 18, 15, 13, 11, 10, 9, 8, 8, 8, 10, 8, 8],
    'art direction': [25, 22, 19, 17, 14, 12, 11, 10, 10, 10, 10, 12, 10, 10],
  };

  const today = new Date();
  for (const [tag, ranks] of Object.entries(tagsTrendData)) {
    history[tag] = ranks.map((rank, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (13 - i));
      return {
        date: d.toISOString().split('T')[0],
        rank,
      };
    });
  }
  return history;
}

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);
  private readonly MAX_RETRIES = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @InjectQueue('scraper-queue') private readonly scraperQueue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleScheduledAnalysis() {
    this.logger.log('[Cron] Проверка расписания обновления проектов...');
    const now = new Date();
    const projects = await this.prisma.project.findMany({
      where: {
        isScheduled: true,
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

    for (const project of projects) {
      if (project.user.tagBalance > 0) {
        await this.queueProjectAnalysis(project.id);
        await this.prisma.project.update({
          where: { id: project.id },
          data: { lastAnalyzedAt: new Date() },
        });
      }
    }
  }

  private async initBrowser() {
    const host = this.configService.get<string>('PROXY_HOST') || '';
    const port = this.configService.get<string>('PROXY_PORT') || '';
    const user = this.configService.get<string>('PROXY_USERNAME') || '';
    const pass = this.configService.get<string>('PROXY_PASSWORD') || '';
    const sessionId = randomUUID().substring(0, 8);
    const dynamicUser = user ? `${user}-session-${sessionId}` : '';

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--blink-settings=imagesEnabled=false',
      '--disable-remote-fonts',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--mute-audio',
      '--no-first-run',
    ];

    if (host && port) {
      args.push(`--proxy-server=http://${host}:${port}`);
    }

    try {
      const browser = await puppeteer.launch({
        headless: true,
        ignoreDefaultArgs: ['--enable-automation'],
        args,
      });
      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(45000);

      // ЭКОНОМИЯ 99% ТРАФИКА: перехватываем и блокируем все тяжелые бинарные ресурсы
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const resourceType = req.resourceType();
        const url = req.url().toLowerCase();

        // 1. Блокируем картинки, медиа, шрифты, CSS стили, texttrack и прочий мусор
        if (
          ['image', 'media', 'font', 'stylesheet', 'other', 'texttrack'].includes(
            resourceType,
          )
        ) {
          req.abort();
          return;
        }

        // 2. Блокируем сторонние трекеры и аналитику
        if (
          url.includes('google-analytics') ||
          url.includes('googletagmanager') ||
          url.includes('facebook') ||
          url.includes('adobedtm') ||
          url.includes('typekit') ||
          url.includes('sentry') ||
          url.includes('doubleclick') ||
          url.includes('demdex.net') ||
          url.includes('everesttech.net')
        ) {
          req.abort();
          return;
        }

        req.continue();
      });

      if (dynamicUser && pass) {
        await page.authenticate({ username: dynamicUser, password: pass });
      }
      return { browser, page, sessionId };
    } catch (err) {
      this.logger.error(`[Browser Launch Error] ${err.message}`);
      throw err;
    }
  }

  private async fetchProjectStats(
    page: any,
    behanceId: string,
    bcpToken: string,
  ) {
    return await page.evaluate(
      async (id: string, token: string) => {
        const GQL = `query ProjectPage($projectId: ProjectId!) { 
          project(id: $projectId) { 
            id name tags { title } 
            stats { 
              appreciations { all } 
              views { all } 
              comments { all } 
            } 
          } 
        }`;
        const r = await fetch('https://www.behance.net/v3/graphql', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-adobe-app': 'behance',
            'x-bcp': token,
            'x-requested-with': 'XMLHttpRequest',
          },
          body: JSON.stringify({ query: GQL, variables: { projectId: id } }),
        });
        const json = await r.json();
        return json.data?.project;
      },
      behanceId,
      bcpToken,
    );
  }

  async importCaseLogic(projectId: string, url: string, userId: string) {
    this.logger.log(`[Import] Начало импорта: ${url}`);
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
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await new Promise((r) => setTimeout(r, 2500));
        const cookies = await instance.page.cookies();
        let bcp = cookies.find((c: any) => c.name === 'bcp')?.value || '';
        if (!bcp) {
          bcp = await instance.page.evaluate(() => {
            const match = document.cookie.match(/bcp=([^;]+)/);
            return match ? match[1] : '';
          });
        }
        if (!bcp) {
          throw new Error('Не удалось извлечь bcp токен из сессии Behance');
        }
        this.logger.log(`[Import] ✅ bcp токен получен: ${bcp.substring(0, 10)}...`);
        const behanceIdFromUrl = url.match(/gallery\/([0-9]+)/)?.[1];
        if (!behanceIdFromUrl) throw new Error('ID кейса не найден в URL');

        const data = await this.fetchProjectStats(
          instance.page,
          behanceIdFromUrl,
          bcp,
        );

        if (!data) throw new Error('Пустой ответ от Behance API');

        await this.prisma.$transaction(async (tx) => {
          await tx.project.update({
            where: { id: projectId },
            data: {
              behanceId: String(data.id),
              title: data.name,
              views: data.stats?.views?.all || 0,
              appreciations: data.stats?.appreciations?.all || 0,
              comments: data.stats?.comments?.all || 0,
            },
          });
          await tx.projectTag.deleteMany({ where: { projectId } });
          if (Array.isArray(data.tags)) {
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
          }
        });

        success = true;
        this.logger.log(`[Import] ✅ Успешно импортирован кейс: ${data.name}`);
        await this.queueProjectAnalysis(projectId, userId);
      } catch (e) {
        this.logger.warn(
          `[Import Fail] Попытка ${attempt}/${this.MAX_RETRIES}: ${e.message}`,
        );
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      } finally {
        if (instance?.browser) {
          try {
            await instance.browser.close();
          } catch {}
        }
      }
    }

    if (!success) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { analysisStatus: AnalysisStatus.IDLE },
      });
      this.logger.error(
        `[Import Fatal] Не удалось импортировать проект ${projectId} после ${this.MAX_RETRIES} попыток`,
      );
    }
  }

  async analyzeProjectPositions(projectId: string, customTags?: string[]) {
    this.logger.log(`[Analyze] >>> СТАРТ: ${projectId}`);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { user: true, tags: { include: { tag: true } } },
    });

    if (!project || project.behanceId?.startsWith('pending-')) return;

    const dbTags = project.tags.map((pt) => pt.tag.name) || [];
    const combinedTags = Array.from(new Set([...dbTags, ...(customTags || [])]))
      .map((t) => String(t).replace('#', '').trim().toLowerCase())
      .filter((t) => t.length > 0);

    const cost = combinedTags.length;

    // Атомарная проверка и блокировка баланса
    if (project.user.tagBalance < cost || cost === 0) {
      this.logger.warn(
        `[Analyze] Недостаточно тегов: нужно ${cost}, на балансе ${project.user.tagBalance}`,
      );
      await this.prisma.project.update({
        where: { id: projectId },
        data: { analysisStatus: AnalysisStatus.IDLE },
      });
      return;
    }

    // Списываем баланс заранее для предотвращения состояния гонки (Race condition)
    await this.prisma.user.update({
      where: { id: project.userId },
      data: { tagBalance: { decrement: cost } },
    });

    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisStatus: AnalysisStatus.PROCESSING },
    });

    let attempt = 0;
    let success = false;

    try {
      while (!success && attempt < this.MAX_RETRIES) {
        attempt++;
        let instance: any = null;
        try {
          instance = await this.initBrowser();

          // 1. Инициализируем легкую сессию и забираем свежую статистику через GraphQL
          await instance.page.goto('https://www.behance.net/search/projects', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          await new Promise((r) => setTimeout(r, 3000));

          const cookies = await instance.page.cookies();
          let bcp = cookies.find((c: any) => c.name === 'bcp')?.value || '';
          if (!bcp) {
            bcp = await instance.page.evaluate(() => {
              const match = document.cookie.match(/bcp=([^;]+)/);
              return match ? match[1] : '';
            });
          }
          if (!bcp) {
            throw new Error('Не удалось извлечь bcp токен из сессии Behance');
          }
          this.logger.log(`[Analyze] ✅ bcp токен получен: ${bcp.substring(0, 10)}...`);

          const latestData = await this.fetchProjectStats(
            instance.page,
            project.behanceId,
            bcp,
          );
          if (latestData) {
            await this.prisma.project.update({
              where: { id: projectId },
              data: {
                title: latestData.name || project.title,
                views: latestData.stats?.views?.all || 0,
                appreciations: latestData.stats?.appreciations?.all || 0,
                comments: latestData.stats?.comments?.all || 0,
              },
            });

            // Автоматически синхронизируем обновленные родные теги с Behance
            if (Array.isArray(latestData.tags)) {
              for (const t of latestData.tags) {
                const name = t.title.trim().toLowerCase();
                const tagRecord = await this.prisma.tag.upsert({
                  where: { name },
                  update: {},
                  create: { name },
                });
                await this.prisma.projectTag.upsert({
                  where: { projectId_tagId: { projectId, tagId: tagRecord.id } },
                  update: {},
                  create: { projectId, tagId: tagRecord.id },
                });
              }
            }
          }

          // 2. Проверяем позиции по каждому тегу
          for (const tagName of combinedTags) {
            const searchData = await instance.page.evaluate(
              async (term: string, bcpToken: string) => {
                const GQL = `query Search($query: query) { search(query: $query, type: PROJECT, first: 100) { nodes { ... on Project { id } } } }`;
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
                    variables: { query: term },
                  }),
                });
                const json = await r.json();
                return (
                  json.data?.search?.nodes?.map((n: any) => String(n.id)) || []
                );
              },
              tagName,
              bcp,
            );

            const rank =
              searchData.indexOf(project.behanceId) !== -1
                ? searchData.indexOf(project.behanceId) + 1
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
          }

          success = true;
          await this.prisma.project.update({
            where: { id: projectId },
            data: { lastAnalyzedAt: new Date() },
          });
        } catch (e) {
          this.logger.error(
            `[Analyze Fail] Попытка ${attempt}/${this.MAX_RETRIES}: ${e.message}`,
          );
          await new Promise((r) => setTimeout(r, 4000 * attempt));
        } finally {
          if (instance?.browser) {
            try {
              await instance.browser.close();
            } catch {}
          }
        }
      }

      // Если все попытки провалились, возвращаем списанный баланс пользователю
      if (!success) {
        this.logger.error(
          `[Analyze Fatal] Не удалось проанализировать проект ${projectId}, возврат баланса (${cost} тегов)`,
        );
        await this.prisma.user.update({
          where: { id: project.userId },
          data: { tagBalance: { increment: cost } },
        });
      }
    } finally {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { analysisStatus: AnalysisStatus.IDLE },
      });
    }
  }

  async queueProjectAnalysis(
    projectId: string,
    userId?: string,
    tags?: string[],
  ) {
    const whereClause: any = { id: projectId };
    if (userId) {
      whereClause.userId = userId;
    }

    const project = await this.prisma.project.findFirst({
      where: whereClause,
      include: { user: true },
    });

    if (!project) {
      throw new NotFoundException('Проект не найден');
    }

    if (project.user.tagBalance <= 0) {
      throw new BadRequestException('Недостаточно тегов на балансе для анализа');
    }

    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisStatus: AnalysisStatus.PENDING },
    });

    await this.scraperQueue.add(
      'analyze-project',
      { projectId, tags },
      { jobId: `analyze-${projectId}-${Date.now()}`, removeOnComplete: true },
    );

    return { success: true, message: 'Задача на анализ добавлена в очередь' };
  }

  async queueImportCase(url: string, userId: string) {
    const behanceId =
      url.match(/gallery\/([0-9]+)/)?.[1] || `pending-${randomUUID()}`;

    // Проверяем, не принадлежит ли уже кейс другому пользователю
    const existing = await this.prisma.project.findUnique({
      where: { behanceId },
    });

    if (existing && existing.userId !== userId) {
      throw new BadRequestException(
        'Этот кейс уже импортирован другим пользователем',
      );
    }

    const project = await this.prisma.project.upsert({
      where: { behanceId },
      update: {
        analysisStatus: AnalysisStatus.PENDING,
        userId,
        url,
      },
      create: {
        url,
        userId,
        behanceId,
        title: 'Importing...',
        analysisStatus: AnalysisStatus.PENDING,
      },
    });

    await this.scraperQueue.add(
      'import-project',
      {
        projectId: project.id,
        url,
        userId,
      },
      { jobId: `import-${project.id}-${Date.now()}`, removeOnComplete: true },
    );

    return project;
  }

  async getSingleProjectAnalytics(projectId: string, userId: string) {
    if (projectId === DEMO_PROJECT_ID || projectId === 'demo' || projectId.includes('demo')) {
      return {
        activeProject: DEMO_SHOWCASE_PROJECT,
        plan: 'PRO_STREAM' as any,
        tagBalance: 9999,
        lastAnalyzedAt: new Date().toISOString(),
        tagsMatrix: DEMO_SHOWCASE_TAGS_MATRIX,
        suggestedTags: DEMO_SHOWCASE_SUGGESTED_TAGS,
        status: 'IDLE',
      };
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      include: {
        user: true,
        tags: { include: { tag: true }, orderBy: { tag: { name: 'asc' } } },
      },
    });

    if (!project) throw new NotFoundException('Проект не найден');

    // Получаем историю для расчета лучшего ранга и дельты
    const histories = await this.prisma.tagPositionHistory.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });

    const historyByTag = new Map<string, number[]>();
    for (const h of histories) {
      if (!historyByTag.has(h.tagId)) {
        historyByTag.set(h.tagId, []);
      }
      historyByTag.get(h.tagId)!.push(h.rank);
    }

    const tagsMatrix = project.tags.map((pt) => {
      const ranks = historyByTag.get(pt.tagId) || [];
      const validRanks = ranks.filter((r) => r > 0);
      const bestRank = validRanks.length > 0 ? Math.min(...validRanks) : null;
      const previousRank = ranks.length > 1 ? ranks[1] : null;
      let rankDelta: number | null = null;
      if (
        pt.currentRank &&
        pt.currentRank > 0 &&
        previousRank &&
        previousRank > 0
      ) {
        rankDelta = previousRank - pt.currentRank;
      }

      return {
        tag: pt.tag.name,
        currentRank: pt.currentRank,
        bestRank,
        previousRank,
        rankDelta,
        onChart: pt.onChart,
      };
    });

    // =========================================================================
    // УМНЫЙ СЕМАНТИЧЕСКИЙ ГЕНЕРАТОР ТЕГОВ (СЕМАНТИЧЕСКОЕ ЯДРО 50-100+ ТЕГОВ)
    // =========================================================================
    const existingTagNames = new Set(project.tags.map((t) => t.tag.name.toLowerCase().trim()));
    const suggestedTagsSet = new Set<string>();

    const rawContext = `${project.title || ''} ${project.url || ''} ${Array.from(existingTagNames).join(' ')}`.toLowerCase();

    // 1. ОПРЕДЕЛЯЕМ НИШУ И ТЕМАТИКУ КЕЙСА
    const isConstruction = /строител|stroitel|производств|proizvodstv|застройщ|девелоп|недвижим|nedvizhim|архитектур|construction|real estate|developer|architecture|building|industrial|manufacturing/.test(rawContext);
    const isAuto = /авто|auto|машин|тюнинг|dealership|car|drive|rental|vehicle|motors|дилер/.test(rawContext);
    const isFood = /ресторан|кафе|кофейн|еда|доставк|бар|меню|restaurant|cafe|coffee|food|bakery|bar|burger|pizza|kitchen/.test(rawContext);
    const isBeauty = /косметик|бьюти|одежд|мод|салон красот|парфюм|beauty|cosmetic|fashion|skincare|apparel|clothing|spa/.test(rawContext);
    const isWebUi = /сайт|лендинг|интернет-магазин|веб-дизайн|приложен|ui|ux|figma|landing|web|mobile app|website|dashboard|saas|app/.test(rawContext);
    const is3d = /3d|render|blender|cinema|cgi|motion|анимаци|рендер|моушн/.test(rawContext);
    const isMedical = /клиник|медицин|стоматолог|здоровь|врач|clinic|medical|dental|doctor|health|pharma/.test(rawContext);
    const isFintech = /банк|финтех|крипт|инвестиц|юрист|fintech|bank|crypto|finance|invest|legal|consulting/.test(rawContext);
    const isBranding = /логотип|logotip|брендбук|brendbuk|айдентик|ajdentik|фирменный стиль|firmennyj|brand|logo|identity|packaging|упаковк/.test(rawContext) || (!isWebUi && !is3d);

    const addTags = (list: string[]) => {
      for (const item of list) {
        const clean = item.trim().toLowerCase().replace(/^#/, '');
        if (clean && clean.length >= 2 && !existingTagNames.has(clean)) {
          suggestedTagsSet.add(clean);
        }
      }
    };

    // 2. БАЗОВЫЕ УСЛУГИ И ШИРОКИЕ ТЕГИ
    if (isBranding) {
      addTags([
        'логотип', 'фирменный стиль', 'брендбук', 'айдентика', 'разработка логотипа',
        'дизайн логотипа', 'логотип компании', 'фирменный стиль компании', 'брендбук компании',
        'айдентика бренда', 'разработка брендбука', 'гайдлайн', 'логотипы', 'логотип и айдентика',
        'логотип и фирменный стиль', 'полиграфия', 'векторная графика', 'типографика',
        'brand identity', 'logo design', 'branding', 'corporate identity', 'visual identity',
        'brand guideline', 'logotype', 'graphic design', 'logo designer', 'typography',
        'brand design', 'vector logo', 'minimalist logo', 'modern branding', 'creative logo',
        'dizajn logotipa', 'firmennyj stil', 'brendbuk', 'ajdentika', 'razrabotka logotipa', 'logotip'
      ]);
    }

    if (isWebUi) {
      addTags([
        'дизайн сайта', 'веб-дизайн', 'разработка сайта', 'landing page', 'лендинг',
        'дизайн интерфейса', 'мобильное приложение', 'ui/ux design', 'ux/ui', 'figma design',
        'дизайн лендинга', 'редизайн сайта', 'интернет-магазин', 'дизайн интернет-магазина',
        'web design', 'ui design', 'ux design', 'landing page design', 'mobile app design',
        'website redesign', 'dashboard design', 'design system', 'responsive design',
        'dizajn sajta', 'veb dizajn', 'lending', 'figma'
      ]);
    }

    // 3. НИШЕВЫЕ СВЯЗКИ (ПЕРЕМНОЖЕНИЕ УСЛУГА × НИША)
    if (isConstruction) {
      addTags([
        'строительная компания', 'строительство', 'логотип строительной компании',
        'фирменный стиль строительной компании', 'брендбук строительной компании',
        'айдентика строительной компании', 'логотип строительство', 'фирменный стиль строительство',
        'брендбук строительство', 'айдентика строительство', 'производство',
        'логотип производство', 'фирменный стиль производство', 'брендбук производство',
        'айдентика производство', 'застройщик', 'логотип застройщика', 'девелопмент',
        'логотип девелопмент', 'недвижимость', 'логотип недвижимость', 'архитектурное бюро',
        'construction logo', 'construction branding', 'construction brand identity',
        'real estate logo', 'real estate branding', 'industrial branding', 'manufacturing logo',
        'developer branding', 'building logo', 'engineering branding', 'architecture branding',
        'stroitelnaja kompanija', 'stroitelstvo', 'proizvodstvo', 'logotip stroitelnoj kompanii',
        'firmennyj stil stroitelnoj kompanii', 'logotip stroitelstvo'
      ]);
    }

    if (isAuto) {
      addTags([
        'автосалон', 'сайт автосалона', 'дизайн сайта автосалона', 'логотип автосалона',
        'фирменный стиль автосалона', 'аренда авто', 'сайт аренды авто', 'автосервис',
        'логотип автосервиса', 'тюнинг авто', 'автомобили', 'автодилер', 'продажа авто',
        'car dealership website', 'dealership web design', 'automotive website', 'car rental website',
        'automotive branding', 'car logo design', 'dealership ui/ux', 'car dealer app',
        'dealership branding', 'vehicle branding', 'car website design', 'motors branding',
        'sajt avtosalona', 'dizajn sajta avtosalona', 'avtosalon', 'avto', 'arenda avto'
      ]);
    }

    if (isFood) {
      addTags([
        'брендинг ресторана', 'логотип ресторана', 'айдентика ресторана', 'логотип кафе',
        'айдентика кафе', 'фирменный стиль ресторана', 'меню ресторана', 'упаковка еды',
        'дизайн упаковки', 'кофейня', 'логотип кофейни', 'айдентика кофейни', 'доставка еды',
        'restaurant branding', 'cafe branding', 'coffee shop branding', 'food packaging',
        'restaurant logo', 'coffee logo', 'food brand identity', 'menu design', 'packaging design',
        'brending restorana', 'logotip kafe', 'ajdentika kafe', 'kofejnja'
      ]);
    }

    if (isBeauty) {
      addTags([
        'брендинг косметики', 'дизайн косметики', 'упаковка косметики', 'логотип салона красоты',
        'айдентика салона красоты', 'фирменный стиль косметики', 'бьюти бренд', 'дизайн упаковки косметики',
        'бренд одежды', 'логотип одежды', 'айдентика бренда одежды', 'fashion branding',
        'beauty branding', 'cosmetics packaging', 'skincare branding', 'fashion logo',
        'cosmetics logo', 'beauty logo design', 'apparel branding', 'clothing brand identity',
        'brending kosmetiki', 'dizajn upakovki', 'salon krasoty', 'brend odezhdy'
      ]);
    }

    if (is3d) {
      addTags([
        '3d render', '3d modeling', 'blender 3d', 'cinema 4d render', 'octane render',
        '3d animation', 'cgi artist', 'motion graphics', 'motion design', '3d visualizer',
        'product visualization', '3d typography', 'character design', '3d illustration',
        '3д рендер', '3д моделирование', 'моушн дизайн', '3д визуализация', '3д графика'
      ]);
    }

    if (isMedical) {
      addTags([
        'логотип клиники', 'айдентика клиники', 'фирменный стиль клиники', 'логотип стоматологии',
        'айдентика стоматологии', 'медицинский брендинг', 'дизайн сайта клиники', 'медицинский центр',
        'clinic branding', 'dental logo', 'medical brand identity', 'healthcare branding',
        'dental branding', 'clinic logo design', 'medical logo', 'hospital branding'
      ]);
    }

    if (isFintech) {
      addTags([
        'финтех брендинг', 'логотип банка', 'айдентика финтех', 'дизайн финтех приложения',
        'крипто брендинг', 'логотип крипто', 'инвестиции брендинг', 'юридическая компания',
        'fintech branding', 'banking logo', 'crypto brand identity', 'fintech app design',
        'investment branding', 'financial logo', 'crypto branding', 'corporate identity fintech'
      ]);
    }

    // 4. ДОПОЛНИТЕЛЬНЫЙ ПАРСИНГ СЛОВ ИЗ НАЗВАНИЯ (СЛОВА ИЗ 2-3 СИМВОЛОВ И БОЛЕЕ)
    const titleWords = (project.title || '').toLowerCase().replace(/[^a-zа-я0-9\s]/gi, ' ').split(/\s+/).filter((w) => w.length >= 3);
    for (const w of titleWords) {
      if (!existingTagNames.has(w)) {
        suggestedTagsSet.add(w);
      }
    }

    const suggestedTags = Array.from(suggestedTagsSet).slice(0, 100);

    return {
      activeProject: project,
      plan: project.user.plan,
      tagBalance: project.user.tagBalance,
      lastAnalyzedAt: project.lastAnalyzedAt,
      tagsMatrix,
      suggestedTags,
      status: project.analysisStatus,
    };
  }

  async getUserProjects(userId: string) {
    return await this.prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { tags: { include: { tag: true } } },
    });
  }

  async deleteProject(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
      include: { user: true },
    });

    if (!project) {
      throw new NotFoundException('Проект не найден или нет прав на удаление');
    }

    // Проверка правила удаления для бесплатного тарифа (раз в 7 дней)
    if (project.user.plan === 'FREE') {
      const now = new Date();
      const createdAt = new Date(project.createdAt);
      const diffMs = now.getTime() - createdAt.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);

      if (diffDays < 7) {
        const remainingDays = Math.ceil(7 - diffDays);
        throw new BadRequestException(
          `На бесплатном тарифе удаление кейса доступно раз в 7 дней. До следующего удаления осталось ${remainingDays} дн. Перейдите на тариф Daily Fresh или Pro Stream для мгновенного удаления.`,
        );
      }
    }

    return await this.prisma.project.delete({
      where: { id: projectId },
    });
  }

  async removeTagFromProject(projectId: string, userId: string, tagName: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new NotFoundException('Проект не найден');
    }

    const tag = await this.prisma.tag.findUnique({
      where: { name: tagName },
    });

    if (!tag) {
      throw new NotFoundException('Тег не найден');
    }

    // Удаляем ТОЛЬКО связь с данным проектом (ProjectTag).
    // Сам Tag и история TagPositionHistory остаются в БД для сохранения глобальной статистики!
    await this.prisma.projectTag.deleteMany({
      where: {
        projectId,
        tagId: tag.id,
      },
    });

    return { success: true, message: `Тег #${tagName} удален из активного мониторинга проекта` };
  }

  async getProjectAnalyticsHistory(projectId: string, userId: string) {
    if (projectId === DEMO_PROJECT_ID || projectId === 'demo' || projectId.includes('demo')) {
      return { success: true, analytics: getDemoShowcaseHistory() };
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new NotFoundException('Проект не найден');
    }

    const history = await this.prisma.tagPositionHistory.findMany({
      where: { projectId },
      include: { tag: true },
      orderBy: { createdAt: 'asc' },
    });

    const formatted: Record<string, Array<{ date: string; rank: number }>> = {};
    for (const entry of history) {
      const tagName = entry.tag.name;
      const dateStr = entry.createdAt.toISOString().split('T')[0];
      if (!formatted[tagName]) formatted[tagName] = [];

      const existingIdx = formatted[tagName].findIndex((item) => item.date === dateStr);
      if (existingIdx !== -1) {
        formatted[tagName][existingIdx].rank = entry.rank;
      } else {
        formatted[tagName].push({ date: dateStr, rank: entry.rank });
      }
    }
    return { success: true, analytics: formatted };
  }

  async toggleTagOnChart(
    projectId: string,
    userId: string,
    tagName: string,
    state: boolean,
  ) {
    if (projectId === DEMO_PROJECT_ID || projectId === 'demo' || projectId.includes('demo')) {
      return { success: true };
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new NotFoundException('Проект не найден');
    }

    const tag = await this.prisma.tag.findUnique({ where: { name: tagName } });
    if (!tag) throw new NotFoundException('Тег не найден');

    return await this.prisma.projectTag.update({
      where: { projectId_tagId: { projectId, tagId: tag.id } },
      data: { onChart: state },
    });
  }

  async toggleSchedule(projectId: string, userId: string, state: boolean) {
    if (projectId === DEMO_PROJECT_ID || projectId === 'demo' || projectId.includes('demo')) {
      return DEMO_SHOWCASE_PROJECT;
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new NotFoundException('Проект не найден');
    }

    return await this.prisma.project.update({
      where: { id: projectId },
      data: { isScheduled: state },
    });
  }

  async toggleAllTagsOnChart(
    projectId: string,
    userId: string,
    state: boolean,
  ) {
    if (projectId === DEMO_PROJECT_ID || projectId === 'demo' || projectId.includes('demo')) {
      return { count: DEMO_SHOWCASE_TAGS_MATRIX.length };
    }

    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId },
    });

    if (!project) {
      throw new NotFoundException('Проект не найден');
    }

    return await this.prisma.projectTag.updateMany({
      where: { projectId },
      data: { onChart: state },
    });
  }

  async getDemoProject() {
    return DEMO_SHOWCASE_PROJECT;
  }

  async getAnalytics(userId: string) {
    const projectTags = await this.prisma.projectTag.findMany({
      where: { project: { userId } },
      include: { project: true, tag: true },
    });

    const tagsMap: Record<string, any> = {};
    for (const pt of projectTags) {
      const name = pt.tag.name;
      if (!tagsMap[name]) {
        tagsMap[name] = {
          tag: name,
          totalViews: 0,
          totalAppreciations: 0,
          totalComments: 0,
          count: 0,
          currentRank: pt.currentRank,
          onChart: pt.onChart,
        };
      }
      tagsMap[name].totalViews += pt.project.views;
      tagsMap[name].totalAppreciations += pt.project.appreciations;
      tagsMap[name].totalComments += pt.project.comments;
      tagsMap[name].count += 1;
    }

    const activeProject = await this.prisma.project.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { tags: { include: { tag: true } } },
    });

    return {
      user: { id: userId },
      activeProject,
      tagsMatrix: Object.values(tagsMap),
    };
  }

  // --- РАСШИРЕННАЯ АНАЛИТИКА ДЛЯ ДАШБОРДА ---

  async getDashboardSummary(userId: string) {
    const projects = await this.prisma.project.findMany({
      where: { userId },
      include: {
        tags: { include: { tag: true } },
      },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        plan: true,
        tagBalance: true,
        planExpiresAt: true,
      },
    });

    let totalViews = 0;
    let totalAppreciations = 0;
    let totalComments = 0;
    let top10Count = 0;
    let top50Count = 0;
    let top100Count = 0;
    let unrankedCount = 0;
    const rankedRanks: number[] = [];
    const uniqueTags = new Set<string>();
    const topTags: Array<{ tag: string; rank: number; projectTitle: string }> =
      [];

    for (const p of projects) {
      totalViews += p.views;
      totalAppreciations += p.appreciations;
      totalComments += p.comments;

      for (const pt of p.tags) {
        uniqueTags.add(pt.tag.name);
        if (pt.currentRank && pt.currentRank > 0) {
          rankedRanks.push(pt.currentRank);
          if (pt.currentRank <= 10) top10Count++;
          if (pt.currentRank <= 50) top50Count++;
          if (pt.currentRank <= 100) top100Count++;

          topTags.push({
            tag: pt.tag.name,
            rank: pt.currentRank,
            projectTitle: p.title,
          });
        } else {
          unrankedCount++;
        }
      }
    }

    topTags.sort((a, b) => a.rank - b.rank);
    const bestPerformingTags = topTags.slice(0, 5);

    const averageRank =
      rankedRanks.length > 0
        ? Math.round(
            (rankedRanks.reduce((sum, r) => sum + r, 0) / rankedRanks.length) *
              10,
          ) / 10
        : null;

    const bestRank = rankedRanks.length > 0 ? Math.min(...rankedRanks) : null;

    return {
      user,
      totalProjects: projects.length,
      totalTags: uniqueTags.size,
      totalViews,
      totalAppreciations,
      totalComments,
      rankDistribution: {
        top10: top10Count,
        top50: top50Count,
        top100: top100Count,
        unranked: unrankedCount,
      },
      averageRank,
      bestRank,
      bestPerformingTags,
    };
  }

  async getProjectsOverview(userId: string) {
    const projects = await this.prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        tags: { include: { tag: true } },
      },
    });

    return projects.map((p) => {
      const ranked = p.tags
        .map((pt) => pt.currentRank)
        .filter((r): r is number => r !== null && r > 0);

      const top10Count = ranked.filter((r) => r <= 10).length;
      const top50Count = ranked.filter((r) => r <= 50).length;
      const bestRank = ranked.length > 0 ? Math.min(...ranked) : null;
      const averageRank =
        ranked.length > 0
          ? Math.round(
              (ranked.reduce((a, b) => a + b, 0) / ranked.length) * 10,
            ) / 10
          : null;

      return {
        id: p.id,
        behanceId: p.behanceId,
        title: p.title,
        url: p.url,
        views: p.views,
        appreciations: p.appreciations,
        comments: p.comments,
        isScheduled: p.isScheduled,
        lastAnalyzedAt: p.lastAnalyzedAt,
        analysisStatus: p.analysisStatus,
        createdAt: p.createdAt,
        totalTags: p.tags.length,
        top10Count,
        top50Count,
        bestRank,
        averageRank,
      };
    });
  }
}
