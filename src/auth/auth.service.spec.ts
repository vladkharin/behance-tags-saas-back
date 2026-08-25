import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail/mail.service';

describe('AuthService', () => {
  let service: AuthService;
  let prismaService: any;
  let jwtService: any;

  beforeEach(async () => {
    prismaService = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    jwtService = {
      sign: jest.fn().mockReturnValue('mock_jwt_token'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaService },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'ADMIN_EMAILS') return 'dom.craft.digital@gmail.com, admin@test.com';
              return null;
            }),
          },
        },
        {
          provide: MailService,
          useValue: {
            sendVerificationCode: jest.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('checkIsAdmin', () => {
    it('should return true for configured admin emails', () => {
      expect(service.checkIsAdmin('dom.craft.digital@gmail.com')).toBe(true);
      expect(service.checkIsAdmin('admin@test.com')).toBe(true);
    });

    it('should return false for non-admin email', () => {
      expect(service.checkIsAdmin('user@example.com')).toBe(false);
    });
  });
});
