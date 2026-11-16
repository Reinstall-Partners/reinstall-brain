import { describe, it, expect } from 'vitest';
import { doctor } from '../src/core/doctor.js';
import { parseFrontmatter, formatFrontmatter } from '../src/core/frontmatter.js';

describe('doctor', () => {
  it('finds SQLite with FTS5 and parses frontmatter', async () => {
    const r = await doctor();
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe('frontmatter', () => {
  it('round-trips data and body', () => {
    const text = formatFrontmatter({ id: 'ab12', type: 'note', tags: ['x', 'y'] }, 'Hello\n');
    const p = parseFrontmatter(text);
    expect(p.data).toEqual({ id: 'ab12', type: 'note', tags: ['x', 'y'] });
    expect(p.body.trim()).toBe('Hello');
  });
  it('accepts CRLF line endings', () => {
    const p = parseFrontmatter('---\r\nid: zz9\r\n---\r\nbody\r\n');
    expect(p.data.id).toBe('zz9');
  });
});
