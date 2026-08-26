import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class BasicAuthMiddleware implements NestMiddleware {
  constructor(private readonly configService: ConfigService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Admin Area", charset="UTF-8"',
      );
      res.status(401).send('Authentication required for Admin area.');
      return;
    }

    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString(
      'utf8',
    );
    const [user, password] = credentials.split(':');

    const expectedUser =
      this.configService.get<string>('BULL_BOARD_USER') ||
      this.configService.get<string>('ADMIN_USER') ||
      'admin';
    const expectedPassword =
      this.configService.get<string>('BULL_BOARD_PASSWORD') ||
      this.configService.get<string>('ADMIN_PASSWORD') ||
      'vladMatrixQueues2026SafeAdmin';

    const userBuffer = Buffer.from(user || '');
    const expUserBuffer = Buffer.from(expectedUser);
    const passBuffer = Buffer.from(password || '');
    const expPassBuffer = Buffer.from(expectedPassword);

    const isUserValid =
      userBuffer.length === expUserBuffer.length &&
      crypto.timingSafeEqual(userBuffer, expUserBuffer);
    const isPassValid =
      passBuffer.length === expPassBuffer.length &&
      crypto.timingSafeEqual(passBuffer, expPassBuffer);

    if (!isUserValid || !isPassValid) {
      res.setHeader(
        'WWW-Authenticate',
        'Basic realm="Admin Area", charset="UTF-8"',
      );
      res.status(401).send('Invalid admin credentials.');
      return;
    }

    next();
  }
}
