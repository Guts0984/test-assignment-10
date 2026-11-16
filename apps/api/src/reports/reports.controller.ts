import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { salesReport } from '@shop/db';
import { salesQuerySchema, type SalesQuery, type SalesReport } from '@shop/shared';
import { Roles } from '../auth/decorators';
import { CTX, type AppCtx } from '../ctx';
import { ApiZQuery } from '../http/swagger-zod';
import { ZodPipe } from '../http/zod.pipe';

/**
 * Sales for [from, to] (UTC days, both inclusive). Counts orders that are paid / shipped / delivered
 * and were paid inside the period; revenue = totals minus everything refunded (returns). Orders cancelled after
 * payment are fully refunded and therefore not counted.
 */
@ApiTags('reports')
@Roles('manager')
@Controller('reports')
export class ReportsController {
  constructor(@Inject(CTX) private readonly ctx: AppCtx) {}

  @Get('sales')
  @ApiZQuery(salesQuerySchema)
  async sales(@Query(new ZodPipe(salesQuerySchema)) q: SalesQuery): Promise<SalesReport> {
    const from = new Date(`${q.from}T00:00:00.000Z`);
    const to = new Date(new Date(`${q.to}T00:00:00.000Z`).getTime() + 86_400_000);
    const r = await salesReport(this.ctx.db, from, to);
    return {
      from: q.from,
      to: q.to,
      netRevenue: r.netRevenue,
      orders: r.orders,
      averageCheck: r.orders === 0 ? 0 : Math.floor(r.netRevenue / r.orders),
      topProducts: r.topProducts,
      byDay: r.byDay,
    };
  }
}
