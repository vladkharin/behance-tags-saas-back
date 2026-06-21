import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('scraper-queue') private readonly scraperQueue: Queue,
  ) {}

  async importCase(url: string, userId: string) {
    let htmlResponse = '';

    // 1. Запуск Puppeteer браузера
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      this.logger.log(`[Puppeteer] Загрузка страницы: ${url}`);
      const page = await browser.newPage();

      await page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      );

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      htmlResponse = await page.content();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Puppeteer failed to fetch page: ${errorMessage}`);
      throw new InternalServerErrorException(
        `Ошибка загрузки страницы через Puppeteer: ${errorMessage}`,
      );
    } finally {
      await browser.close();
    }

    // 2. Инициализация Cheerio для поиска скрипта
    const $ = cheerio.load(htmlResponse);
    let scriptContent = $('#ssr-state').html();

    if (!scriptContent) {
      $('script').each((_, el) => {
        const content = $(el).html();
        if (
          content &&
          content.includes('project') &&
          (content.includes('tags') || content.includes('stats'))
        ) {
          scriptContent = content;
        }
      });
    }

    if (!scriptContent) {
      this.logger.error('Не удалось найти скрипт с данными на странице.');
      throw new BadRequestException(
        'Не удалось извлечь данные проекта. Проверьте правильность ссылки.',
      );
    }

    try {
      // 3. Парсинг JSON-контекста
      const parsedData = JSON.parse(scriptContent);

      // Вспомогательные переменные для сбора данных
      let behanceId = '';
      let title = '';
      let views = 0;
      let appreciations = 0;
      let rawTags: any[] = [];

      // Рекурсивная функция для поиска нужных полей в любой глубине JSON структуры Behance
      const findDataDeep = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;

        // Ищем полноценный объект проекта (у него обычно длинный числовой id и есть массив tags)
        if (
          obj.id &&
          (obj.name || obj.title) &&
          Array.isArray(obj.tags) &&
          obj.tags.length > 0
        ) {
          const parsedId = Number(obj.id);
          // Валидный id проекта на Behance обычно содержит много цифр (не 4-значный)
          if (!isNaN(parsedId) && parsedId > 100000) {
            behanceId = String(obj.id);
            title = obj.name || obj.title;
            rawTags = obj.tags;

            if (obj.stats) {
              const v = Number(obj.stats.owners?.views ?? obj.stats.views);
              const a = Number(
                obj.stats.owners?.appreciations ?? obj.stats.appreciations,
              );
              if (!isNaN(v)) views = v;
              if (!isNaN(a)) appreciations = a;
            }
            return; // Нашли главный объект, можем не углубляться в него
          }
        }

        // Запасной сбор метрик, если они лежат отдельно
        if (obj.views || obj.appreciations) {
          const v = Number(obj.views);
          const a = Number(obj.appreciations);
          if (!isNaN(v) && v > views) views = v;
          if (!isNaN(a) && a > appreciations) appreciations = a;
        }

        // Рекурсивно идем глубже
        for (const key in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) {
            findDataDeep(obj[key]);
          }
        }
      };

      // Запускаем глубокий поиск по всему JSON
      findDataDeep(parsedData);

      // Пытаемся вытащить ID из URL регулярным выражением, если в JSON попался некорректный ID
      const match = url.match(/gallery\/([0-9]+)/);
      if (match?.[1]) {
        behanceId = match[1];
      }

      // Дополнительная защита на случай, если метрики остались NaN
      if (isNaN(views)) views = 0;
      if (isNaN(appreciations)) appreciations = 0;

      // Нормализуем теги
      const tags: string[] = rawTags
        .map((t) => {
          if (typeof t === 'string') return t;
          if (t && typeof t === 'object') return t.title ?? t.name ?? t.label;
          return undefined;
        })
        .filter((t): t is string => Boolean(t));

      if (!title || title === 'Untitled Project') {
        const metaTitle =
          $('meta[property="og:title"]').attr('content') || $('title').text();
        if (metaTitle) {
          title = metaTitle.split(' on Behance')[0].trim();
        } else {
          title = 'Untitled Project';
        }
      }

      this.logger.log(
        `[Scraper] Собрано. ID: ${behanceId}, Title: "${title}", Тегов: ${tags.length}, Просмотров: ${views}, Лайков: ${appreciations}`,
      );

      if (!behanceId) {
        throw new Error('Не удалось определить уникальный Behance ID проекта.');
      }

      // 4. Сохранение в базу данных через Prisma transaction с исправленной структурой связей
      const result = await this.prisma.$transaction(async (tx) => {
        const project = await tx.project.upsert({
          where: { behanceId },
          update: {
            title,
            views,
            appreciations,
            url,
            // Для апдейта можно использовать обычный коннект или userId (в зависимости от вашей схемы, сделаем оба варианта безопасно)
            user: { connect: { id: userId } },
          },
          create: {
            behanceId,
            title,
            views,
            appreciations,
            url,
            // Исправленная связь с User согласно требованиям вашей Prisma схемы:
            user: { connect: { id: userId } },
          },
        });

        // Стираем старые связи тегов текущего проекта
        await tx.projectTag.deleteMany({
          where: { projectId: project.id },
        });

        // Создаем новые связи
        for (const tagName of tags) {
          const cleanTagName = tagName.trim().toLowerCase();
          if (!cleanTagName) continue;

          const tagRecord = await tx.tag.upsert({
            where: { name: cleanTagName },
            update: {},
            create: { name: cleanTagName },
          });

          await tx.projectTag.create({
            data: {
              projectId: project.id,
              tagId: tagRecord.id,
            },
          });
        }

        return {
          projectId: project.id,
          title: project.title,
          tagsCount: tags.length,
        };
      });

      return {
        success: true,
        data: result,
      };
    } catch (parseError: unknown) {
      const parseErrorMessage =
        parseError instanceof Error ? parseError.message : String(parseError);
      this.logger.error(
        `Ошибка парсинга или сохранения данных в БД: ${parseErrorMessage}`,
      );
      throw new InternalServerErrorException(
        `Не удалось обработать данные проекта: ${parseErrorMessage}`,
      );
    }
  }

  async analyzeProjectPositions(projectId: string) {
    // 1. Получаем проект и все его теги из базы данных
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        tags: {
          include: { tag: true },
        },
      },
    });

    if (!project) {
      throw new BadRequestException('Проект не найден в базе данных');
    }

    this.logger.log(
      `[Analytics] Начинаем замер позиций для: "${project.title}" (${project.behanceId})`,
    );

    // 2. Запуск браузера Puppeteer
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    );

    const resultsSummary: Array<{ tag: string; rank: number | string }> = [];

    try {
      // 3. Сканируем поисковую выдачу по каждому тегу проекта
      for (const projectTagRelation of project.tags) {
        const tagName = projectTagRelation.tag.name;
        // Кодируем тег, чтобы пробелы или символы типа UI/UX не ломали URL
        const searchUrl = `https://www.behance.net/search/projects?search=${encodeURIComponent(tagName)}`;

        this.logger.log(`[Analytics] Загрузка выдачи по тегу: "#${tagName}"`);

        await page.goto(searchUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });

        // Небольшая пауза, чтобы скрипты Behance отработали
        await new Promise((res) => setTimeout(res, 2000));

        // Делаем легкий скролл вниз, чтобы стриггерить ленивую загрузку карточек и расширить охват до ~48-100 проектов
        await page.evaluate(() => {
          window.scrollBy(0, window.innerHeight * 2);
        });
        await new Promise((res) => setTimeout(res, 1500));

        const htmlContent = await page.content();
        const $ = cheerio.load(htmlContent);

        let foundProjectIds: string[] = [];

        // --- СПОСОБ 1: Ищем JSON-стейт выдачи (самый точный способ) ---
        let scriptContent = $('#ssr-state').html();
        if (!scriptContent) {
          $('script').each((_, el) => {
            const content = $(el).html();
            if (
              content &&
              content.includes('search') &&
              content.includes('projects')
            ) {
              scriptContent = content;
            }
          });
        }

        if (scriptContent) {
          try {
            const parsedState = JSON.parse(scriptContent);

            // Вспомогательная функция для рекурсивного поиска массивов с ID проектов
            const extractIdsDeep = (obj: any) => {
              if (!obj || typeof obj !== 'object') return;

              // Если нашли массив объектов, у которых есть id и с большой вероятностью это проекты
              if (Array.isArray(obj)) {
                for (const item of obj) {
                  if (
                    item &&
                    item.id &&
                    (item.owners || item.stats || item.slug)
                  ) {
                    const idStr = String(item.id);
                    if (!foundProjectIds.includes(idStr)) {
                      foundProjectIds.push(idStr);
                    }
                  }
                }
              }

              for (const key in obj) {
                if (Object.prototype.hasOwnProperty.call(obj, key)) {
                  extractIdsDeep(obj[key]);
                }
              }
            };

            extractIdsDeep(parsedState);
          } catch (e) {
            this.logger.debug(
              '[Analytics] Не удалось распарсить JSON-стейт поиска, переключаемся на HTML-парсер.',
            );
          }
        }

        // --- СПОСОБ 2: Фолбэк на HTML-ссылки карточек (если JSON пустой) ---
        if (foundProjectIds.length === 0) {
          $('a[href*="/gallery/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (href) {
              const match = href.match(/gallery\/([0-9]+)/);
              if (match?.[1]) {
                const id = match[1];
                if (!foundProjectIds.includes(id)) {
                  foundProjectIds.push(id);
                }
              }
            }
          });
        }

        // 4. Определение позиции нашего проекта в массиве результатов
        const targetId = project.behanceId;
        const index = foundProjectIds.indexOf(targetId);

        let rank = -1; // -1 значит "Вне топа выдачи"
        if (index !== -1) {
          rank = index + 1; // Переводим в человеческий формат (индексы с 1)
        }

        this.logger.log(
          `[Analytics] Результат для "#${tagName}": место ${rank === -1 ? 'Вне ТОП' : rank} (Всего найдено в ленте: ${foundProjectIds.length})`,
        );

        // 5. Записываем текущую позицию в связующую таблицу по составному ключу
        await this.prisma.projectTag.update({
          where: {
            projectId_tagId: {
              projectId: project.id,
              tagId: projectTagRelation.tagId,
            },
          },
          data: {
            currentRank: rank === -1 ? null : rank,
            updatedAt: new Date(),
          },
        });

        // 6. Записываем историческую точку для будущих графиков (только если проект в ТОПе)
        if (rank !== -1) {
          await this.prisma.tagPositionHistory.create({
            data: {
              projectId: project.id,
              tagId: projectTagRelation.tagId,
              rank: rank,
            },
          });
        }

        resultsSummary.push({
          tag: tagName,
          rank: rank === -1 ? 'Вне ТОП-100' : rank,
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Ошибка при анализе позиций: ${msg}`);
      throw new InternalServerErrorException(`Ошибка анализа позиций: ${msg}`);
    } finally {
      await browser.close();
    }

    return {
      success: true,
      projectId: project.id,
      projectTitle: project.title,
      results: resultsSummary,
    };
  }

  async getProjectAnalyticsHistory(projectId: string) {
    // Вычисляем дату ровно 30 дней назад
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Тянем из базы историю позиций для этого проекта за последние 30 дней
    const history = await this.prisma.tagPositionHistory.findMany({
      where: {
        projectId: projectId,
        createdAt: {
          gte: thirtyDaysAgo, // Greater than or equal (больше или равно 30 дней назад)
        },
      },
      include: {
        tag: true, // Чтобы знать человеческое название тега, а не только UUID
      },
      orderBy: {
        createdAt: 'asc', // Сортируем от старых к новым, чтобы график шёл слева направо
      },
    });

    // Форматируем данные, чтобы фронтенду было максимально удобно их парсить для графиков (например, под Recharts или Chart.js)
    // Сгруппируем историю по тегам
    const formattedAnalytics: Record<
      string,
      Array<{ date: string; rank: number }>
    > = {};

    for (const entry of history) {
      const tagName = entry.tag.name;

      if (!formattedAnalytics[tagName]) {
        formattedAnalytics[tagName] = [];
      }

      formattedAnalytics[tagName].push({
        // Превращаем дату в красивый формат (например, "2026-06-18" или "18.06")
        date: entry.createdAt.toISOString().split('T')[0],
        rank: entry.rank,
      });
    }

    return {
      success: true,
      projectId,
      period: 'last_30_days',
      analytics: formattedAnalytics,
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleDailyPositionsUpdate() {
    this.logger.log(
      '[Cron] Собираем проекты для постановки в очередь BullMQ...',
    );

    const allProjects = await this.prisma.project.findMany({
      select: { id: true },
    });

    for (const project of allProjects) {
      // Закидываем проект в очередь. BullMQ сам распределит задачи!
      await this.scraperQueue.add(
        'analyze-project',
        { projectId: project.id },
        {
          attempts: 3, // Если упадет — попробует еще 2 раза
          backoff: 10000, // Пауза 10 секунд перед повтором
        },
      );
    }
    this.logger.log(
      `[Cron] Успешно добавлено ${allProjects.length} задач в очередь.`,
    );
  }

  // 2. Метод, который мы вызовем из контроллера для ручного запуска
  async queueProjectAnalysis(projectId: string) {
    const job = await this.scraperQueue.add(
      'analyze-project',
      { projectId },
      { attempts: 2 },
    );

    return {
      success: true,
      message: 'Задача на анализ позиций успешно добавлена в очередь',
      jobId: job.id,
    };
  }

  async getAnalytics(userId: string) {
    // 1. Тянем из базы все теги для проектов этого пользователя
    const projectTags = await this.prisma.projectTag.findMany({
      where: {
        project: {
          userId: userId,
        },
      },
      include: {
        project: true,
        tag: true,
      },
    });

    // 2. Агрегируем метрики по именам тегов
    const tagsMap: Record<
      string,
      {
        tag: string;
        totalViews: number;
        totalAppreciations: number;
        count: number;
      }
    > = {};

    for (const pt of projectTags) {
      const tagName = pt.tag.name;
      if (!tagsMap[tagName]) {
        tagsMap[tagName] = {
          tag: tagName,
          totalViews: 0,
          totalAppreciations: 0,
          count: 0,
        };
      }

      tagsMap[tagName].totalViews += pt.project.views;
      tagsMap[tagName].totalAppreciations += pt.project.appreciations;
      tagsMap[tagName].count += 1;
    }

    // Превращаем карту в массив (формат TagAnalytics[] для фронтенда)
    const tagsMatrix = Object.values(tagsMap);

    // Находим последний активный/проверяемый проект пользователя (для отображения на дашборде)
    const activeProject = await this.prisma.project.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      user: {
        id: userId,
        // Тут можно вытащить username из таблицы User, если нужно
      },
      activeProject: activeProject
        ? {
            id: activeProject.id,
            url: activeProject.url,
            userId: activeProject.userId,
            createdAt: activeProject.createdAt.toISOString(),
          }
        : null,
      tagsMatrix,
      isScraping: false, // Настоящий статус завяжем на BullMQ ниже 👇
    };
  }
}
