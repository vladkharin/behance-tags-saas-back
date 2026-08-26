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
      proxyErrorHandler: (err, res, next) => {
        if (err && (err as any).code === 'ECONNREFUSED') {
          res.status(530).send(`
            <!DOCTYPE html>
            <html>
              <head><title>Prisma Studio Launching</title></head>
              <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0f0f13; color: white;">
                <h2>🔄 Prisma Studio поднимается...</h2>
                <p style="opacity: 0.7;">Пожалуйста, обновите страницу через 5-10 секунд.</p>
                <button onclick="location.reload()" style="padding: 10px 20px; background: #0057ff; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: bold;">
                  Обновить страницу
                </button>
              </body>
            </html>
          `);
          return;
        }
        next(err);
      },
    });
  }

  use(req: Request, res: Response, next: NextFunction) {
    this.proxyHandler(req, res, next);
  }
}
