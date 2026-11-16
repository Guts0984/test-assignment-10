import { z } from 'zod';

export const uuid = z.uuid();
export const kopecks = z.number().int().min(0).max(1_000_000_000);
export const cursorSchema = z.string().min(1).max(500);
export const limitSchema = (def: number, max = 100) =>
  z.coerce.number().int().min(1).max(max).default(def);

/** `2026-02-30` matches the shape but is not a day: it must not silently become March 2. */
export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCFullYear(y); // years 0-99 are otherwise read as 19xx
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isRealDate, 'not a real calendar date');
export const isoDateTime = z.iso.datetime({ offset: true });

export const idParam = z.object({ id: uuid });

export const errorBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
