import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parse } from 'yaml';
import { CORE_TYPES } from './record.js';

export const FORMAT = 1;

export interface TypeDef {
  name: string;
  /** Folder under brain/records/ (default <name>s). */
  folder: string;
  /** Instead of folder: a kit-owned folder relative to brain/, searched recursively. */
  path?: string;
  kit?: string;
  /** `loose`: files written by another tool (e.g. Claude Code memory). Indexed and searchable, never linted for brain fields. */
  schema?: 'record' | 'loose';
}

export interface Connection {
  name: string;
  path?: string;
  remote?: string;
}

export interface BrainConfig {
  format: number;
  name: string;
  title?: string;
  scopes: string[];
  types: TypeDef[];
  connects: Connection[];
}

export interface Brain {
  /** The repository (or folder) that holds brain/. */
  root: string;
  /** <root>/brain */
  dir: string;
  config: BrainConfig;
  /** type name -> absolute folder holding its records */
  typeDirs: Map<string, string>;
  /** Types whose files are indexed loosely (see TypeDef.schema). */
  looseTypes: Set<string>;
}

function gitPrimaryCheckout(cwd: string): string | undefined {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!common) return undefined;
    // A normal clone's common dir is <checkout>/.git. Bare repos and odd layouts fall through.
    if (path.basename(common) === '.git') return path.dirname(common);
  } catch {
    /* not a git repository, or git is not installed */
  }
  return undefined;
}

/**
 * Find the brain that serves `cwd`. Inside any git worktree this is the primary checkout's brain,
 * so every worktree reads and writes one shared brain. Outside git, walk up to the nearest brain/.
 */
export function locateBrain(cwd: string = process.cwd()): string | undefined {
  const primary = gitPrimaryCheckout(cwd);
  if (primary && existsSync(path.join(primary, 'brain', 'brain.yaml'))) return primary;
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, 'brain', 'brain.yaml'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function loadConfig(brainDir: string): BrainConfig {
  const raw = (parse(readFileSync(path.join(brainDir, 'brain.yaml'), 'utf8')) ?? {}) as Record<string, any>;
  const format = Number(raw.format ?? FORMAT);
  if (!raw.name) throw new Error(`brain.yaml in ${brainDir} has no name`);
  return {
    format,
    name: String(raw.name),
    title: raw.title ? String(raw.title) : undefined,
    scopes: Array.isArray(raw.scopes) ? raw.scopes.map(String) : [],
    types: Array.isArray(raw.types)
      ? raw.types.map((t: any) => ({
          name: String(t.name),
          folder: String(t.folder ?? `${t.name}s`),
          path: t.path ? String(t.path) : undefined,
          kit: t.kit ? String(t.kit) : undefined,
          schema: t.schema === 'loose' ? 'loose' : 'record',
        }))
      : [],
    connects: Array.isArray(raw.connects)
      ? raw.connects.map((c: any) => ({ name: String(c.name), path: c.path ? String(c.path) : undefined, remote: c.remote ? String(c.remote) : undefined }))
      : [],
  };
}

export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return path.join(home, p.slice(1));
  }
  return p;
}

export function openBrain(root: string): Brain {
  const dir = path.join(root, 'brain');
  const config = loadConfig(dir);
  if (config.format > FORMAT) {
    throw new Error(`this brain uses format ${config.format}; this reinstall-brain only knows format ${FORMAT}. Update reinstall-brain.`);
  }
  const typeDirs = new Map<string, string>();
  for (const [name, folder] of Object.entries(CORE_TYPES)) typeDirs.set(name, path.join(dir, 'records', folder));
  const looseTypes = new Set<string>();
  for (const t of config.types) {
    typeDirs.set(t.name, t.path ? path.join(dir, t.path) : path.join(dir, 'records', t.folder));
    if (t.schema === 'loose') looseTypes.add(t.name);
  }
  return { root, dir, config, typeDirs, looseTypes };
}

export function requireBrain(cwd?: string): Brain {
  const root = locateBrain(cwd);
  if (!root) throw new Error('no brain found here or in any parent folder (run `reinstall-brain init` to create one)');
  return openBrain(root);
}
