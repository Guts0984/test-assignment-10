import { z } from 'zod';
import { isoDate } from './common';

export const MAX_REPORT_DAYS = 366;

export const salesQuerySchema = z
  .object({ from: isoDate, to: isoDate })
  .refine((v) => v.from <= v.to, { message: 'from must be <= to', path: ['from'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < MAX_REPORT_DAYS, {
    message: `period must not exceed ${MAX_REPORT_DAYS} days`,
    path: ['to'],
  })
  .refine((v) => !Number.isNaN(Date.parse(v.from)) && !Number.isNaN(Date.parse(v.to)), {
    message: 'invalid date',
    path: ['from'],
  });
export type SalesQuery = z.infer<typeof salesQuerySchema>;

export const salesReportSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** paid orders' totals minus everything refunded on them */
  netRevenue: z.number().int(),
  orders: z.number().int(),
  averageCheck: z.number().int(),
  topProducts: z.array(
    z.object({
      productId: z.string(),
      name: z.string(),
      units: z.number().int(),
      revenue: z.number().int(),
    }),
  ),
  byDay: z.array(
    z.object({ day: z.string(), revenue: z.number().int(), orders: z.number().int() }),
  ),
});
export type SalesReport = z.infer<typeof salesReportSchema>;
