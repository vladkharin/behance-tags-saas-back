import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { ConfigService } from '@nestjs/config';
import proxy from 'express-http-proxy';

@Injectable()
export class PrismaStudioProxyMiddleware implements NestMiddleware {
  private proxyHandler: (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => void;

  constructor(private readonly configService: ConfigService) {
    const targetHost =
      this.configService.get<string>('PRISMA_STUDIO_HOST') ||
      (process.env.NODE_ENV === 'production' ? 'prisma-studio' : '127.0.0.1');
    const targetPort =
      this.configService.get<string>('PRISMA_STUDIO_PORT') || '5555';

    this.proxyHandler = proxy(`${targetHost}:${targetPort}`, {
      proxyReqPathResolver: (req) => {
        const path = req.originalUrl.replace(/^\/admin\/studio/, '');
        return path || '/';
      },
    });
  }

  use(req: Request, res: Response, next: NextFunction) {
    this.proxyHandler(req, res, next);
  }
}
