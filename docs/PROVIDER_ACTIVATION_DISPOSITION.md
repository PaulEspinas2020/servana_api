# Provider activation — the v1 projection, and what it does and does not retire

**TAB 01 of the Servana Backend Master Command (worker/provider mobile).**
Measured against `4a647fd`, written 2026-08-21. Backend only. Nothing here was
pushed or deployed.

---

## What was published

`GET /api/v1/provider/activation` — `provider.activation.get`, contract entry in
`src/api/v1/contract.ts`, handler in `src/api/v1/domains/account.ts`, projection
in `src/services/account/providerActivationProjection.ts`, schema
`ProviderActivation` in `src/api/v1/openapi.ts`.

The v1 surface moved **96 paths / 115 operations → 97 / 116**. Every other
operation is byte-for-byte unchanged.

### Why a sibling endpoint rather than more fields on the profile

The Master Command accepts either. This is the reason for the choice, and it is
a measurement rather than a preference:

`ProviderProfile` is the response schema of **two** operations —
`provider.profile.get` (seat `self`) *and* `provider.publicProfile.get` (seat
`otherCustomer`, i.e. what a stranger sees when choosing a provider). Widening it
would declare, in the published contract, that a compliance checklist travels on
the endpoint customers read. Even with the value withheld at that seat, the
*shape* would then be one seat-computation bug away from disclosure.

The repository already refuses this exact trade elsewhere:
`providerProfileService`'s header rejects folding document previews into the
profile read because it "would turn every profile fetch into a document
disclosure".

Two supporting reasons:

- **Purpose limitation.** Rendering a provider card and driving an onboarding
  checklist are different purposes over different data. Separate resources let
  authorization, retention and caching differ per purpose, instead of all three
  being set by whichever purpose is laxest.
- **§56.** The projection fans out to the readiness engine, the activation
  engine, the onboarding case and the compliance inputs. The public profile read
  is a hot path on the customer browse screen. Loading it with activation work
  would be a cost regression for five clients in order to serve one.

### Authorization: `provider` — and the gate that corrected the first answer

This was decided twice, and the second answer is the right one. Recording both,
because the correction is the useful part.

**First answer, `authenticated`.** The legacy route this supersedes,
`GET /api/provider/account-state`, is mounted on `verifyAuth` **alone**, and
`provider.routes.ts` says why: it "already answers a non-provider with
`nextStep: ROLE_NOT_PERMITTED`, and both clients route on that. Replacing the
answer with a bare 403 would leave someone refused with no way to find out why."
Matching that seemed right — a successor stricter than the route it replaces is
the mirror image of the privilege-escalation-by-migration the contract's
`capability` field exists to prevent.

**`tests/legacy-authz-parity.test.ts` refused it, and was right to.** This entry
also supersedes `GET /api/provider/compliance`, which **is** provider-gated. At
`authenticated` the canonical route was a strictly **weaker** path to the same
compliance detail than the legacy route it claimed to replace. Compliance is
`null` for a non-provider today — but that is a property of the *service*, and
the *contract* is what the next change reads. The gate compares declared auth,
which is the only thing a future author will look at.

**Second answer, `provider`, and nothing was lost.** The discovery property
survives the tightening:

- `requireProviderRole` admits **every** provider role — suspended, unapproved,
  rejected, pending, mid-activation. Those are precisely the callers who need to
  be told why they cannot work, and they still receive the full checklist.
- The only callers now refused are **non-providers**, who have no activation
  state to discover. They receive `ROLE_REQUIRED` — a structured v1 error code a
  client can branch on, carrying the same information `nextStep:
  ROLE_NOT_PERMITTED` carried.
- `/api/provider/account-state` remains mounted and unchanged, so any client
  still wanting role-agnostic discovery has it. That is the additive guarantee
  doing its job.

So the endpoint is a rung stricter than one predecessor, equal to the other, and
looser than neither. Least privilege was available at no cost to the behaviour
that mattered — it just took a gate to notice that the first draft had traded it
away for nothing.

Authorization is also a property of the **signature**: the uid comes from the
verified token and there is no path, query or body parameter with which to name
another account. There is no seat at which this projection returns somebody
else's compliance state, because there is no way to ask for one.

### Fail closed, and say so

A denied or unknown account loads nothing, so `compliance`, `documentSummary`,
`certificationSummary` and `completion` are **`null`** — never zeroed. "We did
not look" and "we looked and nothing is outstanding" are different answers, and a
client that renders the second as the first tells a refused provider they are
compliant. `access` is still present and still deny-all, and `nextStep` still
names the reason.

Verified by test: a denied account issues **zero** document, certification and
provider-credential queries.

