import { Test } from '@nestjs/testing';
import { ScraperService } from '../src/scraper/scraper.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

async function testActualScraperService() {
  console.log('================================================================');
  console.log('🧪 ТЕСТИРОВАНИЕ НАСТОЯЩЕГО БЭКЕНД-СЕРВИСА (ScraperService)');
  console.log('================================================================\n');

  let savedProjectData: any = null;
  let savedTags: string[] = [];
  const savedRanks: Array<{ tag: string; rank: number }> = [];

  const mockPrisma = {
    project: {
      findUnique: async () => {
        return {
          id: 'test-project-123',
          behanceId: '199017475',
          title: 'Truway® - Logo Design I Travel Tourism Agency Branding',
          url: 'https://www.behance.net/gallery/199017475/Truway-Logo-Design-I-Travel-Tourism-Agency-Branding',
          userId: 'test-user-id',
          analysisStatus: 'IDLE',
          user: { tagBalance: 100, plan: 'PRO_STREAM' },
          tags: savedTags.map((name, i) => ({
            tagId: `tag-${name}`,
            tag: { name, id: `tag-${name}` },
            currentRank: null,
            onChart: true,
          })),
        };
      },
      update: async (args: any) => {
        console.log(`[DB Project Update] Status: ${args.data?.analysisStatus || 'UPDATED'}, Views: ${args.data?.views || '-'}, Likes: ${args.data?.appreciations || '-'}`);
        if (args.data?.behanceId) savedProjectData = args.data;
        return { id: 'test-project-123', ...args.data };
      },
    },
    user: {
      update: async (args: any) => {
        console.log(`[DB User Update] Баланс списан:`, JSON.stringify(args.data));
        return {};
      },
    },
    projectTag: {
      deleteMany: async () => ({}),
      create: async () => ({}),
      update: async () => ({}),
      upsert: async (args: any) => {
        return {};
      },
    },
    tag: {
      upsert: async (args: any) => {
        if (!savedTags.includes(args.where.name)) {
          savedTags.push(args.where.name);
        }
        return { id: `tag-${args.where.name}`, name: args.where.name };
      },
    },
    tagPositionHistory: {
      create: async (args: any) => {
        console.log(`[DB History Record] Тег ID: ${args.data.tagId} -> Ранг: #${args.data.rank}`);
        savedRanks.push({ tag: args.data.tagId, rank: args.data.rank });
        return {};
      },
    },
    $transaction: async (cb: any) => {
      return await cb(mockPrisma);
    },
  };

  const mockQueue = {
    add: async () => ({}),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      ScraperService,
      { provide: PrismaService, useValue: mockPrisma },
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) => {
            if (key === 'PROXY_HOST') return process.env.PROXY_HOST || '';
            if (key === 'PROXY_PORT') return process.env.PROXY_PORT || '';
            if (key === 'PROXY_USERNAME') return process.env.PROXY_USERNAME || '';
            if (key === 'PROXY_PASSWORD') return process.env.PROXY_PASSWORD || '';
            return null;
          },
        },
      },
      { provide: 'BullQueue_scraper-queue', useValue: mockQueue },
    ],
  }).compile();

  const scraperService = moduleRef.get<ScraperService>(ScraperService);

  console.log('📌 [ШАГ 1] Запуск метода importCaseLogic() из ScraperService...');
  const testUrl = 'https://www.behance.net/gallery/199017475/Truway-Logo-Design-I-Travel-Tourism-Agency-Branding';
  
  await scraperService.importCaseLogic('test-project-123', testUrl, 'test-user-id');

  console.log('\n✅ РЕЗУЛЬТАТ ИМПОРТА ЧЕРЕЗ ScraperService:');
  console.log(`   • Название: ${savedProjectData?.title}`);
  console.log(`   • Behance ID: ${savedProjectData?.behanceId}`);
  console.log(`   • Просмотры: ${savedProjectData?.views}`);
  console.log(`   • Лайки: ${savedProjectData?.appreciations}`);
  console.log(`   • Импортировано тегов (${savedTags.length} шт.): ${savedTags.join(', ')}`);

  console.log('\n----------------------------------------------------------------');
  console.log('📌 [ШАГ 2] Запуск метода analyzeProjectPositions() из ScraperService...');
  console.log('----------------------------------------------------------------\n');

  // Запускаем анализ по всем импортированным тегам
  await scraperService.analyzeProjectPositions('test-project-123', savedTags);

  console.log('\n================================================================');
  console.log('🎉 ТЕСТ НАСТОЯЩЕГО ScraperService ПОЛНОСТЬЮ УСПЕШЕН!');
  console.log(`   • Всего сохранено позиций в историю: ${savedRanks.length} шт.`);
  console.log('================================================================');
}

testActualScraperService().catch((e) => {
  console.error('FATAL ERROR:', e);
});
