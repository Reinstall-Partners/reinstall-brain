import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { Document, parse } from 'yaml';

export const CORE_TYPES: Record<string, string> = {
  note: 'notes',
  decision: 'decisions',
  question: 'questions',
  insight: 'insights',
  task: 'tasks',
  milestone: 'milestones',
};

export const STATUSES = ['active', 'blocked', 'done', 'dropped', 'superseded'] as const;

/** Frontmatter order. status, assignee and updated are kept apart so concurrent edits merge. */
export const FIELD_ORDER = [
  'id', 'type', 'title', 'status', 'created', 'scope', 'tags', 'assignee', 'author', 'delegate',
  'updated', 'parent', 'supersedes', 'superseded_by', 'blocked_by', 'due', 'completed', 'importance',
  'docs', 'legacy_id', 'meta',
] as const;

const LIST_FIELDS = new Set(['tags', 'blocked_by', 'docs']);
const REQUIRED = ['id', 'type', 'title', 'status', 'created'];

export type Fields = Record<string, unknown>;

export interface BrainRecord {
  fields: Fields;
  body: string;
  path: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

/**
 * Parse a record file. YAML is read with the failsafe schema so every scalar stays a string:
 * ids like `12e4` or `0042` and dates are never turned into numbers or Date objects.
 */
export function parseRecord(text: string): { fields: Fields; body: string } {
  const m = FENCE.exec(text.replace(/^﻿/, ''));
  if (!m) throw new Error('no frontmatter block (the file must start with ---)');
  const raw = parse(m[1], { schema: 'failsafe' }) ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('frontmatter is not a mapping');
  const fields: Fields = {};
  for (const [k, v] of Object.entries(raw as Fields)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    fields[k] = v;
  }
  if (typeof fields.importance === 'string' && /^-?\d+$/.test(fields.importance)) {
    fields.importance = Number(fields.importance);
  }
  for (const f of LIST_FIELDS) {
    if (typeof fields[f] === 'string') fields[f] = [fields[f]];
  }
  return { fields, body: m[2].replace(/\r\n/g, '\n') };
}

export function orderFields(fields: Fields): Fields {
  const out: Fields = {};
  for (const k of FIELD_ORDER) if (fields[k] !== undefined) out[k] = fields[k];
  for (const k of Object.keys(fields).sort()) if (!(k in out)) out[k] = fields[k];
  return out;
}

export function formatRecord(fields: Fields, body: string): string {
  const clean: Fields = {};
  for (const [k, v] of Object.entries(orderFields(fields))) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    clean[k] = k === 'tags' ? normalizeTags(v as string[]) : v;
  }
  const doc = new Document(clean);
  for (const f of LIST_FIELDS) {
    const node = doc.get(f, true) as { flow?: boolean } | undefined;
    if (node && typeof node === 'object') node.flow = true;
  }
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false }).trimEnd();
  const text = body.replace(/^\n+/, '').replace(/\s+$/, '');
  return `---\n${yaml}\n---\n\n${text}\n`;
}

export function normalizeTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags : String(tags).split(',');
  return [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].sort();
}

export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'untitled';
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function idLength(recordCount: number): number {
  if (recordCount >= 300_000) return 6;
  if (recordCount >= 10_000) return 5;
  return 4;
}

/** A YAML core-schema reader would turn these into numbers or booleans; never generate them. */
function looksNonString(id: string): boolean {
  return /^[0-9]+$/.test(id) || /^[0-9]*\.?[0-9]*e[0-9]+$/.test(id) || /^0[box]/.test(id) ||
    /^(y|n|yes|no|on|off|true|false|null)$/.test(id);
}

export function newId(taken: (id: string) => boolean, recordCount: number): string {
  const len = idLength(recordCount);
  for (let attempt = 0; attempt < 1000; attempt++) {
    let id = '';
    for (let i = 0; i < len; i++) id += ALPHABET[randomInt(ALPHABET.length)];
    if (!looksNonString(id) && !taken(id)) return id;
  }
  throw new Error('could not find a free id after 1000 attempts');
}

export function nowIso(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

export function readRecordFile(file: string): BrainRecord {
  const { fields, body } = parseRecord(readFileSync(file, 'utf8'));
  return { fields, body, path: file };
}

export function writeRecordFile(file: string, fields: Fields, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, formatRecord(fields, body));
}

export interface Lint {
  errors: string[];
  warnings: string[];
}

/** Problems with one record, as plain sentences. No errors means valid. */
export function lintFields(fields: Fields, fileName: string | undefined, knownTypes: Set<string>): Lint {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const f of REQUIRED) if (fields[f] === undefined) problems.push(`missing required field "${f}"`);
  const id = fields.id === undefined ? undefined : String(fields.id);
  if (id !== undefined && !/^[0-9a-z]{3,8}$/.test(id)) problems.push(`id "${id}" is not 3-8 characters of 0-9a-z`);
  if (id !== undefined && fileName !== undefined && !fileName.startsWith(`${id}-`)) problems.push(`file name does not start with the id "${id}-"`);
  if (fields.type !== undefined && !knownTypes.has(String(fields.type))) {
    problems.push(`unknown type "${fields.type}" (register it under types: in brain.yaml)`);
  }
  if (fields.status !== undefined && !(STATUSES as readonly string[]).includes(String(fields.status))) {
    problems.push(`status "${fields.status}" is not one of ${STATUSES.join(', ')}`);
  }
  for (const f of ['created', 'updated', 'completed']) {
    if (fields[f] !== undefined && Number.isNaN(Date.parse(String(fields[f])))) problems.push(`${f} "${fields[f]}" is not a date`);
  }
  if (fields.due !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(String(fields.due))) problems.push(`due "${fields.due}" is not a YYYY-MM-DD date`);
  if (fields.tags !== undefined) {
    const t = fields.tags as string[];
    if (JSON.stringify(t) !== JSON.stringify(normalizeTags(t))) problems.push('tags are not lowercase, sorted and unique');
  }
  const known = new Set<string>(FIELD_ORDER);
  for (const k of Object.keys(fields)) if (!known.has(k)) warnings.push(`unknown field "${k}" (move it under meta:)`);
  return { errors: problems, warnings };
}

export function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}
