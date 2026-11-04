import { describe, expect, it } from 'vitest';
import { startTestBudd } from './helpers/harness.js';

describe('shutdown', () => {
  it('finishes promptly while a UI page holds a live-update stream open', async () => {
    const budd = await startTestBudd();
    const res = await fetch(`${budd.url}/ui/events`, {
      headers: { cookie: await budd.uiCookie() },
    });
    if (!res.body) throw new Error('no body');
    const reader = res.body.getReader();
    await reader.read(); // the stream is open and has sent "ready"

    const started = Date.now();
    await budd.close();
    expect(Date.now() - started).toBeLessThan(1000);
    // The browser side sees the stream end rather than hang.
    let done = false;
    while (!done) ({ done } = await reader.read());
  });

  it('finishes promptly with idle keep-alive connections', async () => {
    const budd = await startTestBudd();
    await (await fetch(`${budd.url}/health`)).text(); // leaves a keep-alive socket
    const started = Date.now();
    await budd.close();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
