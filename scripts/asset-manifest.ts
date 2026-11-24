/** Generate a trusted content-addressed representation manifest outside publicDir. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error('Usage: asset-manifest.ts PUBLIC_DIR OUTPUT_JSON');
const root = await realpath(directory);
const target = join(await realpath(dirname(resolve(output))), resolve(output).split(sep).at(-1)!);
const rel = relative(root, target);
if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)) throw new Error('Output must be outside publicDir');
const files: Record<string, {size: number; sha256: string}> = Object.create(null);
async function walk(path: string, prefix: string): Promise<void> {
  for (const entry of (await readdir(path, {withFileTypes: true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const key = prefix + entry.name;
    const file = join(path, entry.name);
    if (entry.isDirectory()) await walk(file, key + '/');
    else if (entry.isFile()) {
      const before = await stat(file); const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      const after = await stat(file);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`Asset changed during hashing: ${key}`);
      files[key] = {size: before.size, sha256: hash.digest('hex')};
    }
  }
}
await walk(root, '');
await writeFile(target, JSON.stringify({version: 1, files}, null, 2) + '\n', {flag:'wx'});
