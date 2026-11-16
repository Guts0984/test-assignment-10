import { PipeTransform } from '@nestjs/common';
import { type ZodType } from 'zod';
import { AppError } from './errors';

/** Validates with a schema from @shop/shared; any failure is a 400 with per-field details. */
export class ZodPipe<S extends ZodType> implements PipeTransform<unknown, import('zod').infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): import('zod').infer<S> {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw new AppError(
        400,
        'validation_error',
        'Invalid request',
        r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return r.data;
  }
}
