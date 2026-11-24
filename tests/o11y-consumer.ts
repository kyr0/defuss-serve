/** Execute a real upstream fixture once the defuss-o11y endpoint API is published. */
import assert from 'node:assert/strict';
import { createServer, type ServePlugin } from 'defuss-serve';
const fixtureUrl = new URL('./o11y-fixture.ts', import.meta.url).href;
const { createO11yFixture } = await import(fixtureUrl) as { createO11yFixture(): Promise<{ plugin: ServePlugin; verify(url: URL): Promise<void> }> };
const { plugin, verify } = await createO11yFixture();
const server = createServer({ port: 0, plugins: [plugin] });
try {
  await server.start();
  for (const path of ['/health', '/healthz', '/metrics']) {
    const response = await fetch(new URL(path, server.url!));
    assert.equal(response.status, 200, path); assert.ok((await response.text()).length > 0, path);
  }
  // The fixture verifies the actual upstream response schema, readiness transition and metric values.
  await verify(server.url!);
  console.log(`Actual upstream O11y PASS: ${server.runtime}`);
} finally { await server.stop(); }
