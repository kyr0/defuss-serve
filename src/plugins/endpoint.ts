import { endpointIdentity } from '../ownership.js';
import type { FetchEndpoint, ServePlugin, ServeRoute, TransportLimits } from '../types.js';

/** Match a literal path or its slash-delimited subtree, never a string prefix alone. */
export function routePathMatches(path: string, route: ServeRoute): boolean {
  const normalized = path.replace(/\/+$/, '') || '/';
  return normalized === route.path || (!!route.prefix && (route.path === '/' || normalized.startsWith(`${route.path}/`)));
}
export function routeMatches(request: Request, route: ServeRoute): boolean {
  return routePathMatches(new URL(request.url).pathname, route) && (!route.methods || route.methods.includes(request.method));
}

/** Bind a Fetch endpoint and forward its lifecycle without importing any protocol library. */
export function endpointPlugin(name: string, endpoint: FetchEndpoint, routes: readonly ServeRoute[], limits: TransportLimits = {}): ServePlugin {
  return {
    ...limits, name, routes,
    [endpointIdentity]: endpoint,
    fetch: request => endpoint.fetch(request),
    start: endpoint.start ? () => endpoint.start!() : undefined,
    close: endpoint.close ? () => endpoint.close!() : undefined,
  } as ServePlugin;
}
