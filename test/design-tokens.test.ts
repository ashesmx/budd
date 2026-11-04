import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSS } from '../src/ui/assets.js';

/** docs/design/tokens.json is the design system; src/ui/assets.ts must say the same. */

interface Token {
  name: string;
  value: string | { light: string; dark: string };
}
const tokens = JSON.parse(fs.readFileSync('docs/design/tokens.json', 'utf8')) as {
  color: { tokens: Token[] };
  spacing: { tokens: Token[] };
  radius: { tokens: Token[] };
  size: { tokens: Token[] };
  type: { families: Record<string, string> };
};

const declarations = (block: string) =>
  Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]));
const light = declarations(/^:root \{([^}]*)\}/m.exec(CSS)?.[1] ?? '');
const dark = declarations(
  /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/.exec(
    CSS,
  )?.[1] ?? '',
);

describe('the stylesheet matches the design tokens', () => {
  it('a chosen dark theme uses the same values as the operating system’s', () => {
    const chosen = declarations(/:root\[data-theme="dark"\] \{([^}]*)\}/.exec(CSS)?.[1] ?? '');
    expect(chosen).toEqual(dark);
  });

  it('in both themes, for every colour', () => {
    for (const t of tokens.color.tokens) {
      if (typeof t.value === 'string') throw new Error(`${t.name} needs a value per theme`);
      expect(light[t.name], `${t.name} (light)`).toBe(t.value.light);
      expect(dark[t.name] ?? light[t.name], `${t.name} (dark)`).toBe(t.value.dark);
    }
  });

  it('for spacing, radii, sizes and fonts', () => {
    for (const t of [...tokens.spacing.tokens, ...tokens.radius.tokens, ...tokens.size.tokens]) {
      expect(light[t.name], t.name).toBe(t.value);
    }
    for (const [key, stack] of Object.entries(tokens.type.families)) {
      expect(light[`font-${key}`], key).toBe(stack);
    }
  });

  it('and the stylesheet defines nothing the tokens leave out', () => {
    const named = new Set([
      ...[tokens.color, tokens.spacing, tokens.radius, tokens.size].flatMap((f) =>
        f.tokens.map((t) => t.name),
      ),
      ...Object.keys(tokens.type.families).map((k) => `font-${k}`),
    ]);
    expect(Object.keys(light).filter((n) => !named.has(n))).toEqual([]);
    expect(Object.keys(dark).filter((n) => !named.has(n))).toEqual([]);
  });
});
