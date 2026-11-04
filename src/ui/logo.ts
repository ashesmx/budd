import { readdirSync, readFileSync } from 'node:fs';
import { html } from 'hono/html';
import type { Theme } from '../domain/auth.js';
import type { Html } from './html.js';

/** The logo's SVG files (docs/design/README.md), served as /ui/logo/<file>. */
const dir = new URL('logo/', import.meta.url);
export const LOGO_FILES = new Map(
  readdirSync(dir)
    .filter((name) => name.endsWith('.svg'))
    .map((name) => [name, readFileSync(new URL(name, dir), 'utf8')]),
);

/**
 * The "budd" wordmark, in the colours of the reader's theme: the operating
 * system's, or the one chosen in Preferences. Its width and height follow the
 * SVG's viewBox (188×64), so the page doesn't shift as it loads.
 */
export const wordmarkFor = (theme: Theme = 'system'): Html =>
  theme === 'system'
    ? html`<picture
        ><source srcset="/ui/logo/budd-wordmark-dark.svg" media="(prefers-color-scheme: dark)" />
        <img src="/ui/logo/budd-wordmark-light.svg" alt="Budd" width="71" height="24"
      /></picture>`
    : html`<img src="/ui/logo/budd-wordmark-${theme}.svg" alt="Budd" width="71" height="24" />`;

export const wordmark: Html = wordmarkFor('system');

export const favicon: Html = html`<link
  rel="icon"
  href="/ui/logo/favicon.svg"
  type="image/svg+xml"
/>`;
