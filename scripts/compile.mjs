// Build standalone binaries with Bun: no Node or runtime needed on the user's machine.
// Usage: node scripts/compile.mjs [target...]   (default: the current machine's target)
// Targets: bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64 bun-windows-x64
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';

const host = `bun-${os.platform() === 'win32' ? 'windows' : os.platform()}-${os.arch()}`;
const targets = process.argv.slice(2).length ? process.argv.slice(2) : [host];
const bun = process.env.BUN ?? 'bun';
mkdirSync('bin', { recursive: true });
for (const target of targets) {
  for (const name of ['brain', 'hub']) {
    const ext = target.includes('windows') ? '.exe' : '';
    const out = `bin/${target.replace(/^bun-/, '')}/reinstall-${name}${ext}`;
    execFileSync(bun, ['build', `src/cli/${name}.ts`, '--compile', `--target=${target}`, `--outfile=${out}`], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    console.log(`built ${out}`);
  }
}
