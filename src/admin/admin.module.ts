import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from './guards/admin.guard';
import { ConfigModule } from '@nestjs/config';
import { BasicAuthMiddleware } from '../common/middleware/basic-auth.middleware';
import { PrismaStudioProxyMiddleware } from '../common/middleware/prisma-studio-proxy.middleware';

@Module({
  imports: [PrismaModule, AuthModule, ConfigModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
  exports: [AdminService, AdminGuard],
})
export class AdminModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(BasicAuthMiddleware, PrismaStudioProxyMiddleware)
      .forRoutes(
        { path: 'admin/studio', method: RequestMethod.ALL },
        { path: 'admin/studio/*', method: RequestMethod.ALL },
        { path: 'admin/studio/(.*)', method: RequestMethod.ALL },
      );
  }
}
