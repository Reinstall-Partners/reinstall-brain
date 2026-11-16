// Record which commit dist/ was built from, so the session hook can say when a pull was not rebuilt.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
let head = '';
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch {}
writeFileSync('dist/.build-head', `${head}\n`);
