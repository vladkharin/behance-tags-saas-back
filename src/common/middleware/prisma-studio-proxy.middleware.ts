import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PrismaStudioProxyMiddleware implements NestMiddleware {
  private proxy: ReturnType<typeof createProxyMiddleware>;

  constructor(private readonly configService: ConfigService) {
    const targetHost =
      this.configService.get<string>('PRISMA_STUDIO_HOST') ||
      (process.env.NODE_ENV === 'production' ? 'prisma-studio' : '127.0.0.1');
    const targetPort =
      this.configService.get<string>('PRISMA_STUDIO_PORT') || '5555';

    this.proxy = createProxyMiddleware({
      target: `http://${targetHost}:${targetPort}`,
      changeOrigin: true,
      pathRewrite: {
        '^/admin/studio': '',
      },
      ws: true,
    });
  }

  use(req: Request, res: Response, next: NextFunction) {
    this.proxy(req, res, next);
  }
}
