# ADMIN_CATALOG_E2E

§64–§74, run in the Admin portal test suite.

Component-level rather than browser-driver E2E: the portal has no Cypress or
Playwright harness, and standing up one plus an authenticated admin session is a
larger piece of work than this phase. What is exercised is the real component
tree against a mocked API boundary — real signals, real template, real
navigation logic.

**35 specs in `catalog-browser.component.spec.ts`, all passing.**

| § | Behaviour | Result |
|---|---|---|
| 64 | Every service appears exactly once across the hierarchy | PASS |
| 64 | The whole catalog loads in one request | PASS |
| — | Selecting a Category filters Subcategories and Services | PASS |
| — | Selecting a Subcategory filters Services | PASS |
| — | Changing Category clears a now-invalid Subcategory selection | PASS |
| 25 | Mobile pane advances Categories → Subcategories → Services | PASS |
| 25 | Back walks up one level and stops at the root | PASS |
| 25 | One pane below `lg`, three from `lg` up | PASS |
| 73 | Search finds a service by name | PASS |
| 73 | A Category stays visible when only its descendants match | PASS |
| 73 | Matching a Category name keeps its services listed | PASS |
| 30 | A hit shows hierarchy context (`Personal Care › Facial`) | PASS |
| 31 | Filter to services with no approved providers | PASS |
| 31 | Filter combines with a taxonomy selection | PASS |
| 31 | Active-filter badge counts correctly; Reset clears | PASS |
| 71 | Provider count displayed is the backend's, not recounted | PASS |
| 72 | Zero-provider service is surfaced | PASS |
| 78 | No per-service request — 2 calls total (catalog + gaps) | PASS |
| 23 | Summary comes from the backend, not hard-coded | PASS |
| 47 | Content gaps reported; a failing gap request does not take the catalog down | PASS |
| 70 | Archive sets status and calls no delete | PASS |
| 49 | The API client exposes **no** method matching `/delete\|destroy\|force/` | PASS |
| 70 | Archive confirmation names the item and can be cancelled | PASS |
| — | Deactivate is a status change, not an archive | PASS |
| 79 | A save refetches the catalog rather than reloading the app | PASS |
| 79 | A selection whose row vanished after reload is dropped | PASS |
| 20 | A load failure shows a readable message | PASS |
| 52 | No "Level 1/2/3" or "Service Family" wording anywhere in the rendered page | PASS |
| 76 | A polite live region exists for announcements | PASS |
| 76 | Status carries an icon as well as a colour | PASS |
| 76 | Rows meet the 44px touch floor and show a focus ring | PASS |

## §65 / §66 / §67 / §68 / §69 — create, edit, move

Covered at the API boundary rather than through the dialog, because that is
where the guarantee lives. See `tests/catalog-admin-contract.test.ts` in the
backend — 42 specs asserting the SQL actually issued:

- create omits the `id` column; the sequence supplies it
- edit is `UPDATE … WHERE id = $1`, with no `DELETE`/`INSERT` anywhere
- move changes `subcategory_id` only and never writes `catalog_provider_services`
- subcategory move preserves its id and touches `services` only to count
- archive is an `UPDATE`, and reactivation clears `archived_at`

The dialogs are wired to exactly those calls, and the routing specs pin that
create is reachable and permission-guarded.

## §74 — legacy URLs

Asserted in `services.routes.spec.ts`:

| Legacy path | Behaviour |
|---|---|
| `new-service` | redirects to `new` (canonical create) |
| `update-service/:id` | redirects to the catalog root |
| `service-details/:id` | redirects to the catalog root |

The last two do **not** resolve to a Service page. The id they carried was a
legacy `service_families` id, which is not a `services.id`; mapping one to the
other would confidently open the wrong service.

`:serviceId` is declared last so no static segment above it is bound as an id —
also asserted.

## Gap

No browser-driver E2E against a running backend with a real admin session. The
first end-to-end write is therefore still unexercised. Recommended as the first
post-deploy check, not as a blocker for this phase.
