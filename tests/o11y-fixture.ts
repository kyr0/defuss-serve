/** Real defuss-o11y fixture for the release gate, run by tests/o11y-consumer.ts in the packed consumer.
 * VERIFIED: the checks follow defuss-o11y 0.3.0 examples/serve/verify.mjs and passed on Node 22.16 and Bun 1.4.5. */
import assert from 'node:assert/strict';
import { o11yPlugin } from 'defuss-serve/plugins';
import type { FetchEndpoint, ServePlugin } from 'defuss-serve';

interface O11y extends FetchEndpoint { drain(): void; shutdown(): Promise<void> }
// A dynamic name keeps the optional upstream package out of the core typecheck.
const load = (name: string) => import(name) as Promise<{ createO11y(options: { serviceName: string }): O11y }>;
const paths = ['/health', '/healthz', '/readyz', '/livez', '/metrics'];

export async function createO11yFixture(): Promise<{ plugin: ServePlugin; verify(url: URL): Promise<void> }> {
  const obs = (await load('defuss-o11y')).createO11y({ serviceName: 'serve-release' });
  const plugin = o11yPlugin({ fetch: request => obs.fetch(request), close: () => obs.shutdown() }, paths.map(path => ({ path, methods: ['GET', 'HEAD'] })));
  return {
    plugin,
    async verify(url) {
      const get = (path: string, init?: RequestInit) => fetch(new URL(path, url), init);
      for (const path of ['/health', '/healthz', '/readyz', '/livez']) {
        const response = await get(path);
        assert.equal(response.status, 200, path);
        assert.equal(JSON.parse(await response.text()).status, 'pass', path);
      }
      assert.match(await (await get('/metrics')).text(), /defuss_o11y_ready\S*\s+1\b/);
      assert.equal((await get('/readyz', { method: 'POST' })).status, 405);
      obs.drain();
      assert.equal((await get('/readyz')).status, 503);
      assert.equal((await get('/livez')).status, 200);
      assert.match(await (await get('/metrics')).text(), /defuss_o11y_ready\S*\s+0\b/);
    },
  };
}
