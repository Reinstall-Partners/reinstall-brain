import os from 'node:os';
import { openDb, isBun } from './sqlite.js';
import { parseFrontmatter } from './frontmatter.js';
import { VERSION } from './version.js';

export interface DoctorReport {
  ok: boolean;
  version: string;
  runtime: string;
  platform: string;
  sqlite: string;
  fts5: boolean;
  frontmatter: boolean;
  problems: string[];
}

const SAMPLE = '---\r\nid: 7f3a\r\ntype: task\r\ntitle: Check the toolchain\r\ntags: [spike]\r\n---\r\n\r\nBody text with ranked words.\r\n';

/** Prove the runtime can do everything the brain needs: parse records, SQLite, full-text search. */
export async function doctor(): Promise<DoctorReport> {
  const problems: string[] = [];
  let sqlite = 'unavailable';
  let fts5 = false;
  let frontmatter = false;
  try {
    const db = await openDb(':memory:');
    sqlite = String(db.prepare('SELECT sqlite_version() AS v').get()?.v);
    db.exec("CREATE VIRTUAL TABLE f USING fts5(title, body); INSERT INTO f VALUES ('a', 'stack ranked tasks')");
    fts5 = db.prepare("SELECT count(*) AS n FROM f WHERE f MATCH 'ranked'").get()?.n === 1;
    if (!fts5) problems.push('FTS5 query returned no row');
    db.close();
  } catch (e) {
    problems.push(`sqlite: ${(e as Error).message}`);
  }
  try {
    const p = parseFrontmatter(SAMPLE);
    frontmatter = p.data.id === '7f3a' && Array.isArray(p.data.tags) && p.body.includes('ranked');
    if (!frontmatter) problems.push('frontmatter parsed wrong');
  } catch (e) {
    problems.push(`frontmatter: ${(e as Error).message}`);
  }
  return {
    ok: problems.length === 0,
    version: VERSION,
    runtime: isBun ? `bun ${(globalThis as any).Bun.version}` : `node ${process.versions.node}`,
    platform: `${os.platform()}-${os.arch()}`,
    sqlite,
    fts5,
    frontmatter,
    problems,
  };
}
