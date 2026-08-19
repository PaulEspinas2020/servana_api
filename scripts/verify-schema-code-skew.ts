/**
 * Gate: every relation the application reads exists in the schema this
 * repository builds.
 *
 *   npm run db:skew
 *
 * A script rather than a jest test, for the same reason `verify-fresh-db.ts` is
 * one: PGlite loads its WASM through a dynamic import, which needs
 * `--experimental-vm-modules` inside jest's VM context. Adding that flag for the
 * whole suite to accommodate one check is a worse trade than running the check
 * where it already works.
 *
 * See `schema-code-skew.ts` for why this exists — in short, on 19 August 2026
 * every catalog read on production returned 500 while 5,957 tests were green,
 * because nothing asserted that the code and the schema agree.
 */

import { relationsReferencedInSource, missingRelations } from './schema-code-skew';
import { migrationInputs, baselineInput } from './lib/schemaBaseline';
import { runEmbeddedReplay } from './lib/embeddedEngine';

const main = async (): Promise<number> => {
  const referenced = relationsReferencedInSource();
  console.log(`  relations referenced in src/   ${referenced.size}`);

  // A broken extractor returns nothing and makes the whole gate vacuous.
  if (referenced.size < 100) {
    console.error(
      `\n  FAIL  the extractor found only ${referenced.size} relations. ` +
        `That is too few to be real — the gate would pass by finding nothing.`,
    );
    return 1;
  }

  const baseline = baselineInput();
  if (!baseline) {
    console.error('\n  FAIL  no baseline available — broken checkout.');
    return 1;
  }

  // Baseline first, then the pending chain on top: the order the deploy applies.
  const replay = await runEmbeddedReplay([baseline, ...migrationInputs()]);
  const present = new Set(replay.tablesReached);
  console.log(`  relations built by the chain   ${present.size}`);

  const missing = missingRelations(referenced, present);
  if (missing.length === 0) {
    console.log('\n  RESULT: PASS — the code and the schema agree.');
    return 0;
  }

  console.error(`\n  RESULT: FAIL — ${missing.length} relation(s) read but never built:\n`);
  for (const { relation, files } of missing) {
    console.error(`    ${relation}`);
    for (const f of files.slice(0, 3)) console.error(`        ${f.replace(process.cwd() + '/', '')}`);
    if (files.length > 3) console.error(`        …and ${files.length - 3} more`);
  }
  console.error(
    '\n  A query naming a relation the chain never creates is valid SQL that ' +
      'fails at runtime. This is the shape of the 2026-08-19 catalog outage.',
  );
  return 1;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('  FAIL  the skew gate itself threw:', err);
    process.exit(1);
  });
