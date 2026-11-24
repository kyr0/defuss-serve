/** Local verification fallback when pkgroll is unavailable. Not the release build. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd();
const dist = join(root, 'dist');
const temp = join(root, 'tmp/offline-cjs');
rmSync(dist, { recursive: true, force: true }); rmSync(temp, { recursive: true, force: true });
mkdirSync(dist, { recursive: true }); mkdirSync(temp, { recursive: true });
const types = process.env.NODE_TYPES_ROOT ? ['--typeRoots', process.env.NODE_TYPES_ROOT] : [];
const common = ['--target', 'ES2022', '--lib', 'ES2023,DOM,DOM.Iterable', '--strict', '--skipLibCheck', '--types', 'node', ...types, '--rootDir', 'src', '--declaration', 'src/index.ts', 'src/plugins.ts'];
execFileSync('tsc', [...common, '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--outDir', dist], { stdio: 'inherit' });
execFileSync('tsc', [...common, '--module', 'CommonJS', '--moduleResolution', 'Node', '--outDir', temp], { stdio: 'inherit' });
for (const file of readdirSync(temp, { recursive: true }) as string[]) {
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue;
  const target = join(dist, file.replace(/\.d\.ts$/, '.d.cts').replace(/\.js$/, '.cjs'));
  writeFileSync(target, readFileSync(join(temp, file), 'utf8').replace(/(["'])(\.{1,2}\/[^"']+)\.js\1/g, '$1$2.cjs$1'));
}
for (const name of ['index', 'plugins']) {
  copyFileSync(join(dist, `${name}.js`), join(dist, `${name}.mjs`));
  copyFileSync(join(dist, `${name}.d.ts`), join(dist, `${name}.d.mts`));
}
