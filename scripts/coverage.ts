/** Measure the ESM production artifact once. CJS is a duplicate build verified by packed E2E. */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const files = readdirSync('tests').filter(file => file.endsWith('.test.ts')).map(file => `tests/${file}`);
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--experimental-test-coverage', '--test-coverage-include=dist/**/*.js', '--test-coverage-include=dist/**/*.mjs', '--test-coverage-lines=85', '--test-coverage-functions=80', '--test-coverage-branches=75', '--test', '--test-timeout=30000', ...files], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
if (result.error) throw result.error;
const match = /all files\s*\|\s*([\d.]+)/i.exec(result.stdout ?? '');
if (!match) throw new Error('Coverage total missing');
console.log(`TOTAL ${match[1]}%`);
process.exitCode = result.status ?? 1;
