/** Example service for `make start`: a static frontend and /health on one listener.
 * VERIFIED: `make stop` sends SIGTERM; the server stops, logs `stopped` and releases the port. */
import { createServer } from 'defuss-serve';
import { o11yPlugin } from 'defuss-serve/plugins';
import { fileURLToPath } from 'node:url';
const server = createServer({
  port: Number(process.env.PORT ?? 8080),
  publicDir: fileURLToPath(new URL('./public/', import.meta.url)),
  plugins: [o11yPlugin({ fetch: () => Response.json({ ok: true }) }, [{ path: '/health', methods: ['GET', 'HEAD'] }])],
});
await server.start();
const log = (level: string, message: string) => console.log(`${new Date().toISOString()} ${level} ${message}`);
log('INFO', `serving url=${server.url}`);
const shutdown = async () => { await server.stop(); log('INFO', 'stopped'); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
