# The telemetry and crash sink: the decision, and why

**Decided 20 August 2026**, in response to TAB 06.

```
TELEMETRY_SINK: DECIDED — first-party ingest at POST /api/v1/telemetry
```

## The decision

**First-party.** Worker-app events are accepted by an authenticated endpoint on this backend,
re-scrubbed server-side against its own allowlist, and stored in `telemetry_events` in the
database the events already relate to. **No third-party analytics or crash-reporting service
is adopted.**

## Why — the reason is legal, not aesthetic

The worker app already scrubs its payloads to a ten-key allowlist carrying no name, no phone
number, no location, no token and no document id. It is easy to conclude from that the data is
anonymous and a foreign sink costs nothing. **That conclusion is wrong**, and the reason is the
statutory definition:

> **RA 10173 §3(g)** — personal information is *"any information … from which the identity of
> an individual is apparent or **can be reasonably and directly ascertained by the entity
> holding the information**, or when put together with other information would directly and
> certainly identify an individual."*

The scrubbed payload carries `bookingRef`, and the ingest stores `actor_uid` from the verified
token. **Servana holds the bookings table.** A booking reference identifies a provider and a
customer to Servana as surely as a name would. So the scrubbed payload is still personal
information *in our hands* — the scrubbing reduces exposure, it does not change the legal
character of the data.

That makes a third-party sink a **cross-border transfer of personal data**, which engages:

> **RA 10173 §21** — *"Each personal information controller is responsible for personal
> information under its control or custody, including information that have been transferred to
> a third party for processing, whether domestically or internationally … and shall use
> contractual or other reasonable means to provide a comparable level of protection while the
> information are being processed by a third party."*

Concretely, adopting a foreign processor would require:

| Obligation | Source |
|---|---|
| A processor agreement carrying the NPC's model contractual clauses (confidentiality, sub-processor approval, audit rights, minimum security, data-subject rights) | NPC guidance, 2024 |
| Registration of the data processing system with the NPC **within 20 days of the first data flow**, once ≥1,000 individuals' data is outsourced abroad | NPC registration rules |
| Accountability that **cannot be transferred** by outsourcing | §21 |
| Exposure to administrative fines of 0.5%–3% of annual gross income, capped at PHP 5,000,000 per violation | NPC Circular 2022-01 |

**Every one of those is dischargeable. None is free.** This platform has zero activated
providers, has never recorded a completed booking, and has no support process. Taking on a
foreign-processor obligation *before the first provider exists* is cost with no offsetting
benefit — and the benefit a vendor would bring (dashboards, alerting, retention) is a benefit
this platform cannot yet consume, because it has no one watching the signals it already emits.

First-party keeps the rows in the database they already relate to, in the jurisdiction they
already live in, and adds nothing to the register.

### What would change this decision

Stated up front so revisiting it is a measurement, not an argument:

- **Volume**: when the event rate makes a Postgres table the wrong shape (roughly, when nobody
  queries it because it is too slow), the answer is a purpose-built store — and by then the
  processor paperwork is worth doing.
- **Stack traces**: if crash *diagnostics* are wanted rather than crash *counts*, a real crash
  reporter is genuinely better than anything built here, and that is the moment to do the
  §21 work properly.
- **An operations team that wants dashboards.** Today there is none.

## What was rejected, and honestly

