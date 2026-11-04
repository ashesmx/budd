import { html } from 'hono/html';
import { connectionUrl, crumbs, notice, type Html } from './html.js';

/** The only time a key is shown. The page is never cached (Cache-Control: no-store). */
export function keyShownPage(opts: {
  slug: string;
  key: string;
  mcpUrl: string;
  /** Whether this replaced a key, rather than the connection being new. */
  replaced: boolean;
}): Html {
  const { slug, key } = opts;
  return html`${crumbs(['Connections', '/ui'], [slug, connectionUrl(slug)], 'API key')}
    <div class="page-head">
      <h1>The API key for <code>${slug}</code></h1>
      <p class="lede">
        Copy it now: Budd doesn't keep a copy, so it can't show it again. If you lose it, replace it
        on the connection's page.
      </p>
    </div>
    ${
      opts.replaced
        ? notice('ok', `Replaced the key for ${slug}.`, 'The old key no longer works.')
        : notice('ok', `Created ${slug}.`, 'Its agent can use Budd as soon as it has this key.')
    }
    <div class="field key-field">
      <label for="key">API key</label>
      <textarea id="key" class="key" rows="2" readonly spellcheck="false">${key}</textarea>
    </div>
    <h2>Give it to the agent</h2>
    <p>
      Add Budd as an MCP server at <code>${opts.mcpUrl}</code>, sending the key in the
      <code>Authorization</code> header:
    </p>
    <pre class="snippet">Authorization: Bearer ${key}</pre>
    <p class="muted">
      Keep it where you keep other secrets, such as an environment variable or your CI's secret
      store, never in a prompt or a repository. Anyone with the key can act as
      <code>${slug}</code>. Messages it reads are untrusted: don't let them make it reveal or send
      its key. Tell its agent its handle too, or it will ask you for one.
    </p>
    <div class="actions">
      <a class="btn primary" href="${connectionUrl(slug)}">I've saved it: open ${slug}</a>
    </div>`;
}
