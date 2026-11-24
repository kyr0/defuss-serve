/** Optional actual upstream protocol E2E, requiring installed upstream packages. */
import assert from 'node:assert/strict';
import { createServer } from 'defuss-serve';
import { mcpPlugin, rpcPlugin } from 'defuss-serve/plugins';
// Dynamic names keep optional integrations out of the core dependency graph.
const load = (name: string) => import(name);
const { createRpcServer, rpcRoute, clearRpcServer } = await load('defuss-rpc/server');
const { getRpcClient } = await load('defuss-rpc/client');
const { createMcpApi } = await load('defuss-mcp');
const { createMcpHttp } = await load('defuss-mcp/http');
const { getMcpClient } = await load('defuss-mcp/client');
const { Client, StreamableHTTPClientTransport } = await load('@modelcontextprotocol/client');
const MathApi = { add: async (a: number, b: number) => a + b, async *sequence(n: number) { for (let i = 0; i < n; i++) yield i; } };
const rpc = createRpcServer({ MathApi });
// Support both the existing singleton and the forthcoming instance-local API.
const plugin = rpcPlugin(rpc?.fetch ? rpc : rpcRoute);
const mcp = createMcpHttp(createMcpApi({ name: 'serve-e2e', version: '1.0.0' }, { greet: (name: string) => `Hello, ${name}` }));
const server = createServer({ port: 0, plugins: [plugin, mcpPlugin(mcp)] });
const sdk = new Client({ name: 'serve-e2e-client', version: '1.0.0' });
try {
  await server.start();
  const client = await getRpcClient({ baseUrl: server.url!.origin });
  assert.equal(await client.MathApi.add(2, 3), 5);
  const values: number[] = []; for await (const value of client.MathApi.sequence(3)) values.push(value);
  assert.deepEqual(values, [0, 1, 2]);
  await sdk.connect(new StreamableHTTPClientTransport(new URL('/mcp', server.url!)));
  const { tools } = await getMcpClient(sdk);
  assert.equal(await tools.greet('Ada'), 'Hello, Ada');
  console.log(`Actual upstream RPC + MCP PASS: ${server.runtime}`);
} finally {
  await sdk.close(); await server.stop();
  if (!rpc?.fetch && typeof clearRpcServer === 'function') await clearRpcServer();
}
