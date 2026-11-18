/** Minimal argument parser: positionals, --flag, --key value, --key=value, repeated keys. */
export interface Args {
  positional: string[];
  flag(name: string): boolean;
  value(name: string): string | undefined;
  values(name: string): string[];
  /** Every --flag given, without the dashes. */
  keys(): string[];
  /** -h or --help anywhere: print help, never run the command. */
  wantsHelp: boolean;
}

const BOOLEAN = new Set(['json', 'rebuild', 'help', 'dry-run', 'move-docs', 'top', 'bottom', 'all', 'default', 'no-wire', 'unserved', 'yes', 'fetch']);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const opts = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    // A token with a space in it is text (a title like "--tag splits commas"), never a flag.
    if (t.startsWith('--') && !/\s/.test(t)) {
      const eq = t.indexOf('=');
      const key = eq > 0 ? t.slice(2, eq) : t.slice(2);
      let val: string;
      if (eq > 0) val = t.slice(eq + 1);
      else if (!BOOLEAN.has(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i];
      else val = 'true';
      opts.set(key, [...(opts.get(key) ?? []), val]);
    } else positional.push(t);
  }
  return {
    positional,
    flag: (n) => opts.has(n) && opts.get(n)!.at(-1) !== 'false',
    value: (n) => opts.get(n)?.at(-1),
    values: (n) => opts.get(n) ?? [],
    keys: () => [...opts.keys()],
    wantsHelp: opts.has('help') || argv.includes('-h'),
  };
}

/** Flags every command takes, besides the ones its help line names. */
export const GLOBAL_FLAGS = ['json', 'hub', 'help', 'author'];

/** The flags a help text names (`--name`), plus the global ones. */
export function knownFlags(help: string): Set<string> {
  return new Set([...GLOBAL_FLAGS, ...[...help.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1])]);
}

/** One command's lines from a help text (its line and the more-indented lines under it), or null. */
export function commandHelp(help: string, cmd: string): string | null {
  const lines = help.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!new RegExp(`^ {2}${cmd}(\\s|$)`).test(lines[i])) continue;
    out.push(lines[i]);
    while (i + 1 < lines.length && /^ {4,}\S/.test(lines[i + 1])) out.push(lines[++i]);
  }
  return out.length ? out.join('\n') : null;
}

/**
 * Before any command runs: answer -h/--help with help (never run the command), and refuse a flag the
 * CLI doesn't know (a typo would otherwise be ignored, and the command run without it).
 * Returns an exit code to stop with, or null to go on.
 */
export function preflight(a: Args, tool: string, help: string, cmd: string | undefined): number | null {
  if (a.wantsHelp) {
    const one = cmd ? commandHelp(help, cmd) : null;
    process.stdout.write(one ? `Usage: ${tool} ${one.trim()}\n\n(${tool} --help lists every command.)\n` : help);
    return 0;
  }
  const known = knownFlags(help);
  const bad = a.keys().filter((k) => !known.has(k));
  if (bad.length) {
    process.stderr.write(`${tool}: unknown flag ${bad.map((b) => `--${b}`).join(', ')}${cmd ? ` (${tool} ${cmd} --help shows its flags)` : ''}\n`);
    return 2;
  }
  return null;
}
