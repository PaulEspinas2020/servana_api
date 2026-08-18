/**
 * The caller matrix may claim a migration only where a manifest proves one.
 *
 * ## What this replaces, and why the old rule expired
 *
 * Six generated-document suites asserted, under the name "claims no migrated
 * client", that the word `migrated` appeared nowhere in the matrix:
 *
 *     for (const row of rows) expect(row).not.toContain('migrated');
 *
 * Their docblock gave the reason: *"Client repositories are out of scope until
 * the backend command completes, so every cell is legacy, planned or n/a."*
 * That was a correct rule for a world where no client's calls could be verified
 * from here — the strongest available guard against a document claiming credit
 * for work nobody had checked.
 *
 * TAB 04 ended that world. The Provider Web repository is in scope, its
 * canonical calls are generated from its own source with a `file:line` per call
 * site, and the manifest is vendored under `src/api/v1/client-manifests/`. Thirty
 * six migrations are now provable — and the old assertion failed *because* the
 * registry became correct.
 *
 * So the intent is kept and the mechanism is replaced. The rule was never "no
 * client is migrated"; it was "do not claim a migration nobody verified". A
 * `migrated` cell is legitimate exactly when that client publishes a manifest.
 *
 * Keeping the original assertion would have pinned a known-wrong registry in
 * place — which is the same failure this TAB exists to remove, one level up.
 */

import { loadManifests } from '../../scripts/reconcile-client-manifests';

/** Column header -> the `ClientName` the registry uses. */
const CLIENT_OF_COLUMN: Record<string, string> = {
  'Customer Mobile': 'customerMobile',
  'Customer Web': 'customerWeb',
  'Provider Mobile': 'providerMobile',
  'Provider Web': 'providerWeb',
  'Admin Web': 'admin',
};

const cells = (row: string): string[] =>
  row.split('|').slice(1, -1).map((c) => c.trim());

/**
 * Asserts every `migrated` cell in a generated caller matrix belongs to a client
 * that publishes a manifest. Throws with the offending row, because "a row is
 * wrong" without naming it is the start of a search rather than the end of one.
 */
export function expectMigrationsAreBackedByAManifest(doc: string, heading: string): void {
  const matrix = doc.slice(doc.indexOf(heading));
  const rows = matrix
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'));

  const header = rows.find((r) => r.includes('Capability'));
  if (!header) throw new Error(`no caller-matrix header under "${heading}"`);
  const columns = cells(header);

  const proven = new Set(loadManifests().map((m) => m.client));
  const body = rows.filter((r) => r !== header);
  if (body.length === 0) throw new Error(`caller matrix under "${heading}" has no rows`);

  for (const row of body) {
    const values = cells(row);
    values.forEach((value, index) => {
      if (value !== 'migrated') return;
      const client = CLIENT_OF_COLUMN[columns[index]];
      if (!client) {
        throw new Error(`"migrated" in a non-client column (${columns[index]}): ${row}`);
      }
      if (!proven.has(client)) {
        throw new Error(
          `"${columns[index]}" is claimed migrated but publishes no manifest, so nothing ` +
          `verified it:\n  ${row}`,
        );
      }
    });
  }
}
