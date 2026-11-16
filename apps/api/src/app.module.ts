import { DynamicModule, Global, Module, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller';
import { AuthGuard, OriginGuard, RolesGuard } from './auth/guards';
import { CTX, type AppCtx } from './ctx';
import { AllExceptionsFilter } from './http/error.filter';
import { HealthController } from './health/health.controller';
import { CartController } from './cart/cart.controller';
import { JobsModule } from './jobs/jobs.module';
import { OrdersController } from './orders/orders.controller';
import { PaymentsController } from './payments/payments.controller';
import { ProductsController } from './products/products.controller';
import { PromosController } from './promos/promos.controller';
import { ReportsController } from './reports/reports.controller';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';

@Global()
@Module({})
export class CoreModule {
  static register(ctx: AppCtx): DynamicModule {
    return { module: CoreModule, providers: [{ provide: CTX, useValue: ctx }], exports: [CTX] };
  }
}

@Module({
  controllers: [
    AuthController,
    HealthController,
    ProductsController,
    CartController,
    PromosController,
    OrdersController,
    PaymentsController,
    ReportsController,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // order matters: origin check -> rate limit -> session -> role
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class BaseModule {}

export function buildAppModule(ctx: AppCtx, extra: Type<unknown>[] = []): DynamicModule {
  return {
    module: class AppModule {},
    imports: [CoreModule.register(ctx), BaseModule, JobsModule, ...extra],
  };
}
