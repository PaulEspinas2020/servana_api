/**
 * Writes every generated TAB 07 finance document.
 *
 *   docs/finance/FINANCE_V1_CONTRACT.md
 *
 * Run: npm run finance:docs        (rewrite)
 *      npm run finance:docs:check  (fail if the committed file is stale)
 *
 * ## Why this is GENERATED and not written
 *
 * A hand-written financial contract is correct on the day it is written and
 * quietly wrong forever after — and in this domain "quietly wrong" means a
 * document that tells a provider they are paid at 48 hours while the scheduler
 * releases at 72, which is a thing that actually happened here.
 *
 * So every table below is produced by EXECUTING the real declarations —
 * `PROVIDER_ECONOMIC_MODELS`, `PAYMENT_TRANSITIONS`, `LEDGER_EVENTS`,
 * `RECONCILIATION_CHECKS`, `evaluatePayoutEligibility` — never by reading their
 * source or restating them. `tests/finance-docs-generated.test.ts` runs the
 * check, so a policy edit that is not followed by a regenerate fails the gate
 * rather than leaving the documentation describing economics the backend no
 * longer implements.
 *
 * The payout-eligibility table in particular is EVIDENCE rather than
 * description: it is produced by running the real decision function over a
 * fixed set of inputs, so if the precedence order changes the table changes with
 * it.
 */

import fs from 'fs';
import path from 'path';

import {
  CURRENCY,
  CLIENT_SURFACES,
  FINANCE_CAPABILITIES,
  LEDGER_EVENTS,
  LEDGER_EVENT_NAMES,
  PAYMENT_STATES,
  PAYMENT_STATE_NAMES,
  PAYMENT_TRANSITIONS,
  PROVIDER_ECONOMIC_MODELS,
  PROVIDER_ECONOMIC_MODEL_NAMES,
  PROVIDER_PAYOUT_WINDOW_HOURS,
  RECONCILIATION_CHECKS,
  REFUND_REFUSALS,
  REFUND_TRIGGERS,
  REFUND_TRIGGER_NAMES,
  evaluatePayoutEligibility,
  evaluateRefundEligibility,
  splitFor,
  type ClientSurface,
} from '../src/services/finance/financePolicy';
import { SERVANA_COMMISSION_RATE, PROVIDER_SHARE_PERCENT } from '../src/services/revenueSplit';
import { V1_CONTRACT, V1_PREFIX, type ContractEntry } from '../src/api/v1/contract';

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'finance');

const HEADER = `<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-finance-docs.ts, derived from
    src/services/finance/financePolicy.ts   (economics, states, refunds, checks)
    src/services/revenueSplit.ts            (the 80/20 split and its rounding)
    src/services/payoutStatus.ts            (the payout window and its dialects)
    src/api/v1/contract.ts                  (the canonical endpoints)
  Regenerate: npm run finance:docs
-->

# Finance v1 Contract
`;

const SURFACE_LABEL: Record<ClientSurface, string> = {
  customerMobile: 'Customer Mobile',
  customerWeb: 'Customer Web',
  providerMobile: 'Provider Mobile',
  providerWeb: 'Provider Web',
  admin: 'Admin Web',
};

const money = (n: number) => `${CURRENCY} ${n.toFixed(2)}`;
const yesNo = (b: boolean) => (b ? 'yes' : '—');

// ─── Sections ─────────────────────────────────────────────────────────────────

