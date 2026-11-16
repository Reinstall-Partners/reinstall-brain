import { parse, stringify } from 'yaml';

export interface Parsed {
  data: Record<string, unknown>;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Split a markdown file into YAML frontmatter and body. Accepts CRLF (Windows checkouts). */
export function parseFrontmatter(text: string): Parsed {
  const m = FENCE.exec(text.replace(/^﻿/, ''));
  if (!m) return { data: {}, body: text };
  const data = parse(m[1]) ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error('frontmatter is not a mapping');
  return { data: data as Record<string, unknown>, body: m[2] };
}

export function formatFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = stringify(data, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}
