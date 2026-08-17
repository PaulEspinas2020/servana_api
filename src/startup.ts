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
 */

import type { Dependency } from './lifecycle';

import { ensureChatLifecycleSchema } from './chat/chat.repository';
import { initProviderCatalogSchema, seedBuiltInOfferings } from './services/providerCatalogService';
import { seedReasonCodes, seedRequirementDefinitions } from './services/adminOnboardingService';
import { ensureBookingOpsSchema } from './services/adminBookingService';
import { ensureAuditSchema } from './services/adminAuditService';
import { ensureCommunicationSchema } from './services/adminCommunicationService';
import { ensureDashboardSchema } from './services/adminDashboardService';
import { ensurePermissionSchema } from './services/adminPermissionService';
import { ensureFinanceSchema } from './services/adminFinanceService';
import { bootstrap as bootstrapAutoOnline } from './services/providerAutoOnlineEngine';
import { ensureAdminCreateBookingSchema } from './services/adminCreateBookingService';
import { ensureReviewTables } from './services/customerReviewService';
import { ensureCustomerSupportTables } from './services/customerSupportService';

/** Generous, but bounded. A hung bootstrap must not hold the boot open. */
const SCHEMA_TIMEOUT_MS = 30_000;

export const STARTUP_DEPENDENCIES: readonly Dependency[] = Object.freeze([
  {
    name: 'finance-schema',
    kind: 'required',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: ensureFinanceSchema,
    why:
      'Payment. Serving finance endpoints against a half-built schema is how a ' +
      'provider is shown an earnings figure that is missing rows.',
  },
  {
    name: 'booking-ops-schema',
    kind: 'required',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: ensureBookingOpsSchema,
    why:
      'Booking. Carries the timeline and audit tables every lifecycle ' +
      'transition writes to.',
  },
  {
    name: 'admin-permission-schema',
    kind: 'required',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: ensurePermissionSchema,
    why:
      'Authorization. Named admin permissions are checked against these tables; ' +
      'an absent grant table is an authorization decision made by accident.',
  },

  {
    name: 'admin-create-booking-schema',
    kind: 'required',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: ensureAdminCreateBookingSchema,
    why:
      'Booking. Admin-created bookings are real bookings; the idempotency table ' +
      'this creates is what stops a retried admin form producing two of them.',
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
    name: 'customer-support-schema',
    kind: 'optional',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: ensureCustomerSupportTables,
    why: 'Was executed at import of a route module.',
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
    start: async () => {
      await initProviderCatalogSchema();
      await seedBuiltInOfferings();
    },
    why: 'Seeds built-in offerings. The canonical catalog is Catalog V2, which migrations own.',
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
  {
    name: 'admin-audit-schema',
    kind: 'optional',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: ensureAuditSchema,
    why:
      'Admin audit trail. Optional ONLY because losing it degrades observability ' +
      'rather than correctness — it is the first of these that should become ' +
      'required once TAB 02 owns the DDL.',
  },
  {
    name: 'admin-communication-schema',
    kind: 'optional',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: ensureCommunicationSchema,
    why: 'Admin messaging surface.',
  },
  {
    name: 'admin-dashboard-schema',
    kind: 'optional',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: ensureDashboardSchema,
    why: 'Read-only aggregates for the admin dashboard.',
  },
  {
    name: 'provider-auto-online',
    kind: 'optional',
    timeoutMs: SCHEMA_TIMEOUT_MS,
    start: bootstrapAutoOnline,
    why: 'Provider presence engine. Providers can still be assigned manually while it is down.',
  },
]);