function economicsSection(): string {
  const rows = PROVIDER_ECONOMIC_MODEL_NAMES.map((name) => {
    const spec = PROVIDER_ECONOMIC_MODELS[name];
    return `| \`${name}\` | ${yesNo(spec.earnsJobShare)} | ${
      spec.earnsJobShare ? `${PROVIDER_SHARE_PERCENT}%` : '0%'
    } | ${spec.revenueOwner} | ${yesNo(spec.payoutEligible)} |`;
  }).join('\n');

  // Worked from the real split function, so the arithmetic in the document is
  // the arithmetic the platform performs.
  const example = 5000;
  const worked = PROVIDER_ECONOMIC_MODEL_NAMES.map((name) => {
    const split = splitFor(name, example);
    return `| \`${name}\` | ${money(split.gross)} | ${money(split.providerPayable)} | ${money(
      split.servanaRevenue,
    )} |`;
  }).join('\n');

  return `## 1. Provider economics

Servana retains **${Math.round(SERVANA_COMMISSION_RATE * 100)}%** of gross revenue and the
provider earns **${PROVIDER_SHARE_PERCENT}%** — uniformly, with no per-service, per-provider or
per-revenue-type variation. The rate lives in \`src/services/revenueSplit.ts\` and is imported
here rather than restated.

There are two economic models, and which one applies is decided by
\`user_credentials.is_internal_fixer\` — an admin-set, permissioned, audited flag. It is **not**
decided by the provider's role: role 4 is read as \`internal_provider\` in one module and
\`organization_provider\` in another, and neither is a statement about pay.

| Model | Earns a job share | Share | Revenue owner | Payout eligible |
| --- | --- | --- | --- | --- |
${rows}

${PROVIDER_ECONOMIC_MODEL_NAMES.map(
  (n) => `**\`${n}\`** — ${PROVIDER_ECONOMIC_MODELS[n].description}`,
).join('\n\n')}

### Worked example — a ${money(example)} booking

| Model | Gross | Provider payable | Servana revenue |
| --- | --- | --- | --- |
${worked}

The gross is the booking price **plus paid additional work**. On-site upsell is charged through
its own checkout and never writes back to \`bookings.final_price\`, so any reader treating
\`final_price\` as the gross silently drops it.

### Internal fixer policy

Internal fixer service revenue belongs to Servana in full, and compensation is salary through
payroll — a system this backend does not model and must not pretend to. **No per-job commission
is calculated, recorded or paid.**

This is enforced at the WRITER: \`createDisbursement\` creates no disbursement row for an
internal fixer and records a \`PROVIDER_EARNING_WITHHELD\` event with reason
\`INTERNAL_FIXER_SALARIED\` plus an \`INTERNAL_FIXER_REVENUE_RETAINED\` event for the gross.
The reconciliation check \`INTERNAL_FIXER_JOB_WITH_PROVIDER_PAYOUT\` remains as the detector for
rows created before that refusal existed, and for a provider tagged as an internal fixer after
their jobs completed.
`;
}

function paymentStateSection(): string {
  const rows = PAYMENT_STATE_NAMES.map((state) => {
    const spec = PAYMENT_STATES[state];
    const next = PAYMENT_TRANSITIONS[state];
    return `| \`${state}\` | ${yesNo(spec.captured)} | ${yesNo(spec.terminal)} | ${yesNo(
      spec.earningsEligible,
    )} | ${next.length ? next.map((s) => `\`${s}\``).join(', ') : '— (terminal)'} |`;
  }).join('\n');

  return `## 2. Payment state model

Payment state is **separate from booking state and linked to it**. A booking can be COMPLETED and
unpaid (cash awaiting confirmation), or paid and cancelled (refund pending). Collapsing the two
would make one of those unrepresentable.

| State | Captured | Terminal | Earnings eligible | May become |
| --- | --- | --- | --- | --- |
${rows}

${PAYMENT_STATE_NAMES.map((s) => `**\`${s}\`** — ${PAYMENT_STATES[s].description}`).join('\n\n')}

Two absences are deliberate. \`REFUNDED\` never returns to \`PAID\` — failure and settlement are
monotonic, so a delayed or duplicated processor event cannot demote a charge that has settled.
And \`FAILED\` never reaches \`REFUNDED\` directly, because there is nothing captured to return.
\`REFUNDING → PAID\` **is** present: the refund service restores it when the processor
definitively rejected the refund, and only then.
`;
}

