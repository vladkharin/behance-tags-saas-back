import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // 1. Проверяем наличие пользователя из JWT Guard
    if (!user || !user.email) {
      throw new UnauthorizedException('Необходима авторизация');
    }

    // 2. Получаем список доверенных email владельца / администраторов
    const defaultAdmins = ['dom.craft.digital@gmail.com'];
    const envAdminsRaw = this.configService.get<string>('ADMIN_EMAILS') || '';
    const envAdmins = envAdminsRaw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);

    const allowedAdmins = new Set([...defaultAdmins, ...envAdmins]);

    const userEmail = (user.email || '').trim().toLowerCase();

    if (!allowedAdmins.has(userEmail)) {
      throw new ForbiddenException('Доступ разрешен только владельцу платформы');
    }

    return true;
  }
}
