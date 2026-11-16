/** Minimal argument parser: positionals, --flag, --key value, --key=value, repeated keys. */
export interface Args {
  positional: string[];
  flag(name: string): boolean;
  value(name: string): string | undefined;
  values(name: string): string[];
}

const BOOLEAN = new Set(['json', 'rebuild', 'help', 'dry-run', 'move-docs', 'top', 'bottom', 'all', 'default', 'no-wire', 'unserved']);

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const opts = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (t.startsWith('--')) {
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
  };
}
