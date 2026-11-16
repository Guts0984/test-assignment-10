import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import { Public, SkipRateLimit } from '../auth/decorators';
import { CTX, type AppCtx } from '../ctx';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(@Inject(CTX) private readonly ctx: AppCtx) {}

  @Public()
  @SkipRateLimit()
  @Get()
  async health(): Promise<{ status: 'ok'; time: string }> {
    await this.ctx.db.execute(sql`SELECT 1`);
    return { status: 'ok', time: this.ctx.clock.now().toISOString() };
  }
}
