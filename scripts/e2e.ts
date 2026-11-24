import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const root = process.cwd();
const output = resolve('output/e2e');
rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const bunAvailable = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
if (process.env.REQUIRE_BUN === '1' && !bunAvailable) throw new Error('Bun required but unavailable');
if (process.env.REQUIRE_UPSTREAM === '1') {
  for (const key of ['DEFUSS_RPC_PACKAGE','DEFUSS_MCP_PACKAGE','DEFUSS_O11Y_PACKAGE']) if (!process.env[key]) throw new Error(`Release gate requires ${key}`);
}
const consumer = mkdtempSync(join(tmpdir(), 'defuss-serve-packed-'));
const run = (command: string, args: string[], cwd: string) => execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 240000, stdio: ['ignore', 'pipe', 'inherit'] });
try {
  const packed = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', output], root));
  const tarball = join(output, packed[0].filename);
  assert.ok(packed[0].files.some((file: { path: string }) => file.path === 'dist/index.mjs'));
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'serve-consumer', version: '1.0.0', private: true, type: 'module' }));
  run(npm, ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball], consumer);
  copyFileSync(join(root, 'tests/consumer.ts'), join(consumer, 'consumer.ts'));
  // Check declarations from an actual external package boundary in both module modes.
  const typed = `import { createServer, type ServePlugin } from 'defuss-serve';\nimport { endpointPlugin } from 'defuss-serve/plugins';\nconst plugin: ServePlugin = endpointPlugin('test', { fetch: () => new Response('ok') }, [{ path: '/test' }]);\nconst server = createServer({ plugins: [plugin] });\nvoid server.start();\n`;
  writeFileSync(join(consumer, 'types.mts'), typed);
  writeFileSync(join(consumer, 'types.cts'), typed.replace("import { createServer, type ServePlugin } from 'defuss-serve';", "import serve = require('defuss-serve');\ntype ServePlugin = serve.ServePlugin;\nconst { createServer } = serve;").replace("import { endpointPlugin } from 'defuss-serve/plugins';", "import plugins = require('defuss-serve/plugins');\nconst { endpointPlugin } = plugins;"));
  run('tsc', ['--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--lib', 'ES2023,DOM,DOM.Iterable', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'types.mts', 'types.cts'], consumer);
  let log = 'Consumer declaration checks: ESM + CommonJS PASS\n';
  log += run(process.execPath, ['--experimental-strip-types', 'consumer.ts'], consumer);
  log += bunAvailable ? run('bun', ['consumer.ts'], consumer) : 'Bun: NOT RUN (runtime unavailable)\n';
  if (process.env.REQUIRE_BROWSERS === '1' || process.env.SYSTEM_CHROMIUM) {
    copyFileSync(join(root, 'tests/browser-consumer.ts'), join(consumer, 'browser-consumer.ts'));
    cpSync(join(root,'tests/fixtures'),join(consumer,'fixtures'),{recursive:true});
    if (!process.env.SYSTEM_CHROMIUM) run(npm,['install','--ignore-scripts','--no-audit','--no-fund','playwright@1.64.1'],consumer);
    else if (process.env.REQUIRE_BROWSERS === '1') throw new Error('The release browser gate requires both Playwright engines, not system Chromium');
    log += run(process.execPath,['--experimental-strip-types','browser-consumer.ts'],consumer);
    if (bunAvailable) log += run('bun',['browser-consumer.ts'],consumer);
  } else log += 'Browser engines: NOT RUN (REQUIRE_BROWSERS=1 enables Chromium and WebKit)\n';
  if (process.env.DEFUSS_RPC_PACKAGE || process.env.DEFUSS_MCP_PACKAGE) {
    if (!process.env.DEFUSS_RPC_PACKAGE || !process.env.DEFUSS_MCP_PACKAGE) throw new Error('Set both DEFUSS_RPC_PACKAGE and DEFUSS_MCP_PACKAGE');
    run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', process.env.DEFUSS_RPC_PACKAGE, process.env.DEFUSS_MCP_PACKAGE, '@modelcontextprotocol/client@2.4.0'], consumer);
    copyFileSync(join(root, 'tests/upstream-consumer.ts'), join(consumer, 'upstream.ts'));
    log += run(process.execPath, ['--experimental-strip-types', 'upstream.ts'], consumer);
    if (bunAvailable) log += run('bun', ['upstream.ts'], consumer);
  } else log += 'Actual upstream RPC/MCP: NOT RUN (supply package versions or absolute tarball paths)\n';
  if (process.env.DEFUSS_O11Y_PACKAGE) {
    // DEFUSS_O11Y_FIXTURE can replace the bundled fixture for another defuss-o11y version.
    run(npm,['install','--ignore-scripts','--no-audit','--no-fund',process.env.DEFUSS_O11Y_PACKAGE],consumer);
    copyFileSync(resolve(process.env.DEFUSS_O11Y_FIXTURE || join(root,'tests/o11y-fixture.ts')),join(consumer,'o11y-fixture.ts'));
    copyFileSync(join(root,'tests/o11y-consumer.ts'),join(consumer,'o11y-consumer.ts'));
    log += run(process.execPath,['--experimental-strip-types','o11y-consumer.ts'],consumer);
    if(bunAvailable)log += run('bun',['o11y-consumer.ts'],consumer);
  } else log += 'Actual O11y: NOT RUN (DEFUSS_O11Y_PACKAGE required)\n';
  writeFileSync(join(output, 'results.log'), log);
  console.log(log);
} finally { rmSync(consumer, { recursive: true, force: true }); }