---

## Disposition of the eleven activation legacy routes

Each was classified by **reading its handler**, not its name or its schema.

| # | Legacy route | Method | Handler | Disposition |
|---|---|---|---|---|
| 1 | `/api/provider/account-state` | GET | `getProviderAccountState` | **SUBSUMED** |
| 2 | `/api/provider/compliance` | GET | `calculateCompliance` | **SUBSUMED** |
| 3 | `/api/provider/profile-center` | GET | `getProfileCenter` | **PARTIALLY SUBSUMED — stays** |
| 4 | `/api/provider/certifications` | GET, POST | `listCertifications`, `submitCertification` | **DISTINCT — promote (TAB 04)** |
| 5 | `/api/provider/verification-timeline` | GET | `getVerificationTimeline` | **DISTINCT — promote (TAB 04)** |
| 6 | `/api/provider/profile-fields` | GET | `getFieldRegistry` | **DISTINCT — static metadata** |
| 7 | `/api/provider/public-profile-preview` | GET | `getPublicProfile` | **DISTINCT — successor likely already exists** |
| 8 | `/api/provider/public-profile-revisions` | POST | `submitPublicProfileRevision` | **ALREADY MAPPED** to `provider.profile.patch` |
| 9 | `/api/provider/contact-changes` | POST | `requestContactChange` | **DISTINCT — migrate as a pair with 10** |
| 10 | `/api/provider/contact-changes/confirm` | POST | `confirmContactChange` | **DISTINCT — migrate as a pair with 9** |
| 11 | `/api/provider/activation/policy-acknowledgement` | POST | `acknowledgeProviderPolicy` | **DISTINCT — a consent write** |

### The finding that reframes TAB 04

**Two of the eleven are subsumed. Eight of the remaining nine are writes or
different-purpose reads.**

A projection is a READ. It was never going to retire a two-step contact-change
flow, a policy acknowledgement, a certification submission or a revision submit,
and planning that assumed otherwise would have under-scoped TAB 04. TAB 01 closes
the **read** half of this cluster; the write half is TAB 04's actual work.

### Notes per non-subsumed route

- **3, `profile-center`.** Its activation half — `completion`, `compliance`,
  `documentSummary`, `certificationSummary` — is now carried by the projection,
  from the *same functions*, which were extracted rather than copied. It also
  returns `privateAccount` (masked email/mobile), `publicProfile`,
  `operational.services`, `timeline` and `version`. That is a profile-and-revision
  surface with a different purpose, and it stays. It is already mapped
  `ROLE_SPECIFIC` on `provider.profile.get`.
- **4, `certifications`.** The projection carries only a **count**
  (`certificationSummary`). The list and the submission are a resource of their
  own and need promoting, not subsuming.
- **5, `verification-timeline`.** History, paginated, with its own retention
  question. Carrying twenty events into every activation read would be a
  data-minimization failure on a screen that does not need them.
- **6, `profile-fields`.** A versioned, per-deployment registry — not per-provider
  and highly cacheable. It belongs beside the profile resource, and folding
  static metadata into a per-provider read would defeat caching for both.
- **7, `public-profile-preview`.** Returns `getPublicProfile`, which is very
  likely already served by `GET /api/v1/providers/{providerUid}/profile` at seat
  `otherCustomer`. **Not asserted here** — the two projections were not
  field-by-field compared, and claiming equivalence without that comparison is
  the kind of name-based match this programme has already had to reject twice.
  TAB 04 should compare them and record the result.
- **9 and 10, `contact-changes`.** A request/confirm pair. Migrate together or
  not at all; a canonical request whose confirm is still legacy is a flow split
  across two contracts.

---

## Mandate 4 — the PATCH story, and a defect found while answering it

`PATCH /api/v1/provider/profile` accepts five fields: `displayName`, `biography`,
`skills`, `languages`, `experienceSummary`. Everything else stays where it is:

| Field class | Where it is changed | Status |
|---|---|---|
| `displayName`, `biography`, `skills`, `languages`, `experienceSummary` | `PATCH /api/v1/provider/profile` | canonical |
| `photo` | `POST /api/provider/profile-photo-submissions` | **stays legacy** — it is a file, with MIME/magic-byte/size validation §44 requires |
| `legalName`, `birthDate`, `legalAddress` | re-verification flow | stays legacy |
| `email`, `mobile` | `/api/provider/contact-changes` (+ `confirm`) | stays legacy — see 9/10 above |
| `branch`, `serviceArea`, `providerType`, `reviewerNotes` | admin surfaces | not provider-editable at all |

### The defect

One rule — *which fields may a provider propose a change to* — was stated in
three places, and two of them disagreed:

