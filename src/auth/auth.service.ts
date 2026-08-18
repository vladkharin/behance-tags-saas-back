import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail/mail.service';
import * as bcrypt from 'bcrypt';
import { RegisterDto, LoginDto, VerifyCodeDto, ResendCodeDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mailService: MailService,
  ) {}

  checkIsAdmin(email: string): boolean {
    const defaultAdmins = ['dom.craft.digital@gmail.com'];
    const envAdminsRaw = this.configService.get<string>('ADMIN_EMAILS') || '';
    const envAdmins = envAdminsRaw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0);

    const allowedAdmins = new Set([...defaultAdmins, ...envAdmins]);
    return allowedAdmins.has((email || '').trim().toLowerCase());
  }

  private generateOtpCode(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  async register(dto: RegisterDto) {
    const candidate = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
    });

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(dto.password, salt);
    const code = this.generateOtpCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 минут

    if (candidate) {
      if (candidate.isEmailVerified) {
        throw new ConflictException('Пользователь с таким email уже зарегистрирован');
      }

      // Если пользователь не завершил подтверждение ранее — обновляем пароль и отправляем новый код
      await this.prisma.user.update({
        where: { id: candidate.id },
        data: {
          passwordHash,
          name: dto.name || candidate.name,
          verificationCode: code,
          verificationCodeExpires: expiresAt,
        },
      });

      await this.mailService.sendVerificationCode(candidate.email, code, candidate.name || undefined);

      return {
        requiresVerification: true,
        email: candidate.email,
        message: 'Код подтверждения отправлен на вашу почту',
      };
    }

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase().trim(),
        passwordHash,
        name: dto.name,
        isEmailVerified: false,
        verificationCode: code,
        verificationCodeExpires: expiresAt,
      },
    });

    await this.mailService.sendVerificationCode(user.email, code, user.name || undefined);

    return {
      requiresVerification: true,
      email: user.email,
      message: 'Код подтверждения отправлен на вашу почту',
    };
  }

  async verifyEmailCode(dto: VerifyCodeDto) {
    const email = dto.email.toLowerCase().trim();
    const code = dto.code.trim();

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    if (user.isEmailVerified) {
      return this.generateToken(user.id, user.email);
    }

    if (!user.verificationCode || user.verificationCode !== code) {
      throw new BadRequestException('Неверный код подтверждения');
    }

    if (!user.verificationCodeExpires || user.verificationCodeExpires < new Date()) {
      throw new BadRequestException('Срок действия кода истек. Запросите новый код.');
    }

    // Успешная верификация
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        isEmailVerified: true,
        verificationCode: null,
        verificationCodeExpires: null,
      },
    });

    return this.generateToken(updatedUser.id, updatedUser.email);
  }

  async resendVerificationCode(dto: ResendCodeDto) {
    const email = dto.email.toLowerCase().trim();

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new NotFoundException('Пользователь не найден');
    }

    if (user.isEmailVerified) {
      throw new BadRequestException('Почта уже подтверждена. Вы можете войти в аккаунт.');
    }

    // Защита от частого спама: если код отправлен менее 60 секунд назад
    if (user.verificationCodeExpires) {
      const msRemaining = user.verificationCodeExpires.getTime() - Date.now();
      // 15 минут = 900 000 мс. Если осталось больше 14 минут (840 000 мс), прошло менее 60 сек
      if (msRemaining > 14 * 60 * 1000) {
        throw new BadRequestException('Пожалуйста, подождите 1 минуту перед повторным запросом кода.');
      }
    }

    const code = this.generateOtpCode();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 минут

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        verificationCode: code,
        verificationCodeExpires: expiresAt,
      },
    });

    await this.mailService.sendVerificationCode(user.email, code, user.name || undefined);

    return {
      success: true,
      message: 'Новый проверочный код отправлен на вашу почту',
    };
  }

  async login(dto: LoginDto) {
    const email = dto.email.toLowerCase().trim();
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException('Неверный email или пароль');
    }

    const isPasswordValid = await bcrypt.compare(
      dto.password,
      user.passwordHash,
    );
    if (!isPasswordValid) {
      throw new UnauthorizedException('Неверный email или пароль');
    }

    // Проверка верификации почты
    if (!user.isEmailVerified) {
      // Генерируем и отправляем свежий код для удобства входа
      const code = this.generateOtpCode();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          verificationCode: code,
          verificationCodeExpires: expiresAt,
        },
      });

      await this.mailService.sendVerificationCode(user.email, code, user.name || undefined);

      throw new ForbiddenException({
        statusCode: 403,
        error: 'REQUIRES_VERIFICATION',
        requiresVerification: true,
        email: user.email,
        message: 'Пожалуйста, подтвердите вашу почту. Проверочный код отправлен на ваш email.',
      });
    }

    return this.generateToken(user.id, user.email);
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        plan: true,
        tagBalance: true,
        planExpiresAt: true,
        createdAt: true,
        isEmailVerified: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('Пользователь не найден');
    }

    return {
      ...user,
      isAdmin: this.checkIsAdmin(user.email),
    };
  }

  private generateToken(userId: string, email: string) {
    const isAdmin = this.checkIsAdmin(email);
    const payload = { sub: userId, email, isAdmin };
    return {
      access_token: this.jwtService.sign(payload),
      user: userId,
      isAdmin,
    };
  }
}

