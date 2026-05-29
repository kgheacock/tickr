import { z } from 'zod';

export const upsertUniverseSchema = z.object({
  symbols: z.array(z.string().min(1)).min(1),
});

export const backfillSchema = z.object({
  symbol: z.string().min(1),
});

export type UpsertUniverseInput = z.infer<typeof upsertUniverseSchema>;
export type BackfillInput = z.infer<typeof backfillSchema>;
