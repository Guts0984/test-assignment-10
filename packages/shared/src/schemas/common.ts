import { z } from 'zod';

export const uuid = z.uuid();
export const kopecks = z.number().int().min(0).max(1_000_000_000);
export const cursorSchema = z.string().min(1).max(500);
export const limitSchema = (def: number, max = 100) =>
  z.coerce.number().int().min(1).max(max).default(def);

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
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
