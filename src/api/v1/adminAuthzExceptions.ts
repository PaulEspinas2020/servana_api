/**
 * Admin routes that carry a role guard but no named permission — each with the
 * reason it is allowed to (TAB 10, §12).
 *
 * ## Why an exception list and not a rule
 *
 * The property worth asserting is *"every admin route has a role guard AND a
 * named permission"*. Six routes legitimately do not, and a rule broad enough
 * to admit all six would admit anything. So the rule stays absolute and the
 * exceptions are enumerated — which means adding a seventh is a deliberate,
 * reviewable act rather than a silent widening.
 *
 * The book asks for exactly this: *"Enumerate the exceptions explicitly with a
 * reason; today the disbursements module would be four unexplained
 * exceptions."* Those four are gone — TAB 01 permissioned them.
 *
 * ## What does NOT belong here
 *
 * `requireSuperAdmin` routes. Demanding super-admin status is **stricter** than
 * any named permission, not weaker — super admins bypass `requirePermission`,
 * so the grant path being super-admin-only is the strongest guard in the
 * application. Listing them as exceptions would invite somebody to "fix" the
 * most protected routes there are.
 */

export interface AdminAuthzException {
  method: string;
  path: string;
  /** Required. An exception without a reason is a hole with a comment. */
  reason: string;
  /** Set when the route is expected to gain a permission later. */
  followUp?: string;
}

export const ADMIN_AUTHZ_EXCEPTIONS: readonly AdminAuthzException[] = Object.freeze([
  {
    method: 'get',
    path: '/api/admin/me/permissions',
    reason:
      'Every admin may read their OWN grants, so there is no permission to demand — a ' +
      'permission gating "what am I allowed to do" would be unanswerable for whoever ' +
      'lacked it. The subject is the token, never a parameter, so it discloses nothing ' +
      'about anybody else.',
  },
  {
    method: 'get',
    path: '/api/admin/permission-definitions',
    reason:
      'The catalogue of permission KEYS and their labels — the vocabulary, not anyone\'s ' +
      'grants. It is what renders a permission editor\'s checkboxes, and it names no ' +
      'admin and no assignment. Gating the dictionary while the grants themselves are ' +
      'super-admin-only protects nothing.',
  },
  {
    method: 'post',
    path: '/api/admin/admin-users/bootstrap-super-admin',
    reason:
      'Deliberately reachable by any authenticated caller, because it exists for the ' +
      'moment when NO admin exists and therefore nobody can hold a permission. The ' +
      'control is in the service, not the route: an advisory transaction lock serialises ' +
      'concurrent attempts, it refuses outright if any super admin exists (including a ' +
      'suspended one), it refuses a non-admin caller if any admin rows exist, and every ' +
      'denial is audited with outcome "blocked". TAB 05 additionally placed it on the ' +
      'strictest rate-limit tier.',
    followUp:
      'Re-verify after any change to admin_users seeding: the guarantee rests on the row ' +
      'counts inside that transaction, not on the route.',
  },

  {
    method: 'get',
    path: '/api/admin/notifications',
    reason:
      'An admin\'s own notification inbox. Scoped to the caller, like /me/permissions — ' +
      'the list is the actor\'s, so a permission would gate a person from their own ' +
      'messages.',
    followUp:
      'VERIFIED 2026-08-18 (TAB 10): adminNotificationService.listForAdmin queries ' +
      'WHERE admin_uid = $1. Genuinely actor-scoped, not global-with-a-filter — so this ' +
      'is an exception and not a leak. Re-check if the query ever gains a parameter.',
  },
  {
    method: 'patch',
    path: '/api/admin/notifications/read-all',
    reason:
      'Marks the CALLER\'s own notifications read, and nobody else\'s. Same scoping as the ' +
      'inbox above: the mutation names no subject, so there is no other admin whose state ' +
      'it could reach. A permission here would gate an admin from dismissing their own ' +
      'unread badge.',
  },
  {
    method: 'patch',
    path: '/api/admin/notifications/:id/read',
    reason:
      'Marks ONE of the caller\'s own notifications read. The :id addresses a row, so the ' +
      'ownership check has to be in the query rather than in the route — see the follow-up. ' +
      'Same argument as read-all otherwise: no permission can sensibly stand between an ' +
      'admin and their own unread badge.',
    followUp:
      'VERIFIED 2026-08-18 (TAB 10): adminNotificationService.markRead updates ' +
      'WHERE admin_uid = $1 AND read_at IS NULL AND id = $2 — scoped by actor AND id, so ' +
      'one admin cannot mark another\'s notification read. The question was worth asking ' +
      'rather than assuming: id-alone would have been a cross-actor write behind a route ' +
      'that looks self-scoped.',
  },
  {
    method: 'patch',
    path: '/api/admin/workers/:uid/archive',
    reason:
      'NOT a considered exception — a KNOWN DEFECT, listed so the matrix is honest rather ' +
      'than green. It duplicates /api/admin/users/:uid/archive, which demands ' +
      'users.archive, while this one demands nothing beyond role 1. So the redundant ' +
      'surface is also the weaker door — the third instance of that pattern in this book, ' +
      'after F-01 (payouts) and F-11 (refunds).',
    followUp:
      'TAB 09 classified it CONVERGE onto /api/admin/users/:uid/archive. Delete it once ' +
      'telemetry confirms silence (manual task 09.2/09.4). Until then it is a live gap.',
  },
  {
    method: 'get',
    path: '/api/admin/provider/reconciliation',
    reason:
      'NOT a considered exception — a KNOWN DEFECT. It overlaps ' +
      'GET /api/v1/admin/finance/reconciliation, which the portal calls and which demands ' +
      'reconciliation.view. Same duplicate-and-weaker shape as the row above.',
    followUp: 'TAB 09 classified it CONVERGE onto the v1 endpoint. Same telemetry gate.',
  },
]);

export const authzExceptionFor = (
  method: string,
  path: string,
): AdminAuthzException | undefined =>
  ADMIN_AUTHZ_EXCEPTIONS.find(
    (e) => e.method.toLowerCase() === method.toLowerCase() && e.path === path,
  );
