# ADMIN_CATALOG_MOBILEVIEW

§75. **55 assertions, all passing** (`catalog-browser.mobileview.spec.ts`).

## Method

The catalog and the Service page are rendered into a host constrained to each
viewport, and every descendant is measured for `scrollWidth > width`. That is
the same condition a browser uses to decide whether to show a horizontal
scrollbar, so it is a measurement rather than an opinion.

Fixtures use deliberately long names — a 67-character service name and a
34-character category name. A short fixture never exercises truncation, which is
the thing actually keeping a row inside 320px.

Two exclusions, both deliberate and both documented in the spec:

- **`.overflow-x-auto` subtrees.** A wide table is fine when it scrolls itself.
  What must not happen is the *page* scrolling sideways.
- **`position: fixed` subtrees.** A fixed element lays out against the real
  browser viewport, not the resized test host, so measuring one reports Karma's
  window width — a false failure. Three tests failed this way on the first run;
  the finding was in the test, not the product. Overlay fit is asserted instead
  through the class contract that governs it: `w-full` + `sm:max-w-*` (full
  width below the first breakpoint, capped only once there is room),
  `max-h-[92vh]`, and `overflow-y-auto` so a long form scrolls rather than
  clipping its own footer.

## Viewports

| Viewport | Catalog: no overflow | New Service CTA reachable | Search + filters usable | Service page: no overflow |
|---|---|---|---|---|
| 320 × 568 | PASS | PASS | PASS | PASS |
| 360 × 640 | PASS | PASS | PASS | PASS |
| 375 × 667 | PASS | PASS | PASS | PASS |
| 390 × 844 | PASS | PASS | PASS | PASS |
| 412 × 915 | PASS | PASS | PASS | PASS |
| 430 × 932 | PASS | PASS | PASS | PASS |
| 768 × 1024 | PASS | PASS | PASS | PASS |
| 1024 × 768 | PASS | PASS | PASS | PASS |
| 1280 × 720 | PASS | PASS | PASS | PASS |
| 1366 × 768 | PASS | PASS | PASS | PASS |
| 1440 × 900 | PASS | PASS | PASS | PASS |
| 1920 × 1080 | PASS | PASS | PASS | PASS |

## Component states

| State | Result |
|---|---|
| Content-gap table at 320px | scrolls inside its own container; page does not | PASS |
| Filter panel open at 320px | no overflow | PASS |
| Archive dialog at 320px | fits; Cancel and Archive both present | PASS |
| Service dialog at 320px | fits; footer is `sticky` so Save stays on screen | PASS |
| Category dialog at 320px | fits | PASS |
| Overlays | `w-full` below `sm`, `sm:max-w-2xl` above | PASS |
| Pane mounting | one below `lg`, three from `lg` up | PASS |

## Design decisions this verified

- **Three panes collapse below `lg`.** At 320px each column would be ~100px.
  Below the breakpoint exactly one pane is mounted, with Back and breadcrumbs.
- **Dialogs are sheets on phones**, centred cards from `sm` up, with sticky
  header and footer so the title and Save never scroll away.
- **Every interactive control is ≥44px** and carries a visible focus ring.

## Gap

Rendered in headless Chrome at CSS-pixel widths, not on physical devices, and
without a software keyboard. Keyboard-safe layout is addressed structurally —
`max-h-[92vh]` with an internal scroller and a sticky footer — but not measured
against a real on-screen keyboard.
