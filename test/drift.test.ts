import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { initBrain, openFresh, createRecord } from '../src/core/ops.js';
import { openBrain } from '../src/core/brain.js';
import { lintBrain, planDrift, donePhases } from '../src/core/indexer.js';

const PLAN = `# Plan: Billing

### Phase 1 — Parse
**Status:** done — shipped
- [x] parse

### Phase 2 — Wire
- [ ] wire

### Phase 3b — Polish
**Status:** done
`;

describe('plan drift', () => {
  it('reads done phases from a plan file', () => {
    expect([...donePhases(PLAN)].sort()).toEqual(['1', '3b']);
    expect(donePhases('### Phase 1\n## Notes\n**Status:** done').size).toBe(0);
  });

  it('flags open phase tasks whose plan marks the phase done, and lint --fix closes them', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rb-drift-'));
    execFileSync('git', ['init', '-q', dir]);
    initBrain(dir, 'acme');
    mkdirSync(path.join(dir, 'brain', 'plans'), { recursive: true });
    const planPath = 'brain/plans/002_2026-01-01_billing.md';
    writeFileSync(path.join(dir, planPath), PLAN);
    const brain = openBrain(dir);
    return (async () => {
      const o = await openFresh(brain);
      const meta = { meta: { plan_path: planPath } };
      const p1 = createRecord(o, { type: 'task', title: 'Plan 002 Phase 1: Parse', extra: meta });
      createRecord(o, { type: 'task', title: 'Plan 002 Phase 2: Wire', extra: meta });
      const p3 = createRecord(o, { type: 'task', title: 'Plan 002 Phase 3b: Polish', extra: meta });
      expect(planDrift(brain, o.db).map((d) => d.id).sort()).toEqual([p1.id, p3.id].sort());
      expect(lintBrain(brain, o.db).filter((i) => /marked done there/.test(i.message))).toHaveLength(2);
      o.db.close();
    })();
  });
});
