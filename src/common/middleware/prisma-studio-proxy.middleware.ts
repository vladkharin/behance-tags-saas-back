import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response } from 'express';

@Injectable()
export class PrismaStudioProxyMiddleware implements NestMiddleware {
  use(req: Request, res: Response) {
    const rawHost = req.headers.host || '';
    const hostname = rawHost.split(':')[0] || 'localhost';
    const protocol = req.protocol || 'http';
    const studioPort = process.env.PRISMA_STUDIO_PROXY_PORT || '5555';

    res.redirect(302, `${protocol}://${hostname}:${studioPort}/`);
  }
}
