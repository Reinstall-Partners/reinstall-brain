#!/usr/bin/env node
import { doctor } from '../core/doctor.js';
import { VERSION } from '../core/version.js';

const HELP = `reinstall-brain ${VERSION}: a git-native record store for agents and humans.

Usage: reinstall-brain <command> [options]

Commands:
  doctor [--json]   Check that this machine can run the brain (SQLite, full-text search, parsing)
  version           Print the version
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'doctor': {
      const r = await doctor();
      if (rest.includes('--json')) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.ok ? 'ok' : 'FAIL'}  reinstall-brain ${r.version} on ${r.runtime}, ${r.platform}`);
        console.log(`    sqlite ${r.sqlite}, fts5 ${r.fts5 ? 'yes' : 'no'}, frontmatter ${r.frontmatter ? 'yes' : 'no'}`);
        for (const p of r.problems) console.log(`    problem: ${p}`);
      }
      return r.ok ? 0 : 1;
    }
    case 'version':
    case '--version':
      console.log(VERSION);
      return 0;
    case undefined:
    case 'help':
    case '--help':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code));