function ledgerSection(): string {
  const rows = LEDGER_EVENT_NAMES.map((name) => {
    const spec = LEDGER_EVENTS[name];
    return `| \`${name}\` | ${spec.counterparty} | ${spec.direction} | ${yesNo(
      spec.monetary,
    )} | ${spec.milestone} |`;
  }).join('\n');

  return `## 3. Ledger and reconciliation model

The financial record has two halves, and both are needed.

**The calculator.** \`financeLedger.computeBookingFinance\` is a pure function from the source
rows — the booking, its payment, its paid additional work, its disbursement — to the canonical
financial picture. Every surface projects from it: the customer's payment screen, the provider's
earnings, the admin's reconciliation. A single function cannot disagree with itself.

**The event log.** \`finance_ledger_events\` is append-only, enforced by a database trigger that
refuses UPDATE and DELETE, and idempotent on \`event_key\` so a webhook retry or a double-click
cannot record the same money twice. Keys are composed from the FACT
(\`payment:47:captured\`), never from the attempt.

The calculator is the truth for all history; the log is the evidence for everything that happens
from here on. They are checked against each other by
\`LEDGER_EVENT_AMOUNT_MISMATCH\` and \`COMPLETED_BOOKING_WITHOUT_EARNING\`.

| Event | Counterparty | Direction | Carries money | Milestone |
| --- | --- | --- | --- | --- |
${rows}

${LEDGER_EVENT_NAMES.map((n) => `**\`${n}\`** — ${LEDGER_EVENTS[n].description}`).join('\n\n')}
`;
}

function payoutSection(): string {
  const NOW = new Date('2026-01-15T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

  const base = {
    economicModel: 'EXTERNAL_PROVIDER' as const,
    assignmentCompletedAt: hoursAgo(PROVIDER_PAYOUT_WINDOW_HOURS + 1),
    paymentState: 'PAID',
    providerPayable: 1200,
    hasBankAccount: true,
    now: NOW,
  };

  /**
   * Produced by RUNNING the real decision function, so the precedence order in
   * the table is the precedence order in the code. A hand-written list would
   * drift the first time a rule moved.
   */
  const scenarios: Array<[string, Parameters<typeof evaluatePayoutEligibility>[0]]> = [
    ['Paid, completed, window passed', base],
    ['Internal fixer', { ...base, economicModel: 'INTERNAL_FIXER' }],
    ['Already released', { ...base, alreadyReleased: true }],
    ['Job not completed', { ...base, assignmentCompletedAt: null }],
    ['Customer has not paid', { ...base, paymentState: 'PENDING' }],
    ['Refund in progress', { ...base, paymentState: 'REFUNDING' }],
    ['Zero provider share', { ...base, providerPayable: 0 }],
    ['Admin hold, no expiry', { ...base, holdReason: 'Under review', holdUntil: null }],
    ['Admin hold, expired', { ...base, holdReason: 'Under review', holdUntil: hoursAgo(1) }],
    ['No payout account', { ...base, hasBankAccount: false }],
    ['Inside the payout window', { ...base, assignmentCompletedAt: hoursAgo(1) }],
  ];

  const rows = scenarios
    .map(([label, input]) => {
      const verdict = evaluatePayoutEligibility(input);
      return `| ${label} | ${verdict.eligible ? '**releases**' : 'blocked'} | ${
        verdict.reason ? `\`${verdict.reason}\`` : '—'
      } | ${verdict.message ?? '—'} |`;
    })
    .join('\n');

  return `## 4. Payout policy

**The provider payout window is ${PROVIDER_PAYOUT_WINDOW_HOURS} hours** from job completion. That
number is declared once, in \`src/services/payoutStatus.ts\`, and is read by the release
scheduler, by the eligibility rule below, and by the expected-arrival date every earnings screen
shows. Provider Web once restated it as 48 against a scheduler releasing at 72, telling providers
their money was due a day early; there is now nothing to restate.

Eligibility returns the **first** blocking reason in precedence order, not a list — a provider
told "your payout is held" needs the sentence that is actionable, and an internal fixer must
never be told they are waiting for a window that will never pay them.

| Scenario | Outcome | Reason | Message |
| --- | --- | --- | --- |
${rows}

An admin hold with no expiry is indefinite; a hold whose expiry has passed no longer blocks. That
reproduces \`processPendingDisbursements\` exactly rather than offering a second opinion beside
the scheduler.
`;
}