**A third-party service (Sentry / Crashlytics / PostHog).** Faster to stand up, arrives with
alerting and retention, and Firebase is *already* a processor in this stack — so the
cross-border relationship is not novel. Rejected because the paperwork lands before the first
provider does, and because a vendor's ingest accepts whatever the client sends: it would give
**one** control (the client's scrubber) where the TAB explicitly asks for two.

**Nothing at all — decide not to report.** Defensible for a pre-launch product, and rejected
because the worker app's failures are *silent by nature*. A job offer that never arrives
produces no error anywhere; the provider simply does not get the work, and the first report is
somebody asking why they had a quiet week.

## The design, and the two controls

- **`POST /api/v1/telemetry`**, `auth: 'authenticated'`. Attribution comes from the **verified
  token**; the client is forbidden to send `uid` at all, so a client cannot attribute an event
  to somebody else.
- **The server re-scrubs from its own allowlist**, maintained separately from the client's. A
  server that trusts a client's scrubbing has one control, not two — and the client runs on a
  device we do not control, in a build we cannot recall until TAB 02 ships.
- **Values are typed, not merely named.** A string smuggled into `durationMs` is dropped. A
  nested object or array is dropped, because "the allowlist covered the key" is no comfort if
  the value was the whole record.
- **There is no free-text field.** No `message`, no `stackTrace`, no `note`. A reporter that
  accepts a stack trace accepts whatever the strings in it happen to contain — on this app,
  addresses, customer names and signed URLs. Stack traces later are a separate decision with
  their own scrubbing and retention, not a field added to this one.
- **One bad event never costs the batch.** A telemetry endpoint that 400s teaches clients to
  stop sending, and the batches most worth having come from the build that is going wrong.
- **Write failures are counted and swallowed.** Telemetry that can 500 a client gets switched
  off in the build that most needed it. `worker_telemetry_write_failures_total` is the
  difference between *swallowed* and *unnoticed*.

### Retention: 90 days

Data minimisation under RA 10173 is not only about which fields are collected but for how long
they are kept. Without a stated period an event stream becomes a permanent behavioural record
of identifiable providers **by default rather than by decision**. 90 days answers every
question these events exist for and none that needs a year.

**The sweep is not installed by the migration.** A scheduled DELETE nobody has watched run is
the same species of unwatched machinery this programme keeps finding. It is listed as work with
an owner instead.

## The alert, and its owner

```
worker-activation-stall   P1
  metric     worker_telemetry_events_total
  condition  activationStarted > 0 and activationCompleted == 0 over 24 hours
  owner      the backend on-call engineer
```

**Absolute, not a rate**, deliberately: at launch the denominator is single digits and a
percentage of three providers is noise. What matters is the *shape* — people beginning
activation and nobody finishing.

**First action:** walk the activation path yourself against production before touching code.
Every endpoint in it returns 200 and none had been carried end to end by a person as of
2026-08-20 (TAB 09), so the likely failure is a step that refuses with a message a provider
cannot act on, not a route that errors.

## What is NOT satisfied, and why

The TAB's gate has three parts. Two are met locally; one is not:

| Gate | State |
|---|---|
| A worker-app event reaches something a human can query | **Locally yes** — endpoint, table and query path exist and are tested. **Not in production**: the migration is unapplied and nothing is deployed. |
| No location, document id, phone number or token is present in what arrives, verified against a real payload | **PASS** — `tests/telemetry-ingest.test.ts` sends a payload carrying live coordinates, a Firebase uid, a PH mobile number, a document id, a signed GCS URL, a bearer token, an OTP, a worker code, a customer name, a street address and a password, and asserts none of those **values** appears anywhere in the stored row. |
| At least one alert has been watched firing | **NOT MET.** The alert is defined with a threshold, an owner and a first action, and it has never been observed firing — because nothing scrapes the registry it reads. That is TAB 10's subject, and calling this done would be exactly the mistake this document is written against. |

**An alert that has been configured but never seen firing is a hypothesis.** It is recorded as
one.

## Sources

- [Republic Act 10173 — Data Privacy Act of 2012, National Privacy Commission](https://privacy.gov.ph/data-privacy-act/)
- [Republic Act No. 10173, Official Gazette](https://www.officialgazette.gov.ph/2012/08/15/republic-act-no-10173/)
- [Implementing Rules and Regulations of RA 10173, Supreme Court E-Library](https://elibrary.judiciary.gov.ph/thebookshelf/showdocs/2/70735)
- [Data protection laws in the Philippines — DLA Piper](https://www.dlapiperdataprotection.com/?t=law&c=PH)
- [Data Protected: Philippines — Linklaters](https://www.linklaters.com/en/insights/data-protected/data-protected---philippines)
- [Data Privacy Compliance for Foreign Companies in the Philippines — TTFC Law](https://ttfc.law/blog/2026-02-17-data-privacy-compliance-foreign-companies-philippines/)
