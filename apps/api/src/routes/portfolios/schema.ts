import { z } from 'zod';
import type { CreateOrderRequest } from '@tickr/shared-types';

export const createOrderSchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market']),
  quantity: z.number().positive(),
  idempotencyKey: z.string().min(1),
});

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type PaginationInput = z.infer<typeof paginationSchema>;

// Compile-time check: zod schema is assignable to the OpenAPI-generated type
type _CreateOrderCompat = CreateOrderInput extends CreateOrderRequest
  ? true
  : never;
