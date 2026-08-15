import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Plan, PaymentStatus, PaymentProvider } from '@prisma/client';

export class AdminGetUsersDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(Plan)
  plan?: Plan;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

export class AdminUpdateUserPlanDto {
  @IsEnum(Plan)
  plan: Plan;

  @IsOptional()
  @IsString()
  planExpiresAt?: string;
}

export class AdminAdjustBalanceDto {
  @IsInt()
  amount: number;

  @IsEnum(['SET', 'INCREMENT', 'DECREMENT'])
  mode: 'SET' | 'INCREMENT' | 'DECREMENT';
}

export class AdminGetPaymentsDto {
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @IsOptional()
  @IsEnum(PaymentProvider)
  provider?: PaymentProvider;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
