import type { ServePlugin } from './types.js';

/** Shared only for exclusive lifecycle ownership across ESM/CJS copies; no routes or server state. */
export const endpointIdentity = Symbol.for('defuss-serve.endpoint-identity.v1');
/** The mark acceptWebSocket puts on its Response, so a server of either module copy reads it. A property of that one
 * Response, not a registry: it holds no server state. VERIFIED: tests/websocket.test.ts, the CommonJS-copy test. */
export const acceptMark = Symbol.for('defuss-serve.websocket-accept.v1');
const ownerKey = Symbol.for('defuss-serve.endpoint-owners.v1');
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
const owners = (globals[ownerKey] ??= new WeakMap<object, object>()) as WeakMap<object, object>;
export function identity(plugin: ServePlugin): object {
  return (plugin as ServePlugin & { [endpointIdentity]?: object })[endpointIdentity] ?? plugin;
}
export function claim(plugins: readonly ServePlugin[], owner: object): void {
  const keys = plugins.map(identity);
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate plugin endpoint');
  for (const key of keys) if (owners.has(key)) throw new Error('Plugin endpoint already owned by a server');
  for (const key of keys) owners.set(key, owner);
}
export function release(plugin: ServePlugin, owner: object): void {
  const key = identity(plugin);
  if (owners.get(key) === owner) owners.delete(key);
}
