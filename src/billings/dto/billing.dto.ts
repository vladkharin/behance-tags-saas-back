import { IsEnum, IsIn, IsNotEmpty, IsString } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  @IsNotEmpty({ message: 'Target (тариф или пакет) обязателен' })
  target!: string;

  @IsIn(['PLAN', 'FUEL'], { message: 'type должен быть PLAN или FUEL' })
  type!: 'PLAN' | 'FUEL';

  @IsIn(['RUB', 'USD', 'EUR'], { message: 'currency должен быть RUB, USD или EUR' })
  currency!: 'RUB' | 'USD' | 'EUR';
}
