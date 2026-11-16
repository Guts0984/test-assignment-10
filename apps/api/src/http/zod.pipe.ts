import { PipeTransform } from '@nestjs/common';
import { type ZodType } from 'zod';
import { AppError } from './errors';

/**
 * PostgreSQL cannot store the NUL character in text: it would surface as a 500 deep inside a query.
 * It is never legitimate input, so it is refused up front - in values AND in object keys, at any
 * depth. Iterative on purpose: a deeply nested body must not overflow the stack.
 */
export function containsNul(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (v.includes('\u0000')) return true;
    } else if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k.includes('\u0000')) return true;
        stack.push(x);
      }
    }
  }
  return false;
}

/** Validates with a schema from @shop/shared; any failure is a 400 with per-field details. */
export class ZodPipe<S extends ZodType> implements PipeTransform<unknown, import('zod').infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): import('zod').infer<S> {
    if (containsNul(value)) {
      throw new AppError(400, 'validation_error', 'Invalid request', [
        { path: '', message: 'the NUL character is not allowed' },
      ]);
    }
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
