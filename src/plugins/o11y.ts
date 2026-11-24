import type { FetchEndpoint, ServePlugin, ServeRoute, TransportLimits } from '../types.js';
import { endpointPlugin } from './endpoint.js';
/** Structural observability endpoint adapter. Supply the actual routes your endpoint implements. */
export function o11yPlugin(endpoint: FetchEndpoint, routes: readonly ServeRoute[] = [
  { path: '/health', methods: ['GET', 'HEAD'] },
  { path: '/healthz', methods: ['GET', 'HEAD'] },
  { path: '/metrics', methods: ['GET', 'HEAD'] },
], name = 'o11y', limits: TransportLimits = {}): ServePlugin { return endpointPlugin(name, endpoint, routes, limits); }
