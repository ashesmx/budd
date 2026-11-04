import type { Hono } from 'hono';
import { messagePage } from '../ui/authPages.js';
import type { Web } from '../ui/web.js';

/** Signing out ends the browser session (both modes), and the console's in this browser. */
export function mountLogout(app: Hono, web: Web): void {
  app.post('/logout', async (c) => {
    const verified = await web.verifiedPost(c);
    if (!verified) return web.refused(c);
    web.sessions.end(verified.session);
    web.clearSession(c);
    web.endConsoleSession(c);
    return c.html(
      messagePage('Signed out', 'You have signed out of Budd.', {
        href: '/login',
        label: 'Sign in',
      }),
    );
  });
}
