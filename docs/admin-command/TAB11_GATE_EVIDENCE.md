# TAB 11 — Gate evidence

Every number in the closing gate, with how it was produced and what it excludes.

## 1. The programme gate, at the real repository path

```
npm run verify

Test Suites: 328 passed, 328 total
Tests:       6807 passed, 6807 total
EXIT=0
FAIL lines:  0
```

Run at the close of TAB 10, on `c8f547a`. This is the number the programme
certifies against.

Progression across the programme, from the TAB 00 baseline:

```
              suites   tests
TAB 00 base      315    6608
TAB 01           316    6631
TAB 02           318    6648
TAB 03           319    6665
TAB 04           320    6681
TAB 05           321    6692
TAB 06           322    6706
TAB 07           323    6719
TAB 08           324    6731
TAB 09           325    6754
TAB 10           328    6807
```

The step at TAB 10 is larger than this programme's own additions: a second agent
committed and is working in the same tree. See §4.

## 2. Timezone portability — the book's TAB 03 acceptance

The book asks for the suite green under `TZ=UTC` and `TZ=America/New_York`.

```
TZ=America/New_York npx jest utc-designator money-units page-meta-total
  Test Suites: 3 passed, 3 total
  Tests:       47 passed, 47 total
```

The full suite under `TZ=UTC` was run **in an isolated worktree** at `c8f547a`,
because the live working tree contains another agent's uncommitted changes and
would not have measured this programme's state:

```
git worktree add --detach <scratch> c8f547a
TZ=UTC npm run test:ci

Test Suites: 1 failed, 325 passed, 326 total
Tests:       1 failed, 6765 passed, 6766 total
```

### The one failure, and why it is not a defect

```
tests/parity-registry-hazards.test.js
  ● finds at least one Angular copy beside this repo
```

That test is a deliberate **anti-vacuous floor**, and its own docblock explains
it:

> The per-copy tests return early when a repo is not checked out beside this
> one … What is NOT correct is that behaviour being indistinguishable from every
> copy passing. Renaming all three directories would have left this whole
> describe green while checking nothing.

It requires at least one sibling Angular checkout to be readable. A worktree in a
scratch directory has no siblings, so it fails **by design** — the test is
working, and it is the reason a co-location assumption cannot rot silently.

At the real repository path, where the sibling checkouts exist, it passes. It
passed in every full-gate run of this programme.

**So: at `c8f547a`, under `TZ=UTC`, every test that can run outside its
co-location passes — 6765 of 6766, with the one exclusion named and explained.**

## 3. Contract figures, re-measured at the close

Derived from the generated documents, not carried forward from any TAB:

```
v1 paths                                    95
v1 schemas                                 161   (baseline 144)
empty schema positions                       0   (baseline 17)
date-time fields                            63
  — stating the UTC designator rule         63   (baseline 1)
admin operations documented                251   (baseline 6 in the contract)
  — with an authored payload schema         15
PageMeta.total                         integer   (was integer | null)
ProviderTimeOff.id                     integer   (was string)
GET /api/v1/openapi.json served            yes   (was: no path at all)
```

## 4. Concurrent work by another agent, and how it was kept separate

A second process was writing and committing to this working tree throughout.
Evidence, not inference: files appeared at 13:37 **while a gate was running**,
and `cf80d9c` was committed on top of `ffeea05` by a different author line.

How this programme stayed separable:

- **Every commit names its paths explicitly.** `git add -A` was never used, so
  no file of theirs was ever staged by this work.
- **Their one regression was repaired in its own commit** (`fb3ec20`), with the
  evidence for whose it was recorded in the message — `039-electrical-service-coverage.sql`
  has 0 DDL statements and 2 INSERTs, so it lands in the `no-schema-effect`
  bucket by the classifier's own rule and moved the count 14 → 15.
- **The closing TZ measurement used an isolated worktree**, so their
  uncommitted changes could not be attributed to this programme, in either
  direction.

At the time of writing they have uncommitted work in progress
(`serviceAreaFootprint.ts`, `serviceabilityService.ts`, route and startup
changes). Those make `orphan-route-ratchet` and the docs-drift checks red in the
live tree. **That is their work mid-flight, not a regression from this
programme** — proven by the isolated worktree run above, where the same three
suites pass 101/101 at `c8f547a`.

## 5. How every gate result in this programme was read

From the jest summary and a separately-written exit line — never from an exit
code alone:

```bash
npm run verify < /dev/null > "$LOG" 2>&1; echo "EXIT=$?" >> "$LOG"
```

No pipe in the chain. This repository has previously reported `exit 0` over a run
with a red suite because the pipeline's exit status was `tee`'s.

## 6. Negative controls

Every gate added by this programme was watched failing before it was trusted.

| TAB | Control | Result |
| --- | --- | --- |
| 01 | Drop an authored schema | 2 tests red |
| 01 | Add an admin route without regenerating | staleness check + suite red |
| 02 | Strip `properties` from `AdminAssignRequest` | 2 tests red |
| 03 | Restore the four-digit zone guard | 5 red, incl. both day-boundary cases |
| 04 | Disable the money stamp | coverage test red |
| 05 | Remove the rate range | 2 tests red |
| 06 | Reinstate the nullable contract type | 1 red |
| 06 | Reinstate the `hasMore` heuristic behind a cast | **PASSED — the detector had a hole**; hardened, then red |
| 07 | Revert `ProviderTimeOff.id` to string | 1 red |
| 08 | Remove the digest middleware | **114 red** |
| 09 | Restore `randomUUID()` in `adminError` | 2 red |

The TAB 06 row is the one worth keeping: a control that *passes* is the finding.

---
Servana Backend — Admin API Master Command · TAB 11 evidence
