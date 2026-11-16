import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';

type JsonSchema = Record<string, unknown>;

/** Zod -> JSON Schema for the OpenAPI document; the same schema validates the request. */
export function toJsonSchema(schema: ZodType): JsonSchema {
  try {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    }) as JsonSchema;
    return rest;
  } catch {
    return { type: 'object' };
  }
}

export const ApiZBody = (schema: ZodType) => ApiBody({ schema: toJsonSchema(schema) as never });

/** Documents every property of an object schema as a query parameter. */
export function ApiZQuery(schema: ZodType) {
  const js = toJsonSchema(schema) as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  const decorators = Object.entries(js.properties ?? {}).map(([name, s]) =>
    ApiQuery({ name, required: (js.required ?? []).includes(name), schema: s as never }),
  );
  return applyDecorators(...decorators);
}
