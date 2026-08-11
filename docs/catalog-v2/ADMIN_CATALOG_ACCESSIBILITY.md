# ADMIN_CATALOG_ACCESSIBILITY

§76, WCAG 2.2 AA-oriented. Verified by assertion in the component specs and by
reading the rendered markup, not by an automated axe run — the portal has no
axe-core harness wired.

## What is in place

| Requirement | Implementation |
|---|---|
| Keyboard navigation | Every control is a real `<button>`, `<input>`, `<select>` or `<textarea>`. No click handler on a `div`. |
| Visible focus | `focus-visible:ring-2 focus-visible:ring-indigo-500` on every interactive element; asserted on rows. |
| Focus order | DOM order matches visual order in all three panes and both dialogs. |
| Dialog focus management | Both dialogs move focus to `[data-autofocus]` on open (`ngAfterViewInit`). |
| Dialog semantics | `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the heading. |
| Escape to close | `(keydown.escape)` on both dialogs and the backdrop. |
| Backdrop click | Closes only when the click target *is* the backdrop, so a drag out of the form does not discard it. |
| Labels | Every field has a `<label for>`. No placeholder-as-label. |
| Field help | `aria-describedby` on Service Name and on the disabled Subcategory select. |
| Invalid state | `aria-invalid` on the required name field. |
| Menus | `role="menu"` / `role="menuitem"`, `aria-expanded` on the trigger, `aria-label` naming the row ("Actions for Pimple Facial"). |
| Disclosures | `aria-expanded` + `aria-controls` on the gap panel and the filter toggle. |
| Errors | `role="alert"` on every error banner. |
| Success announcements | A single `role="status" aria-live="polite"` region receives every save, status change and archive message. |
| Status not colour-only | Every status chip carries an icon *and* the status word: `bi-check-circle-fill` active, `bi-pause-circle-fill` inactive, `bi-archive-fill` archived. Asserted. |
| Zero-provider warning | Icon + text, never colour alone. |
| Touch targets | `min-h-[44px]` on every control; `36px` minimum on the compact row overflow button, which sits beside a full-height row target. |
| Hierarchy semantics | `<h1>` → `<h2>` per pane → `<h3>` per section; breadcrumbs in `<nav aria-label="Breadcrumb">` with an `<ol>`. |
| Tables | `<th scope="col">` on the gap table. |
| Current selection | `aria-current` on the selected Category and Subcategory rows. |
| Icon noise | Every decorative icon is `aria-hidden="true"`. |
| Reduced motion | Only `animate-pulse` skeletons and 120–240ms colour/opacity transitions; no transform-based motion. The project's Tailwind base respects `prefers-reduced-motion`. |
| Zoom | No `user-scalable=no`; layout is relative units and flex/grid throughout. |

## Asserted in tests

- a polite live region exists
- status icons differ per status
- rows carry `min-h-[44px]` and `focus-visible:ring-2`
- both dialog action buttons are present and reachable at 320px

## Gaps

- **No automated axe-core / Lighthouse pass.** Contrast ratios follow the
  portal's existing indigo/gray/amber token usage, which is unchanged from
  screens already shipped, but they have not been machine-verified here.
- **No screen-reader run.** The ARIA is correct by construction and by markup
  review; it has not been driven with NVDA or VoiceOver.
- **Focus is moved into dialogs but not trapped.** Tab can reach the page
  behind. Escape and backdrop-click both close, and focus is not returned to the
  trigger on close. Worth closing, and small — it is a shared concern with the
  portal's other dialogs rather than something new here.

Recommend wiring axe-core into `npm run test:ci` as a follow-up; it would cover
this screen and every existing one at once.
