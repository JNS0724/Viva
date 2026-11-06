/** Narrow external/opaque values before reading fields; never log their contents. */
export const objectOf = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
export const textOf = (value: unknown): string => typeof value === 'string' ? value : ''
