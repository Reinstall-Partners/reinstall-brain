// One SQLite interface over the two runtimes Reinstall Brain ships on:
// Node's built-in node:sqlite (npm installs) and Bun's built-in bun:sqlite (compiled binaries).
// Both bundle SQLite with FTS5, so there are no native modules to install on any OS.

export interface Statement {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
}

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
  readonly runtime: 'node' | 'bun';
}

export const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

export async function openDb(path: string): Promise<Db> {
  if (isBun) {
    const mod = 'bun:sqlite';
    const { Database } = (await import(mod)) as { Database: new (p: string) => any };
    const db = new Database(path);
    return {
      runtime: 'bun',
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        const s = db.prepare(sql);
        return {
          all: (...p) => s.all(...p),
          get: (...p) => s.get(...p) ?? undefined,
          run: (...p) => s.run(...p),
        };
      },
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  return {
    runtime: 'node',
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const s = db.prepare(sql);
      return {
        all: (...p) => s.all(...(p as any[])) as Record<string, unknown>[],
        get: (...p) => s.get(...(p as any[])) as Record<string, unknown> | undefined,
        run: (...p) => s.run(...(p as any[])),
      };
    },
    close: () => db.close(),
  };
}
