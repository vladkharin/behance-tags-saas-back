import { Test, TestingModule } from '@nestjs/testing';
import { RobokassaService } from './robokassa.service';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

describe('RobokassaService', () => {
  let service: RobokassaService;
  let config: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RobokassaService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'ROBO_MERCHANT_LOGIN') return 'test_merchant';
              if (key === 'ROBO_PASSWORD_1') return 'pass1';
              if (key === 'ROBO_PASSWORD_2') return 'pass2';
              if (key === 'ROBO_IS_TEST') return '0';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<RobokassaService>(RobokassaService);
    config = module.get(ConfigService);
  });

  describe('Signature Verification', () => {
    it('verifies valid Robokassa signature using timingSafeEqual', () => {
      const amount = '890';
      const invId = '123';
      const userId = 'user-456';
      const pass2 = 'pass2';

      const validSig = crypto
        .createHash('md5')
        .update(`${amount}:${invId}:${pass2}:shp_userId=${userId}`)
        .digest('hex');

      const isValid = service.verifySignature(amount, invId, validSig, userId);
      expect(isValid).toBe(true);
    });

    it('rejects tampered Robokassa signature', () => {
      const isValid = service.verifySignature(
        '890',
        '123',
        'invalid_signature_hash',
        'user-456',
      );
      expect(isValid).toBe(false);
    });
  });
});
