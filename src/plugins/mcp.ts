import type { FetchEndpoint, ServePlugin, TransportLimits } from '../types.js';
import { endpointPlugin } from './endpoint.js';
/** Wrap createMcpHttp(api); the endpoint owns its Streamable HTTP negotiation and sessions. */
export function mcpPlugin(endpoint: FetchEndpoint, path = '/mcp', name = 'mcp', limits: TransportLimits = {}): ServePlugin {
  return endpointPlugin(name, endpoint, [{ path, methods: ['GET', 'POST', 'DELETE'] }], limits);
}
