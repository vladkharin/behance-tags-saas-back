import { Test, TestingModule } from '@nestjs/testing';
import { ScraperService } from './scraper.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

describe('ScraperService', () => {
  let service: ScraperService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScraperService,
        {
          provide: PrismaService,
          useValue: {
            project: {
              findFirst: jest.fn(),
              findMany: jest.fn(),
            },
            tagPositionHistory: {
              findMany: jest.fn(),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: 'BullQueue_scraper-queue',
          useValue: {
            add: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ScraperService>(ScraperService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getDemoProject', () => {
    it('should return the static showcase demo project with top ranks and tags', async () => {
      const demo = await service.getDemoProject();
      expect(demo).toBeDefined();
      expect(demo.id).toBe('demo-showcase-project');
      expect(demo.views).toBeGreaterThan(40000);
      expect(demo.title).toContain('LOOP');
    });
  });

  describe('getSingleProjectAnalytics (Demo Mode)', () => {
    it('should return showcase tags matrix and analytics payload for demo ID', async () => {
      const result = await service.getSingleProjectAnalytics('demo-showcase-project', 'any-user');
      expect(result).toBeDefined();
      expect(result.activeProject.id).toBe('demo-showcase-project');
      expect(result.tagsMatrix.length).toBeGreaterThanOrEqual(15);
      expect(result.suggestedTags.length).toBeGreaterThanOrEqual(20);
    });
  });

  describe('getProjectAnalyticsHistory (Demo Mode)', () => {
    it('should return history timeline data for demo project', async () => {
      const result = await service.getProjectAnalyticsHistory('demo-showcase-project', 'any-user');
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.analytics['motion design']).toBeDefined();
      expect(result.analytics['motion design'].length).toBe(14);
    });
  });
});
