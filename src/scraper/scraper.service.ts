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
import { randomUUID } from 'crypto';
import { AnalysisStatus } from '@prisma/client';

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
   * Инициализация браузера (Оптимизировано под Docker + Экономия трафика)
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
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        '/usr/bin/google-chrome-stable',
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
   * ЛОГИКА ИМПОРТА (Воркер)
   */
  async importCaseLogic(projectId: string, url: string, userId: string) {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisStatus: AnalysisStatus.PROCESSING },
    });

    let attempt = 0;
    let success = false;

    while (!success && attempt < this.MAX_RETRIES) {
      attempt++;
      const { browser, page } = await this.initBrowser();
      try {
        this.logger.log(`[Import] Попытка ${attempt} для ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise((r) => setTimeout(r, 6000));

        const cookies = await page.cookies();
        const bcp = cookies.find((c) => c.name === 'bcp')?.value || '';
        const idFromUrl = url.match(/gallery\/([0-9]+)/)?.[1];

        const data = await page.evaluate(
          async (id, bcpT) => {
            const ssrEl = document.querySelector('#ssr-state');
            if (ssrEl) {
              try {
                const state = JSON.parse(ssrEl.innerHTML);
                const findP = (obj: any): any => {
                  if (!obj || typeof obj !== 'object') return null;
                  if (obj.id && obj.name && Array.isArray(obj.tags)) return obj;
                  for (const k in obj) {
                    const f = findP(obj[k]);
                    if (f) return f;
                  }
                  return null;
                };
                const p = findP(state);
                if (p)
                  return {
                    id: String(p.id),
                    name: p.name,
                    tags: p.tags.map((t: any) =>
                      typeof t === 'string' ? t : t.title || t.name,
                    ),
                    stats: {
                      views: p.stats?.views || 0,
                      appreciations: p.stats?.appreciations || 0,
                    },
                  };
              } catch (e) {}
            }

            const GQL = `query ProjectPage($projectId: ProjectId!) { project(id: $projectId) { id name tags { title } stats { appreciations { all } views { all } } } }`;
            const r = await fetch('https://www.behance.net/v3/graphql', {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                'x-adobe-app': 'behance',
                'x-bcp': bcpT,
              },
              body: JSON.stringify({
                query: GQL,
                variables: { projectId: id },
              }),
            });
            const json = await r.json();
            const p = (Array.isArray(json) ? json[0] : json).data?.project;
            if (p)
              return {
                id: String(p.id),
                name: p.name,
                tags: p.tags.map((t: any) => t.title),
                stats: {
                  views: p.stats.views.all,
                  appreciations: p.stats.appreciations.all,
                },
              };
            return null;
          },
          idFromUrl,
          bcp,
        );

        if (!data) throw new Error('Empty API response');

        await this.prisma.$transaction(async (tx) => {
          await tx.project.update({
            where: { id: projectId },
            data: {
              behanceId: String(data.id),
              title: data.name,
              views: data.stats.views,
              appreciations: data.stats.appreciations,
            },
          });
          await tx.projectTag.deleteMany({ where: { projectId } });
          for (const t of data.tags) {
            const name = t.trim().toLowerCase();
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
        await this.queueProjectAnalysis(projectId);
      } catch (e) {
        await browser.close();
        if (attempt === this.MAX_RETRIES) {
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
   * ПРОДЮСЕР АНАЛИЗА
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
   * ВОРКЕР АНАЛИЗА
   */
  async analyzeProjectPositions(projectId: string, customTags?: string[]) {
    await this.prisma.project.update({
      where: { id: projectId },
      data: { analysisStatus: AnalysisStatus.PROCESSING },
    });
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        tags: { include: { tag: true }, orderBy: { tag: { name: 'asc' } } },
      },
    });
    if (!project) return;
    try {
      const combinedTags = Array.from(
        new Set([
          ...project.tags.map((pt) => pt.tag.name),
          ...(customTags || []),
        ]),
      )
        .map((t) => t.replace('#', '').trim().toLowerCase())
        .filter((t) => t.length > 0)
        .sort();

      for (const name of combinedTags) {
        const tRec = await this.prisma.tag.upsert({
          where: { name },
          update: {},
          create: { name },
        });
        await this.prisma.projectTag.upsert({
          where: { projectId_tagId: { projectId: project.id, tagId: tRec.id } },
          update: { currentRank: null },
          create: { projectId: project.id, tagId: tRec.id, currentRank: null },
        });
      }

      let instance: any = null;
      for (const tagName of combinedTags) {
        let tagSuccess = false;
        let tagAttempt = 0;
        while (!tagSuccess && tagAttempt < 5) {
          tagAttempt++;
          try {
            if (!instance) {
              instance = await this.initBrowser();
              await instance.page.goto(
                'https://www.behance.net/search/projects',
                { waitUntil: 'networkidle2', timeout: 30000 },
              );
              await new Promise((r) => setTimeout(r, 6000));
            }
            const bcp =
              (await instance.page.cookies()).find((c) => c.name === 'bcp')
                ?.value || '';
            const ids = await instance.page.evaluate(
              async (term, bcpT) => {
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
                    'x-bcp': bcpT,
                  },
                  body: JSON.stringify({
                    query,
                    variables: { query: term, filter: {}, first: 48 },
                  }),
                });
                const j = await r.json();
                return (
                  (Array.isArray(j) ? j[0] : j).data?.search?.nodes?.map(
                    (n: any) => String(n.id),
                  ) || []
                );
              },
              tagName,
              bcp,
            );

            const rank =
              ids.indexOf(project.behanceId) !== -1
                ? ids.indexOf(project.behanceId) + 1
                : -1;
            const tagRec = await this.prisma.tag.findUnique({
              where: { name: tagName },
            });
            await this.prisma.projectTag.update({
              where: {
                projectId_tagId: { projectId: project.id, tagId: tagRec!.id },
              },
              data: { currentRank: rank, updatedAt: new Date() },
            });
            if (rank !== -1)
              await this.prisma.tagPositionHistory.create({
                data: { projectId: project.id, tagId: tagRec!.id, rank },
              });
            tagSuccess = true;
          } catch (e) {
            if (instance) {
              await instance.browser.close();
              instance = null;
            }
            await new Promise((r) => setTimeout(r, 4000));
          }
        }
        if (!tagSuccess) {
          const tagRec = await this.prisma.tag.findUnique({
            where: { name: tagName },
          });
          await this.prisma.projectTag.update({
            where: {
              projectId_tagId: { projectId: project.id, tagId: tagRec!.id },
            },
            data: { currentRank: -1 },
          });
        }
      }
      if (instance) await instance.browser.close();
    } finally {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { analysisStatus: AnalysisStatus.IDLE },
      });
    }
  }

  // --- МЕТОДЫ ПОЛУЧЕНИЯ ДАННЫХ ---

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
}