function refundSection(): string {
  const triggerRows = REFUND_TRIGGER_NAMES.map((name) => {
    const spec = REFUND_TRIGGERS[name];
    return `| \`${name}\` | ${spec.initiators.join(', ')} | ${yesNo(
      spec.reversesProviderEarning,
    )} | ${spec.description} |`;
  }).join('\n');

  const refusalRows = Object.entries(REFUND_REFUSALS)
    .map(([code, message]) => `| \`${code}\` | ${message} |`)
    .join('\n');

  // Worked from the real eligibility function.
  const captured = 1500;
  const doubleRefund = evaluateRefundEligibility({
    paymentState: 'PAID',
    capturedAmount: captured,
    alreadyRefunded: captured,
    requestedAmount: captured,
    trigger: 'CUSTOMER_CANCELLED',
    actor: 'customer',
  });
  const partial = evaluateRefundEligibility({
    paymentState: 'PAID',
    capturedAmount: captured,
    alreadyRefunded: 500,
    trigger: 'CUSTOMER_CANCELLED',
    actor: 'customer',
  });

  return `## 5. Refund policy

One eligibility rule, two outcomes. A **customer requests** — which opens a
\`finance_refund_reviews\` row and calls no processor. An **admin issues** — which moves money.
Both run \`evaluateRefundEligibility\` first, so a request can never be accepted for a booking an
issue would refuse. A **provider is refused outright**: they are not a party to the customer's
charge, and a provider able to refund a booking they worked could erase the evidence of a job
they were paid for.

| Trigger | Who may cite it | Reverses provider earning | Meaning |
| --- | --- | --- | --- |
${triggerRows}

### Double refunds are prevented by arithmetic

The ceiling is **captured minus already refunded**, so a second full refund computes a ceiling of
zero and is refused — not by a flag somebody has to remember to check.

Worked from the real function against a ${money(captured)} capture:

| Case | Max refundable | Outcome |
| --- | --- | --- |
| Already refunded in full, asking again | ${money(doubleRefund.maxRefundable)} | \`${
    doubleRefund.refusal
  }\` |
| ${money(500)} already refunded, asking for the rest | ${money(partial.maxRefundable)} | ${
    partial.eligible ? `**allowed**, ${money(partial.amount)}` : `\`${partial.refusal}\``
  } |

\`REFUNDING\` counts as **still captured** for exactly this reason: a refund whose outcome is
unknown must not free the balance for a second attempt.

| Refusal | Message |
| --- | --- |
${refusalRows}
`;
}

function reconciliationSection(): string {
  const rows = RECONCILIATION_CHECKS.map(
    (check) =>
      `| \`${check.code}\` | ${check.severity} | ${check.requiredBySpec ? 'yes' : '—'} | ${
        check.detects
      } | ${check.remediation} |`,
  ).join('\n');

  return `## 6. Reconciliation checks

Every break a reconciliation run can find, declared in one catalog that the engine, the admin
read model and the tests all consume. Before this the checks were anonymous closures with their
codes written inline, so nothing could enumerate them and the admin UI could not label them.

"Required by spec" marks the checks TAB 07 §78 names by hand.

| Code | Severity | §78 | Detects | Remediation |
| --- | --- | --- | --- | --- |
${rows}

\`GET ${V1_PREFIX}/admin/finance/reconciliation\` is **read-only** — it reports the open breaks,
the check catalog and the platform money totals, including the outstanding provider liability
(accrued minus released). \`POST /api/admin/finance/reconciliation/run\` remains the way to
produce a fresh set; a GET that writes rows is one somebody eventually puts behind a dashboard
refresh timer.
`;
}

function endpointSection(): string {
  const finance = V1_CONTRACT.filter((e) => e.domain === 'finance');

  const rows = finance
    .map(
      (e: ContractEntry) =>
        `| \`${e.method.toUpperCase()} ${V1_PREFIX}${e.path}\` | ${e.auth} | ${
          e.idempotent ? 'yes' : 'no'
        } | \`${e.domainService}\` |`,
    )
    .join('\n');

  const legacyRows = finance
    .flatMap((e) =>
      e.legacy.map(
        (l) =>
          `| \`${l.method.toUpperCase()} ${l.path}\` | ${l.disposition} | \`${e.id}\` | ${l.note} |`,
      ),
    )
    .join('\n');

  const guardRows = finance
    .filter((e) => !e.idempotent)
    .map((e) => `**\`${e.id}\`** — ${e.replayGuard}`)
    .join('\n\n');

  return `## 7. Canonical endpoints

| Endpoint | Auth | Idempotent | Domain service |
| --- | --- | --- | --- |
${rows}

Every one of them delegates to a module under \`services/finance/\`, and all of them project from
the same calculator. That is what makes "Provider Web and Provider Mobile earnings match exactly"
a property of the code rather than an agreement between two implementations.

### Replay guards

${guardRows}

### Legacy routes still serving traffic

| Legacy route | Disposition | Canonical successor | Note |
| --- | --- | --- | --- |
${legacyRows}
`;
}

