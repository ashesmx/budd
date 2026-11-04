/** Connection and handle names: `[a-z0-9-]`, 2–40 characters. */
const SLUG_PATTERN = /^[a-z0-9-]{2,40}$/;

/** The system connection that sends notices. It never receives messages. */
export const SYSTEM_CONNECTION_SLUG = 'budd';

/** Connection slugs agents may never register. */
export const RESERVED_CONNECTION_SLUGS: ReadonlySet<string> = new Set([SYSTEM_CONNECTION_SLUG]);

export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export const SLUG_RULES = 'lowercase letters, digits and hyphens, 2–40 characters';

/** Lowercases and turns runs of other characters into single hyphens, e.g. "Alice.Smith" → "alice-smith". */
export function slugify(input: string, fallback = 'workspace'): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug.length >= 2 ? slug : fallback;
}

/** `base` with a collision suffix, kept within 40 characters: ("claude", 2) → "claude-2". */
export function withSuffix(base: string, n: number): string {
  const suffix = `-${String(n)}`;
  return `${base.slice(0, 40 - suffix.length)}${suffix}`;
}
