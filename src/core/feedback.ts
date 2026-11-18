// `reinstall-brain feedback`: an agent (or a person) reports a rough edge to this package's own GitHub
// repository, as the user who runs it (their `gh` login), with the diagnostics the CLI already knows.
//
// The repository is public, so filing is deliberate: without --yes it only shows the issue it would file,
// and it never adds the folder, the brain's name or anything else that could name a client or a person.
// A private-words list (one word or phrase per line; `#` comments) stops an issue that contains one:
// $REINSTALL_BRAIN_PRIVATE_WORDS, or private-words.txt in the config folder (~/.config/reinstall-brain).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERSION } from './version.js';
import { packageRoot } from './wire.js';

export const KINDS = ['bug', 'nit', 'idea'] as const;
export type Kind = (typeof KINDS)[number];
const FALLBACK_REPO = 'Reinstall-Partners/reinstall-brain';

export interface FeedbackDraft {
  repo: string;
  title: string;
  body: string;
}

/** owner/name of this package's origin remote on GitHub, or the project's home repository. */
export function feedbackRepo(): string {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: packageRoot(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url);
    if (m) return m[1];
  } catch {}
  return FALLBACK_REPO;
}

function buildStamp(): string {
  try {
    return String(JSON.parse(readFileSync(path.join(packageRoot(), 'dist', '.build-stamp.json'), 'utf8')).head || '').slice(0, 7);
  } catch {
    return '';
  }
}

export function draftFeedback(opts: { title: string; body?: string; kind?: Kind; command?: string }): FeedbackDraft {
  const kind = opts.kind ?? 'bug';
  const title = `${kind === 'nit' ? 'NIT: ' : kind === 'idea' ? 'Idea: ' : ''}${opts.title.trim()}`;
  const stamp = buildStamp();
  const diag = [
    `- reinstall-brain ${VERSION}${stamp ? ` (built from ${stamp})` : ''}`,
    `- node ${process.versions.node}, ${os.platform()}-${os.arch()}`,
    ...(opts.command ? [`- command: \`${opts.command}\``] : []),
  ];
  const body = `${(opts.body ?? '').trim() || '_(no details given)_'}\n\n### Environment\n${diag.join('\n')}\n\n_Filed with \`reinstall-brain feedback\`._\n`;
  return { repo: feedbackRepo(), title, body };
}

function privateWordsFile(): string | null {
  const env = process.env.REINSTALL_BRAIN_PRIVATE_WORDS;
  if (env && existsSync(env)) return env;
  const dir = process.env.REINSTALL_BRAIN_CONFIG_DIR || path.join(os.homedir(), '.config', 'reinstall-brain');
  const p = path.join(dir, 'private-words.txt');
  return existsSync(p) ? p : null;
}

/** Private words the draft contains (case-insensitive), from the private-words list if there is one. */
export function privateHits(draft: FeedbackDraft): string[] {
  const file = privateWordsFile();
  if (!file) return [];
  const text = `${draft.title}\n${draft.body}`.toLowerCase();
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((w) => w && text.includes(w.toLowerCase()));
}

export interface FileResult {
  filed: boolean;
  url?: string;
  /** Where the issue text was saved when it could not be filed. */
  savedTo?: string;
  error?: string;
}

/** File the draft with the user's own gh login. On failure the text is saved to a file to copy. */
export function fileFeedback(draft: FeedbackDraft): FileResult {
  const save = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'reinstall-brain-feedback-'));
    const p = path.join(dir, 'issue.md');
    writeFileSync(p, `# ${draft.title}\n\n${draft.body}`);
    return p;
  };
  const auth = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  if (auth.error || auth.status !== 0) {
    return { filed: false, savedTo: save(), error: auth.error ? 'the GitHub CLI (gh) is not installed' : 'gh is not signed in (gh auth login)' };
  }
  const r = spawnSync('gh', ['issue', 'create', '--repo', draft.repo, '--title', draft.title, '--body-file', '-'], { input: draft.body, encoding: 'utf8' });
  if (r.status !== 0) return { filed: false, savedTo: save(), error: (r.stderr || 'gh issue create failed').trim().split('\n')[0] };
  return { filed: true, url: r.stdout.trim().split('\n').pop() };
}
