import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AdminAdjustBalanceDto,
  AdminGetPaymentsDto,
  AdminGetUsersDto,
  AdminUpdateUserPlanDto,
} from './dto/admin.dto';
import { subDays, startOfDay, endOfDay, format } from 'date-fns';

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  // 1. СВОДНАЯ СТАТИСТИКА БИЗНЕСА И СИСТЕМЫ (KPI)
  async getSummary() {
    const now = new Date();
    const todayStart = startOfDay(now);
    const sevenDaysAgo = subDays(now, 7);
    const thirtyDaysAgo = subDays(now, 30);

    // 1.1 Метрики пользователей
    const [
      totalUsers,
      newUsersToday,
      newUsers7d,
      newUsers30d,
      freeUsers,
      dailyFreshUsers,
      proStreamUsers,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
      this.prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: thirtyDaysAgo } } }),
      this.prisma.user.count({ where: { plan: 'FREE' } }),
      this.prisma.user.count({ where: { plan: 'DAILY_FRESH' } }),
      this.prisma.user.count({ where: { plan: 'PRO_STREAM' } }),
    ]);

    // 1.2 Финансовые метрики
    const successfulPayments = await this.prisma.payment.findMany({
      where: { status: 'SUCCESS' },
      select: { amount: true, currency: true, createdAt: true },
    });

    let totalRevenueRub = 0;
    let totalRevenueUsd = 0;
    for (const p of successfulPayments) {
      if (p.currency === 'USD') {
        totalRevenueUsd += p.amount;
      } else {
        totalRevenueRub += p.amount;
      }
    }

    const [pendingPaymentsCount, totalPaymentsCount] = await Promise.all([
      this.prisma.payment.count({ where: { status: 'PENDING' } }),
      this.prisma.payment.count(),
    ]);

    // 1.3 Метрики скрапера и проектов
    const [
      totalProjects,
      scheduledProjects,
      pendingJobs,
      processingJobs,
      totalTags,
    ] = await Promise.all([
      this.prisma.project.count(),
      this.prisma.project.count({ where: { isScheduled: true } }),
      this.prisma.project.count({ where: { analysisStatus: 'PENDING' } }),
      this.prisma.project.count({ where: { analysisStatus: 'PROCESSING' } }),
      this.prisma.tag.count(),
    ]);

    // 1.4 Динамика за последние 14 дней для графиков
    const fourteenDaysAgo = subDays(now, 14);
    const recentUsers = await this.prisma.user.findMany({
      where: { createdAt: { gte: fourteenDaysAgo } },
      select: { createdAt: true },
    });

    const recentPayments = await this.prisma.payment.findMany({
      where: {
        status: 'SUCCESS',
        createdAt: { gte: fourteenDaysAgo },
      },
      select: { amount: true, currency: true, createdAt: true },
    });

    const dailyTimelineMap: Record<
      string,
      { date: string; users: number; revenueRub: number; revenueUsd: number }
    > = {};

    for (let i = 13; i >= 0; i--) {
      const d = format(subDays(now, i), 'yyyy-MM-dd');
      dailyTimelineMap[d] = { date: d, users: 0, revenueRub: 0, revenueUsd: 0 };
    }

    for (const u of recentUsers) {
      const d = format(u.createdAt, 'yyyy-MM-dd');
      if (dailyTimelineMap[d]) {
        dailyTimelineMap[d].users += 1;
      }
    }

    for (const p of recentPayments) {
      const d = format(p.createdAt, 'yyyy-MM-dd');
      if (dailyTimelineMap[d]) {
        if (p.currency === 'USD') {
          dailyTimelineMap[d].revenueUsd += p.amount;
        } else {
          dailyTimelineMap[d].revenueRub += p.amount;
        }
      }
    }

    return {
      users: {
        total: totalUsers,
        today: newUsersToday,
        last7d: newUsers7d,
        last30d: newUsers30d,
        plans: {
          FREE: freeUsers,
          DAILY_FRESH: dailyFreshUsers,
          PRO_STREAM: proStreamUsers,
        },
      },
      finance: {
        totalRevenueRub,
        totalRevenueUsd,
        successfulCount: successfulPayments.length,
        pendingCount: pendingPaymentsCount,
        totalTransactions: totalPaymentsCount,
      },
      scraper: {
        totalProjects,
        scheduledProjects,
        pendingJobs,
        processingJobs,
        totalTags,
      },
      chartTimeline: Object.values(dailyTimelineMap),
    };
  }

  // 2. СПИСОК ПОЛЬЗОВАТЕЛЕЙ С ПОИСКОМ И ПАГИНАЦИЕЙ
  async getUsers(dto: AdminGetUsersDto) {
    const { search, plan, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (plan) {
      where.plan = plan;
    }
    if (search && search.trim()) {
      const query = search.trim();
      where.OR = [
        { email: { contains: query, mode: 'insensitive' } },
        { name: { contains: query, mode: 'insensitive' } },
        { id: { contains: query } },
      ];
    }

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          _count: {
            select: { projects: true, payments: true },
          },
          projects: {
            select: {
              id: true,
              title: true,
              views: true,
              appreciations: true,
              lastAnalyzedAt: true,
              analysisStatus: true,
            },
          },
        },
      }),
    ]);

    const formatted = users.map((u) => {
      const totalViews = u.projects.reduce((sum, p) => sum + p.views, 0);
      const totalLikes = u.projects.reduce(
        (sum, p) => sum + p.appreciations,
        0,
      );
      const latestAnalysis = u.projects
        .map((p) => p.lastAnalyzedAt)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

      return {
        id: u.id,
        email: u.email,
        name: u.name,
        plan: u.plan,
        tagBalance: u.tagBalance,
        planExpiresAt: u.planExpiresAt,
        projectsCount: u._count.projects,
        paymentsCount: u._count.payments,
        totalViews,
        totalLikes,
        lastAnalyzedAt: latestAnalysis || null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      };
    });

    return {
      items: formatted,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // 3. ПОЛНАЯ КАРТОЧКА ПОЛЬЗОВАТЕЛЯ
  async getUserDetails(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        projects: {
          include: {
            tags: {
              include: { tag: true },
              orderBy: { currentRank: 'asc' },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        payments: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      plan: user.plan,
      tagBalance: user.tagBalance,
      planExpiresAt: user.planExpiresAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      projects: user.projects.map((p) => ({
        id: p.id,
        behanceId: p.behanceId,
        title: p.title,
        url: p.url,
        views: p.views,
        appreciations: p.appreciations,
        comments: p.comments,
        isScheduled: p.isScheduled,
        analysisStatus: p.analysisStatus,
        lastAnalyzedAt: p.lastAnalyzedAt,
        createdAt: p.createdAt,
        tags: p.tags.map((pt) => ({
          tag: pt.tag.name,
          currentRank: pt.currentRank,
          onChart: pt.onChart,
        })),
      })),
      payments: user.payments,
    };
  }

  // 4. ИЗМЕНЕНИЕ ТАРИФА ПОЛЬЗОВАТЕЛЯ
  async updateUserPlan(userId: string, dto: AdminUpdateUserPlanDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Пользователь не найден');

    const updateData: any = { plan: dto.plan };
    if (dto.planExpiresAt !== undefined) {
      updateData.planExpiresAt = dto.planExpiresAt
        ? new Date(dto.planExpiresAt)
        : null;
    }

    return await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
    });
  }

  // 5. КОРРЕКТИРОВКА БАЛАНСА ТЕГОВ
  async adjustUserBalance(userId: string, dto: AdminAdjustBalanceDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Пользователь не найден');

    let newBalance = user.tagBalance;
    if (dto.mode === 'SET') {
      newBalance = Math.max(0, dto.amount);
    } else if (dto.mode === 'INCREMENT') {
      newBalance = Math.max(0, user.tagBalance + dto.amount);
    } else if (dto.mode === 'DECREMENT') {
      newBalance = Math.max(0, user.tagBalance - dto.amount);
    }

    return await this.prisma.user.update({
      where: { id: userId },
      data: { tagBalance: newBalance },
    });
  }

  // 6. СПИСОК ПЛАТЕЖЕЙ
  async getPayments(dto: AdminGetPaymentsDto) {
    const { status, provider, search, page = 1, limit = 20 } = dto;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (status) where.status = status;
    if (provider) where.provider = provider;
    if (search && search.trim()) {
      const q = search.trim();
      where.OR = [
        { user: { email: { contains: q, mode: 'insensitive' } } },
        { targetName: { contains: q, mode: 'insensitive' } },
        { externalId: { contains: q } },
      ];
    }

    const [total, payments] = await Promise.all([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, email: true, name: true },
          },
        },
      }),
    ]);

    return {
      items: payments,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // 7. ЖИВАЯ ЛЕНТА СОБЫТИЙ (ACTIVITY FEED)
  async getActivityFeed(limit = 30) {
    const [recentUsers, recentProjects, recentPayments] = await Promise.all([
      this.prisma.user.findMany({
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          plan: true,
        },
      }),
      this.prisma.project.findMany({
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, email: true } },
        },
      }),
      this.prisma.payment.findMany({
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, email: true } },
        },
      }),
    ]);

    const events: Array<{
      id: string;
      type: 'USER_REGISTER' | 'PROJECT_IMPORT' | 'PAYMENT' | 'ANALYSIS';
      title: string;
      description: string;
      userEmail: string;
      timestamp: Date;
      metadata?: any;
    }> = [];

    for (const u of recentUsers) {
      events.push({
        id: `user-${u.id}`,
        type: 'USER_REGISTER',
        title: 'Новая регистрация',
        description: `Зарегистрирован аккаунт ${u.email} (Тариф: ${u.plan})`,
        userEmail: u.email,
        timestamp: u.createdAt,
      });
    }

    for (const p of recentProjects) {
      events.push({
        id: `proj-${p.id}`,
        type: 'PROJECT_IMPORT',
        title: 'Подключен кейс',
        description: `Добавлен проект "${p.title || p.url}"`,
        userEmail: p.user?.email || 'Unknown',
        timestamp: p.createdAt,
        metadata: { url: p.url, behanceId: p.behanceId },
      });
    }

    for (const pay of recentPayments) {
      events.push({
        id: `pay-${pay.id}`,
        type: 'PAYMENT',
        title:
          pay.status === 'SUCCESS' ? 'Успешный платеж 💰' : 'Создан платеж',
        description: `${pay.amount} ${pay.currency} • ${pay.type} (${pay.targetName}) через ${pay.provider}`,
        userEmail: pay.user?.email || 'Unknown',
        timestamp: pay.createdAt,
        metadata: { status: pay.status, orderNumber: pay.orderNumber },
      });
    }

    // Сортируем все события по времени
    events.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    return events.slice(0, limit);
  }
}