function callerMatrixSection(): string {
  const finance = V1_CONTRACT.filter((e) => e.domain === 'finance');

  const header = `| Capability | ${CLIENT_SURFACES.map((s) => SURFACE_LABEL[s]).join(' | ')} | Canonical endpoint(s) |`;
  const divider = `| --- | ${CLIENT_SURFACES.map(() => '---').join(' | ')} | --- |`;

  const rows = FINANCE_CAPABILITIES.map((capability) => {
    const cells = CLIENT_SURFACES.map((surface) => {
      if (!capability.surfaces.includes(surface)) return 'n/a';
      // The caller STATE comes from the contract, so this table cannot claim a
      // migration the contract does not record.
      const states = capability.contractIds.map(
        (id) => finance.find((e) => e.id === id)?.callers[surface] ?? 'planned',
      );
      return [...new Set(states)].join(' / ');
    });
    return `| ${capability.title} | ${cells.join(' | ')} | ${capability.contractIds
      .map((id) => `\`${id}\``)
      .join(', ')} |`;
  }).join('\n');

  const rationale = FINANCE_CAPABILITIES.map(
    (c) => `**${c.title}** (\`${c.domainModule}\`)\n\n${c.roleSplitRationale}`,
  ).join('\n\n');

  return `## 8. Cross-platform caller matrix

\`migrated\` — this client calls the canonical v1 route today.
\`legacy\` — this client calls a legacy route the canonical entry supersedes.
\`planned\` — this client will migrate; it calls no equivalent today.
\`n/a\` — the capability does not apply to this client.

${header}
${divider}
${rows}

No client is \`migrated\` yet: the platform application repositories are out of scope until the
backend Master Command completes. Every legacy route above stays mounted and now delegates to the
same domain service, so a client migrating later changes its URL and not its numbers.

### Why each capability is or is not role-split

${rationale}
`;
}

// ─── Composition ──────────────────────────────────────────────────────────────

export function financeContractDoc(): string {
  return [
    HEADER,
    `> The single financial truth for Customer Mobile, Customer Web, Provider Mobile,`,
    `> Provider Web and Admin Web. Everything below is derived by EXECUTING`,
    `> \`src/services/finance/financePolicy.ts\` — the numbers in this document are the numbers`,
    `> the platform computes.`,
    '',
    economicsSection(),
    paymentStateSection(),
    ledgerSection(),
    payoutSection(),
    refundSection(),
    reconciliationSection(),
    endpointSection(),
    callerMatrixSection(),
  ].join('\n');
}

export function generateAll(): Array<{ relPath: string; content: string }> {
  return [{ relPath: 'docs/finance/FINANCE_V1_CONTRACT.md', content: financeContractDoc() }];
}

/** Compares generated content with what is on disk. Newline-normalised for Windows checkouts. */
export function staleFiles(): string[] {
  const repoRoot = path.resolve(__dirname, '..');
  const stale: string[] = [];
  for (const file of generateAll()) {
    const abs = path.join(repoRoot, file.relPath);
    if (!fs.existsSync(abs)) {
      stale.push(file.relPath);
      continue;
    }
    const onDisk = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    if (onDisk !== file.content.replace(/\r\n/g, '\n')) stale.push(file.relPath);
  }
  return stale;
}

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const stale = staleFiles();
    if (stale.length) {
      console.error(`Finance docs are stale — run "npm run finance:docs":\n  ${stale.join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log('Finance docs are up to date.');
    }
  } else {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const file of generateAll()) {
      const abs = path.resolve(__dirname, '..', file.relPath);
      fs.writeFileSync(abs, file.content, 'utf8');
      console.log(`wrote ${file.relPath}`);
    }
  }
}
