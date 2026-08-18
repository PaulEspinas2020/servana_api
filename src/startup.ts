/**
 * The startup dependency graph (TAB 03).
 *
 * ## Why this is a list and not twelve IIFEs
 *
 * `app.ts` used to run these as twelve fire-and-forget `(async () => …)()`
 * blocks at import time, each swallowing its own error into `console.error`,
 * followed immediately by `httpServer.listen()`. Three consequences, all of
 * them real rather than theoretical:
 *
 *   1. the server accepted requests while its schema was still being created;
 *   2. a bootstrap that failed outright left the process serving traffic
 *      against a schema that was never finished;
 *   3. nothing anywhere said which of them mattered.
 *
 * Declaring them as data fixes the third problem first, because the other two
 * cannot be fixed without an answer to it: you cannot gate readiness on
 * "important" bootstraps until something says which those are.
 *
 * ## Classification
 *
 * TAB 03's stop condition is that a booking, payment, identity or authorization
 * dependency must not be silently downgraded to optional. Those are `required`
 * here. Everything else is `optional` and REPORTED — `degradedReport()` names
 * it — which is the honest description of what the previous code did to all
 * twelve without saying so.
 *
 * `required` withholds readiness rather than killing the process. See
 * `lifecycle.ts` for why that is deliberate while TAB 02 is outstanding.
 *
 * ## The list is SHRINKING, and that is the goal (TAB 02)
 *
 * It was nineteen. Each entry existed because some object was created by the
 * application at runtime; as the baseline takes ownership, the entry has no work
 * left to do and is deleted rather than left as a no-op await before `listen`.
 *
 * Note what that does to the classification above. The `payment` slot
 * (`finance-schema`) and the `identity` slot (`identity-columns`) are GONE — not
 * downgraded to optional, which is what TAB 03 forbids, but removed, because
 * `payments`, its trigger, the three finance tables and the normalized identifier
 * columns all come from `scripts/baseline/000-baseline.sql` and no longer depend
 * on a bootstrap having run. The `booking` slots (booking-ops, admin-create-booking)
 * are gone too. ONE `required` entry remains — `admin-permission-seed` — and it
 * seeds DATA, not schema, which is why it survives a pass whose goal is no DDL.
 *
 * When this list reaches zero the API can start with DDL privileges revoked,
 * which is TAB 02's acceptance criterion. Do NOT add an entry here to create
 * schema; add a migration. `npm run schema:authority` fails if an object is
 * created at runtime that neither a migration nor the baseline declares.
 */

import type { Dependency } from './lifecycle';

import { ensureChatLifecycleSchema } from './chat/chat.repository';
import { seedBuiltInOfferings } from './services/providerCatalogService';
import { seedReasonCodes, seedRequirementDefinitions } from './services/adminOnboardingService';
import { seedAdminPermissions } from './services/adminPermissionService';
import { ensureReviewTables } from './services/customerReviewService';

/** Generous, but bounded. A hung bootstrap must not hold the boot open. */
const SCHEMA_TIMEOUT_MS = 30_000;

export const STARTUP_DEPENDENCIES: readonly Dependency[] = Object.freeze([
  {
    name: 'admin-permission-seed',
    kind: 'required',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: seedAdminPermissions,
    why:
      'Authorization, and DATA rather than schema since TAB 02 — the four tables ' +
      'come from the baseline. Still required: a grant row is meaningless without ' +
      'its definition row, so an unseeded database holds grants that resolve to ' +
      'nothing, which is an authorization outcome decided by absence.',
  },


  // ── Optional: degraded, reported, and not a reason to withhold traffic ──
  {
    name: 'customer-review-schema',
    kind: 'optional',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: ensureReviewTables,
    why: 'Was executed at import of customerReviewController.',
  },
  {
    name: 'chat-lifecycle-schema',
    kind: 'optional',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: ensureChatLifecycleSchema,
    why: 'Every read path COALESCEs the columns this adds, so their absence degrades chat rather than breaking it.',
  },
  {
    name: 'provider-catalog',
    kind: 'optional',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: seedBuiltInOfferings,
    why:
      'Seeds built-in offerings — DATA only since TAB 02, the schema comes from ' +
      'the baseline. The canonical catalog is Catalog V2, which migrations own.',
  },
  {
    name: 'provider-onboarding',
    kind: 'optional',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: async () => {
      await seedReasonCodes();
      await seedRequirementDefinitions();
    },
    why:
      'Onboarding reference DATA only — the schema comes from the baseline now ' +
      '(TAB 02). An incomplete seed shows fewer reason codes, not a wrong booking.',
  },
]);
