/**
 * The release gate actually gates the release (TAB 03, F-03).
 *
 * ## What went wrong
 *
 * `deploy.yml` and `release-gate.yml` both triggered on `push: main` as
 * INDEPENDENT workflows. Two workflows on one trigger run in parallel and can
 * never express a dependency between them, so on commit d4b0150 the gate failed
 * (run 32119165094) and the deploy succeeded (run 32119165101). The red gate
 * shipped to production and nothing in the pipeline objected.
 *
 * The gate's own failure was trivial — `reports/release-summary.json` was never
 * written, so `upload-artifact` with `if-no-files-found: error` failed the job.
 * That triviality is the danger, not a mitigation: a gate that fails for
 * cosmetic reasons trains everybody to ignore it, and then it fails for a real
 * reason and is ignored too.
 *
 * ## Why this test exists when the book asks for a demonstration
 *
 * The book's gate is "push a commit with a failing test, observe deploy
 * SKIPPED". That is the right proof and it cannot be produced here: this
 * repository is worked on without push or deploy authorisation, and a push to
 * `main` IS the production deploy. It is queued as manual task 03.1.
 *
 * What CAN be proven locally is the structural property the demonstration would
 * exercise — that the dependency exists in the file at all. A demonstration
 * proves it worked once; this proves it has not been quietly removed since,
 * which is the failure mode that actually recurs. They are complements, and
 * neither replaces the other.
 *
 * ## Why it does not use a YAML parser
 *
 * `js-yaml` is present only as a transitive dependency. A gate whose own
 * correctness rests on an undeclared package is a gate with a silent expiry
 * date. The reader below answers four structural questions and says so; it is
 * deliberately not a general YAML parser, in the same spirit as
 * `scripts/lib/routeTable.ts`.
 */

import fs from 'fs';
import path from 'path';

const WORKFLOWS = path.join(__dirname, '..', '.github', 'workflows');
const read = (f: string): string =>
  fs.readFileSync(path.join(WORKFLOWS, f), 'utf8').replace(/\r\n/g, '\n');

const deploy = read('deploy.yml');
const gate = read('release-gate.yml');

/** Top-level job names and their bodies, from `jobs:` to end of file. */
function jobs(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return out;

  let current: string | null = null;
  let buffer: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      if (current) out.set(current, buffer.join('\n'));
      current = header[1];
      buffer = [];
      continue;
    }
    if (current) buffer.push(line);
  }
  if (current) out.set(current, buffer.join('\n'));
  return out;
}

/** `needs: [a, b]` and the block form. Comments are stripped first. */
function needsOf(jobBody: string): string[] {
  const uncommented = jobBody
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  const inline = /^\s*needs:\s*\[([^\]]*)\]/m.exec(uncommented);
  if (inline) return inline[1].split(',').map((s) => s.trim()).filter(Boolean);

  const single = /^\s*needs:\s*([A-Za-z0-9_-]+)\s*$/m.exec(uncommented);
  if (single) return [single[1]];

  const block = /^\s*needs:\s*\n((?:\s*-\s*[A-Za-z0-9_-]+\s*\n?)+)/m.exec(uncommented);
  if (block) return block[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);

  return [];
}

const deployJobs = jobs(deploy);

describe('the reader sees the workflows at all (positive fixture)', () => {
  it('finds both jobs in deploy.yml', () => {
    expect([...deployJobs.keys()].sort()).toEqual(['deploy', 'release-gate']);
  });

  it('parses an inline needs list', () => {
    expect(needsOf('    needs: [release-gate]\n')).toEqual(['release-gate']);
  });

  it('parses a block needs list', () => {
    expect(needsOf('    needs:\n      - a\n      - b\n')).toEqual(['a', 'b']);
  });

  it('ignores a needs that is only mentioned in a comment', () => {
    expect(needsOf('    # needs: [release-gate]\n    runs-on: x\n')).toEqual([]);
  });
});

