import type { z } from 'zod';
import type { CapabilityEntry } from '../capabilities';
import type { CallOptions } from '../errors';

/**
 * Text model used for claim extraction (research) and plan composition.
 * Output is always validated against the given zod schema; user-supplied
 * strings (instructions, collection names) are passed as quoted data.
 */
export interface StructuredRequest<T extends z.ZodType> {
  system: string;
  prompt: string;
  schema: T;
  /** Name for the structured output tool/schema. */
  schemaName: string;
  maxTokens?: number;
  temperature?: number;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface TextModelProvider {
  readonly id: string;
  capability(): CapabilityEntry;
  generateStructured<T extends z.ZodType>(
    request: StructuredRequest<T>,
    options?: CallOptions,
  ): Promise<StructuredResult<z.infer<T>>>;
}
