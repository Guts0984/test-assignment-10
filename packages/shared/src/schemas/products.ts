import { z } from 'zod';
import { cursorSchema, kopecks, limitSchema, uuid } from './common';

export const PRODUCT_SORTS = ['newest', 'price_asc', 'price_desc', 'name'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

const boolFromQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const productQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    category: z.string().trim().max(80).optional(),
    minPrice: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
    maxPrice: z.coerce.number().int().min(0).max(1_000_000_000).optional(),
    sort: z.enum(PRODUCT_SORTS).default('newest'),
    limit: limitSchema(24),
    cursor: cursorSchema.optional(),
    includeInactive: boolFromQuery.optional(),
  })
  .refine((v) => v.minPrice === undefined || v.maxPrice === undefined || v.minPrice <= v.maxPrice, {
    message: 'minPrice must be <= maxPrice',
    path: ['minPrice'],
  });
export type ProductQuery = z.infer<typeof productQuerySchema>;

export const productCreateSchema = z.object({
  name: z.string().trim().min(2).max(200),
  categoryId: uuid,
  price: kopecks.min(1),
  stock: z.number().int().min(0).max(1_000_000),
  active: z.boolean().default(true),
});
export type ProductCreate = z.infer<typeof productCreateSchema>;

// NOT productCreateSchema.partial(): the create schema's `active` default would survive .partial()
// and silently re-activate a hidden product on every unrelated PATCH.
export const productUpdateSchema = z
  .object({
    name: productCreateSchema.shape.name,
    categoryId: productCreateSchema.shape.categoryId,
    price: productCreateSchema.shape.price,
    stock: productCreateSchema.shape.stock,
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type ProductUpdate = z.infer<typeof productUpdateSchema>;

export const productDtoSchema = z.object({
  id: uuid,
  name: z.string(),
  categoryId: uuid,
  categoryName: z.string(),
  categorySlug: z.string(),
  price: z.number().int(),
  stock: z.number().int(),
  active: z.boolean(),
  createdAt: z.string(),
});
export type ProductDto = z.infer<typeof productDtoSchema>;

export type Page<T> = { items: T[]; nextCursor: string | null };
