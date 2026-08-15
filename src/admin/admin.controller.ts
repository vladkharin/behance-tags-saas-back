import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from './guards/admin.guard';
import {
  AdminAdjustBalanceDto,
  AdminGetPaymentsDto,
  AdminGetUsersDto,
  AdminUpdateUserPlanDto,
} from './dto/admin.dto';

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * 1. Сводная статистика платформы (KPI, пользователи, финансы, скрапер)
   */
  @Get('summary')
  async getSummary() {
    return await this.adminService.getSummary();
  }

  /**
   * 2. Список пользователей с поиском и пагинацией
   */
  @Get('users')
  async getUsers(@Query() query: AdminGetUsersDto) {
    return await this.adminService.getUsers(query);
  }

  /**
   * 3. Детальная карточка конкретного пользователя
   */
  @Get('users/:id')
  async getUserDetails(@Param('id') id: string) {
    return await this.adminService.getUserDetails(id);
  }

  /**
   * 4. Изменение тарифа пользователя
   */
  @Patch('users/:id/plan')
  async updateUserPlan(
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserPlanDto,
  ) {
    return await this.adminService.updateUserPlan(id, dto);
  }

  /**
   * 5. Корректировка баланса тегов пользователя
   */
  @Patch('users/:id/balance')
  async adjustUserBalance(
    @Param('id') id: string,
    @Body() dto: AdminAdjustBalanceDto,
  ) {
    return await this.adminService.adjustUserBalance(id, dto);
  }

  /**
   * 6. Список всех платежей и транзакций
   */
  @Get('payments')
  async getPayments(@Query() query: AdminGetPaymentsDto) {
    return await this.adminService.getPayments(query);
  }

  /**
   * 7. Живая лента событий системы
   */
  @Get('activity')
  async getActivity(@Query('limit') limit?: number) {
    return await this.adminService.getActivityFeed(limit ? Number(limit) : 30);
  }
}
