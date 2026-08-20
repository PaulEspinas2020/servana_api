/**
 * A structural reader for GitHub Actions workflow files.
 *
 * ## Why this is not a YAML parser
 *
 * `js-yaml` exists here only as a transitive dependency, and a gate whose
 * correctness rests on an undeclared package has a silent expiry date. Every
 * question asked of a workflow in this repository is structural — which jobs
 * exist, what each depends on, what condition guards it — and those are
 * answerable from lines. This is deliberately not a general parser and says so,
 * in the same spirit as `scripts/lib/routeTable.ts`.
 *
 * ## Why it exists at all
 *
 * Two separate defects in this repository were invisible to every local check
 * and only observable in GitHub's UI:
 *
 *   F-03  `deploy.yml` had no `needs:` on the release gate, so a red gate
 *         shipped d4b0150 to production.
 *   F-05  `fresh-db.yml` used `hashFiles()` in a JOB-level `if`, which is a
 *         parse-time fault. Every run was a 0s startup failure with no logs, so
 *         the only job that can catch an ownership defect had never executed.
 *
 * Both are properties of a text file. Neither needed a runner to detect. They
 * survived because nothing read the file.
 */

import fs from 'fs';
import path from 'path';

export const WORKFLOW_DIR = path.resolve(__dirname, '..', '..', '.github', 'workflows');

export const workflowFiles = (): string[] =>
  fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

export const readWorkflow = (file: string): string =>
  fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8').replace(/\r\n/g, '\n');

/** Top-level job names mapped to their bodies. */
export function jobsOf(source: string): Map<string, string> {
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

const uncomment = (body: string): string =>
  body
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/** `needs: [a, b]`, `needs: a`, and the block form. Comments ignored. */
export function needsOf(jobBody: string): string[] {
  const body = uncomment(jobBody);

  const inline = /^\s*needs:\s*\[([^\]]*)\]/m.exec(body);
  if (inline) return inline[1].split(',').map((s) => s.trim()).filter(Boolean);

  const single = /^\s*needs:\s*([A-Za-z0-9_-]+)\s*$/m.exec(body);
  if (single) return [single[1]];

  const block = /^\s*needs:\s*\n((?:\s*-\s*[A-Za-z0-9_-]+\s*\n?)+)/m.exec(body);
  if (block) return block[1].split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);

  return [];
}

/**
 * The JOB-level `if:`, which is the one with the restricted context.
 *
 * A job body contains step-level `if:` lines too, and those are indented deeper
 * — four spaces or more, under `steps:`. A job-level `if:` sits at exactly the
 * job's own key indentation, which is four spaces from column 0 given the job
 * name is at two. Matching on indentation is what keeps a legitimate
 * `steps.if: hashFiles(...)` from being reported as the fault.
 */
export function jobLevelIf(jobBody: string): string | null {
  for (const line of uncomment(jobBody).split('\n')) {
    const m = /^ {4}if:\s*(.+)$/.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Functions GitHub does NOT accept in a job-level `if`.
 *
 * From the Actions context reference: `jobs.<job_id>.if` may use `always`,
 * `cancelled`, `success` and `failure`; `hashFiles` is listed only for
 * `jobs.<job_id>.steps.if`, because it hashes files in the runner workspace and
 * no workspace exists when job conditions are evaluated.
 *
 * Using one is not a warning. It fails the workflow at parse time, before a
 * runner is assigned — which is why it produces a run with no logs.
 */
export const STEP_ONLY_FUNCTIONS = ['hashFiles'];

export interface StartupFault {
  file: string;
  job: string;
  condition: string;
  fn: string;
}

export function startupFaults(files = workflowFiles()): StartupFault[] {
  const out: StartupFault[] = [];
  for (const file of files) {
    for (const [job, body] of jobsOf(readWorkflow(file))) {
      const condition = jobLevelIf(body);
      if (!condition) continue;
      for (const fn of STEP_ONLY_FUNCTIONS) {
        if (new RegExp(`\\b${fn}\\s*\\(`).test(condition)) {
          out.push({ file, job, condition, fn });
        }
      }
    }
  }
  return out;
}