describe('the deploy cannot run ahead of its gate', () => {
  it('release-gate.yml is callable as a reusable workflow', () => {
    expect(gate).toMatch(/^\s*workflow_call:\s*$/m);
  });

  it('deploy.yml calls the gate as a job rather than hoping it ran', () => {
    const gateJob = deployJobs.get('release-gate');
    expect(gateJob).toBeDefined();
    expect(gateJob).toMatch(/uses:\s*\.\/\.github\/workflows\/release-gate\.yml/);
  });

  it('the deploy job DEPENDS on that gate job', () => {
    expect(needsOf(deployJobs.get('deploy') ?? '')).toContain('release-gate');
  });

  /**
   * The property that actually matters, stated so it survives a new job being
   * added: anything that touches the production host must be gated. A future
   * job on the self-hosted runner with no `needs:` is the exact defect F-03
   * describes, arriving by a different door.
   */
  it('every job that runs on the production host is gated', () => {
    const ungated: string[] = [];
    for (const [name, body] of deployJobs) {
      if (!/runs-on:.*self-hosted/.test(body)) continue;
      if (needsOf(body).length === 0) ungated.push(name);
    }
    expect(ungated).toEqual([]);
  });

  it('the deploy is bound to a named environment, so it produces a record', () => {
    expect(deployJobs.get('deploy')).toMatch(/^\s*environment:\s*production\s*$/m);
  });
});

describe('the gate fails only for reasons that matter', () => {
  it('a summary always exists before the artifact step demands one', () => {
    const fallbackAt = gate.indexOf('Summary fallback');
    const uploadAt = gate.indexOf('Retain the summary');
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(uploadAt).toBeGreaterThan(-1);
    // Ordering is the whole point: a fallback after the upload guarantees
    // nothing.
    expect(fallbackAt).toBeLessThan(uploadAt);
  });

  it('the fallback runs even when an earlier step failed', () => {
    const block = gate.slice(gate.indexOf('Summary fallback'), gate.indexOf('Retain the summary'));
    expect(block).toMatch(/if:\s*always\(\)/);
  });
});

describe('a deploy proves itself before it is called a success', () => {
  const deployBody = deployJobs.get('deploy') ?? '';

  it('probes liveness, v1, auth and an unknown path', () => {
    expect(deployBody).toMatch(/\/healthz/);
    expect(deployBody).toMatch(/\/api\/v1\/catalog/);
    expect(deployBody).toMatch(/\/api\/v1\/bookings/);
    // The assertion that caught the real incident: a 404 proves the ROUTER
    // answered, where a blanket 401 proved auth ran before routing.
    expect(deployBody).toMatch(/zzz-nonexistent-path/);
  });

  it('probes the host locally, never the public origin', () => {
    // A probe through the CDN or proxy tests DNS and nginx, not the process
    // this job just restarted.
    expect(deployBody).toMatch(/127\.0\.0\.1/);
    expect(deployBody).not.toMatch(/https:\/\/api\.servana\.com\.ph/);
  });

  it('asserts the running build is the commit this run built', () => {
    expect(deployBody).toMatch(/BUILD_INFO\.json/);
    expect(deployBody).toMatch(/GITHUB_SHA/);
  });

  it('rolls back only when the probe failed', () => {
    expect(deployBody).toMatch(/if:\s*failure\(\)\s*&&\s*steps\.probe\.outcome\s*==\s*'failure'/);
  });

  it('snapshots the running build BEFORE the build overwrites it', () => {
    const snapshotAt = deployBody.indexOf('Snapshot the running build');
    const buildAt = deployBody.indexOf('name: Build');
    expect(snapshotAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(-1);
    expect(snapshotAt).toBeLessThan(buildAt);
  });

  it('a rollback still fails the run, because a recovered incident is not a success', () => {
    const rollback = deployBody.slice(deployBody.indexOf('Roll back to the previous build'));
    expect(rollback).toMatch(/exit 1/);
  });
});
