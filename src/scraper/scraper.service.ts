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

    // Умные рекомендации кастомных тегов из названия кейса, комбинаций слов и ниши
    const existingTagNames = new Set(project.tags.map((t) => t.tag.name.toLowerCase().trim()));
    const suggestedTagsSet = new Set<string>();

    const rawTitle = `${project.title || ''} ${project.url || ''}`.toLowerCase();
    
    // 1. Популярные семантические связки по ключевым словам из названия
    const keywordMap: Record<string, string[]> = {
      логотип: ['разработка логотипа', 'логотип компании', 'логотипы', 'дизайн логотипа', 'логотип и айдентика'],
      logotip: ['логотип', 'разработка логотипа', 'логотип компании', 'dizajn logotipa', 'logo design'],
      'фирменный стиль': ['брендбук', 'айдентика', 'фирменный стиль компании', 'brand identity', 'гайдлайн'],
      firmennyj: ['фирменный стиль', 'брендбук', 'фирменный стиль компании', 'brand identity'],
      брендбук: ['брендбук компании', 'разработка брендбука', 'гайдлайн', 'айдентика бренда'],
      brendbuk: ['брендбук', 'брендбук компании', 'brand identity', 'логотип и фирменный стиль'],
      строитель: ['строительная компания', 'строительство', 'логотип строительной компании', 'брендбук строительство'],
      stroitel: ['строительная компания', 'строительство', 'логотип строительной компании', 'брендбук строительство'],
      производств: ['производство', 'логотип производство', 'брендбук производство', 'фирменный стиль производство'],
      proizvodstv: ['производство', 'логотип производство', 'брендбук производство', 'фирменный стиль производство'],
      недвижим: ['недвижимость', 'агентство недвижимости', 'девелопер', 'жк'],
      nedvizhim: ['недвижимость', 'агентство недвижимости', 'девелопмент'],
      интерьер: ['дизайн интерьера', 'interior design', 'визуализация интерьера', '3d интерьер'],
      interer: ['дизайн интерьера', 'interior design', '3d visualization'],
      сайт: ['дизайн сайта', 'веб-дизайн', 'landing page', 'ui/ux design', 'разработка сайта'],
      landing: ['landing page', 'лендинг', 'веб-дизайн', 'ui/ux', 'дизайн сайта'],
      упаковк: ['дизайн упаковки', 'упаковка', 'packaging design', 'этикетка'],
      upakovk: ['дизайн упаковки', 'упаковка', 'packaging design'],
      косметик: ['дизайн косметики', 'косметика', 'бьюти бренд', 'beauty branding'],
      кафе: ['брендинг ресторана', 'логотип кафе', 'айдентика кофейни', 'меню'],
      ресторан: ['брендинг ресторана', 'айдентика ресторана', 'логотип ресторана'],
    };

    for (const [key, relatedList] of Object.entries(keywordMap)) {
      if (rawTitle.includes(key)) {
        for (const rel of relatedList) {
          if (!existingTagNames.has(rel.toLowerCase())) {
            suggestedTagsSet.add(rel);
          }
        }
      }
    }

    // 2. Нишевые пресеты
    const allNichePresets: Record<string, string[]> = {
      branding: ['brand identity', 'logo design', 'typography', 'packaging', 'visual identity', 'corporate identity', 'editorial design'],
      ui: ['ui/ux', 'mobile app', 'figma', 'dashboard', 'landing page', 'web design', 'design system'],
      '3d': ['3d render', 'blender', 'cinema 4d', 'octane render', 'cgi', 'motion design'],
      photo: ['photography', 'art direction', 'photoshop', 'concept art'],
      illustration: ['vector art', 'digital illustration', 'character design', 'poster design'],
    };

    const projectContext = `${project.title} ${Array.from(existingTagNames).join(' ')}`.toLowerCase();
    for (const [niche, keywords] of Object.entries(allNichePresets)) {
      if (projectContext.includes(niche) || keywords.some((k) => projectContext.includes(k))) {
        for (const kw of keywords) {
          if (!existingTagNames.has(kw.toLowerCase())) {
            suggestedTagsSet.add(kw);
          }
        }
      }
    }

    // 3. Fallback универсальные теги
    if (suggestedTagsSet.size < 4) {
      const fallback = ['brand design', 'graphic designer', 'art direction', 'digital art', 'creative design'];
      for (const f of fallback) {
        if (!existingTagNames.has(f.toLowerCase())) suggestedTagsSet.add(f);
      }
    }

    const suggestedTags = Array.from(suggestedTagsSet).slice(0, 10);

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

  async toggleTagOnChart(
    projectId: string,
    userId: string,
    tagName: string,
    state: boolean,
  ) {
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

  private demoCache: { data: any; expiresAt: number } | null = null;

  async getDemoProject() {
    const now = Date.now();
    if (this.demoCache && this.demoCache.expiresAt > now) {
      return this.demoCache.data;
    }

    const project = await this.prisma.project.findFirst({
      where: { tagPositionHistories: { some: {} } },
      orderBy: { tagPositionHistories: { _count: 'desc' } },
      include: {
        tags: { include: { tag: true } },
      },
    });

    if (project) {
      this.demoCache = {
        data: project,
        expiresAt: now + 10 * 60 * 1000, // 10 минут
      };
    }

    return project;
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
