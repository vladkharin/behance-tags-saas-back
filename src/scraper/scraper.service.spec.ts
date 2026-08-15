import { Test, TestingModule } from '@nestjs/testing';
import { ScraperService } from './scraper.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('ScraperService', () => {
  let service: ScraperService;
  let prisma: any;
  let queue: any;

  const mockPrisma = {
    project: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      upsert: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    tagPositionHistory: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    projectTag: {
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    tag: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };

  const mockQueue = {
    add: jest.fn(),
  };

  const mockConfig = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScraperService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
        { provide: 'BullQueue_scraper-queue', useValue: mockQueue },
      ],
    }).compile();

    service = module.get<ScraperService>(ScraperService);
    prisma = module.get(PrismaService);
    queue = module.get('BullQueue_scraper-queue');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Ownership & Security', () => {
    it('deleteProject throws NotFoundException if project does not belong to user', async () => {
      prisma.project.findFirst.mockResolvedValue(null);

      await expect(
        service.deleteProject('proj-1', 'user-2'),
      ).rejects.toThrow(NotFoundException);
    });

    it('deleteProject succeeds if project belongs to user', async () => {
      prisma.project.findFirst.mockResolvedValue({
        id: 'proj-1',
        userId: 'user-1',
      });
      prisma.project.delete.mockResolvedValue({ id: 'proj-1' });

      const result = await service.deleteProject('proj-1', 'user-1');
      expect(result.id).toBe('proj-1');
      expect(prisma.project.delete).toHaveBeenCalledWith({
        where: { id: 'proj-1' },
      });
    });

    it('queueImportCase rejects if project belongs to another user', async () => {
      prisma.project.findUnique.mockResolvedValue({
        id: 'proj-1',
        behanceId: '123456',
        userId: 'other-user',
      });

      await expect(
        service.queueImportCase(
          'https://www.behance.net/gallery/123456/Test',
          'my-user',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Analytics Calculations', () => {
    it('getDashboardSummary accurately calculates stats, tops and average rank', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1',
        email: 'test@example.com',
        plan: 'PRO_STREAM',
        tagBalance: 500,
      });

      prisma.project.findMany.mockResolvedValue([
        {
          id: 'p1',
          title: 'Project 1',
          views: 100,
          appreciations: 20,
          comments: 5,
          tags: [
            { tag: { name: 'branding' }, currentRank: 3 },
            { tag: { name: 'identity' }, currentRank: 15 },
          ],
        },
        {
          id: 'p2',
          title: 'Project 2',
          views: 200,
          appreciations: 40,
          comments: 10,
          tags: [
            { tag: { name: 'logo' }, currentRank: 55 },
            { tag: { name: 'unranked-tag' }, currentRank: null },
          ],
        },
      ]);

      const summary = await service.getDashboardSummary('u1');

      expect(summary.totalProjects).toBe(2);
      expect(summary.totalTags).toBe(4);
      expect(summary.totalViews).toBe(300);
      expect(summary.totalAppreciations).toBe(60);
      expect(summary.totalComments).toBe(15);
      expect(summary.rankDistribution.top10).toBe(1);
      expect(summary.rankDistribution.top50).toBe(2);
      expect(summary.rankDistribution.top100).toBe(3);
      expect(summary.rankDistribution.unranked).toBe(1);
      expect(summary.bestRank).toBe(3);
      // (3 + 15 + 55) / 3 = 73 / 3 = 24.3
      expect(summary.averageRank).toBe(24.3);
    });

    it('getSingleProjectAnalytics computes rankDelta and bestRank from history', async () => {
      prisma.project.findFirst.mockResolvedValue({
        id: 'p1',
        title: 'Project 1',
        user: { plan: 'PRO_STREAM', tagBalance: 100 },
        lastAnalyzedAt: new Date(),
        analysisStatus: 'IDLE',
        tags: [
          {
            tagId: 't1',
            tag: { name: 'branding' },
            currentRank: 5,
            onChart: true,
          },
        ],
      });

      // История: первое место 5 (текущее), до этого было 8, а лучшее когда-либо 2
      prisma.tagPositionHistory.findMany.mockResolvedValue([
        { tagId: 't1', rank: 5, createdAt: new Date('2026-08-15') },
        { tagId: 't1', rank: 8, createdAt: new Date('2026-08-14') },
        { tagId: 't1', rank: 2, createdAt: new Date('2026-08-10') },
      ]);

      const result = await service.getSingleProjectAnalytics('p1', 'u1');

      expect(result.tagsMatrix[0].tag).toBe('branding');
      expect(result.tagsMatrix[0].currentRank).toBe(5);
      expect(result.tagsMatrix[0].bestRank).toBe(2);
      expect(result.tagsMatrix[0].previousRank).toBe(8);
      expect(result.tagsMatrix[0].rankDelta).toBe(3); // 8 - 5 = +3 (улучшился на 3 позиции)
    });
  });
});