1. `PROFILE_FIELD_REGISTRY` — six fields carry `editable: 'review'`.
2. `PROVIDER_SELF_EDITABLE_FIELDS` — derived from (1), so also six.
3. `submitPublicProfileRevision`'s hand-written allow-list — **five**.

The missing one is `photo`. So `patchProviderProfile` asked `providerMayEdit`
(which consults the registry), was told yes, let the request through, and printed
`PROVIDER_SELF_EDITABLE_FIELDS` back to the provider as the list of reviewable
fields — advertising `photo`. The request then reached the compliance service and
was refused with **`FIELD_NOT_EDITABLE`**, a code `provider.profile.patch` does
**not** declare. A client gating on the published contract — precisely what TAB 03
asks every client to do — could not have branched on it.

### The fix

The registry was not what was wrong: `photo` genuinely *is* provider-editable
under review; it simply is not editable *through that channel*. So:

- `PUBLIC_PROFILE_REVISION_FIELDS` is now an exported constant, and the
  compliance service's allow-list is built from it.
- `REVIEW_FIELD_CHANNELS` names each review-editable field the revision channel
  does **not** carry, and where it goes instead.
- `patchProviderProfile` refuses such a field with the **declared** code
  (`PROVIDER_FIELD_NOT_EDITABLE` → `ACCOUNT_FIELD_NOT_WRITABLE`) and a message
  naming the route that does accept it — which is what its own docblock already
  promised for identifier and operational fields.
- `tests/provider-profile-patch-channels.test.ts` asserts a **relationship**, not
  a list: the revision channel and the named exceptions must together cover the
  registry exactly. A seventh review field now fails the build until somebody
  states which channel carries it — the question that was never asked about
  `photo`.

No legacy route changed. `POST /api/provider/public-profile-revisions` reaches
`submitPublicProfileRevision` directly and never passes through
`patchProviderProfile`, so its behaviour is identical.

---

## Compatibility evidence

Proven by **diffing captured responses**, per the standing rule — not by
reasoning about the change.

A fixed fake database was seeded and five projections captured, once on the
unmodified tree and once on the changed tree:

- `GET /api/provider/account-state`
- `GET /api/provider/compliance`
- `GET /api/provider/profile-center`
- `GET /api/v1/provider/profile` (seat `self`)
- `GET /api/v1/providers/{uid}/profile` (seat `otherCustomer`)

**Result: identical. `md5 8fc4ff41a8986d339e3c6f697d95e607` on both sides.**

The baseline capture was taken with the changes stashed, and three sentinels
confirmed the tree really was at baseline (`getProviderAccountStateDetailed`,
`summariseDocuments` and `provider.activation.get` each occurring zero times).
Without that check a stash that silently failed would have produced two captures
of the same tree and an equally empty diff.

`visibleFields` semantics are intact because `ProviderProfile` was not touched at
all — the byte-identical capture at both seats is the evidence.

---

## Gates that refused a first draft

Worth recording, because each one caught something reasoning had missed:

| Gate | What it refused |
|---|---|
| `account:docs:check` | A second generated contract document derived from the account domain, which the first regeneration did not cover. |
| `convergence:docs:check` (§137) | A contract entry claimed by no capability — the manifest could not describe the router. Fixed by declaring `providerActivation` as a capability of its own rather than folding it into `providerProfile`, which would have contradicted the sibling-resource design. |
| `legacy-authz-parity` | The endpoint at `authenticated` being a weaker route to compliance detail than the `provider`-gated route it supersedes. See above. |
| `v1-router` | An implemented contract entry with no live request case, so nothing proved it answered 2xx at its declared path. |

Three of the four were caught only because the gate read the *contract* rather
than the implementation. The service behaviour was already safe in every case;
what was wrong was what the contract declared, which is what the next change
reads.

---

## What TAB 01 did not do

- **Certifications, timeline, contact changes, policy acknowledgement and the
  field registry are still legacy-only.** They are TAB 04, and the table above is
  the disposition list that TAB asked for.
- **`public-profile-preview` was not proven equivalent** to the v1 public profile.
  It looks equivalent. Looking equivalent is how two false matches already got
  into this programme, so it is recorded as unverified rather than as done.
- **The document-count divergence was not reconciled.**
  `providerAccountStateService` counts documents from `calculateReadiness`
  (row-driven); `documentSummary` counts them from `listDocuments`
  (catalog-driven). Both now appear in one response, so a disagreement between
  them is visible where it previously was not. This projection did not create the
  divergence and deliberately did not paper over it — reconciling the two is TAB
  04 work, since it is a question about which of the eleven routes owns the
  answer.
