/**
 * One admin may not both request and approve the same refund.
 *
 * ## The finding this encodes
 *
 * The permission catalogue declares:
 *
 *   refunds.approve         requires refunds.review.open
 *   refunds.mark_processed  requires refunds.approve
 *
 * `requires` exists so nobody holds a power without its prerequisites. On this
 * chain it does the opposite: it GUARANTEES that every approver can also open a
 * request, and every processor can do both. A single admin therefore runs
 * open -> approve -> processed by construction, and no arrangement of grants can
 * separate them. The control cannot be expressed as a permission at all.
 *
 * Before this suite, `approveRefund` matched only `WHERE id=$1 AND
 * status='requested'`. `requested_by` was written by both writers — the admin
 * route and `bookingPaymentService` — and read by nothing.
 *
 * ## Why the executor rather than the portal
 *
 * Hiding the Approve button for the requesting admin would satisfy a
 * screenshot. The service is reachable from any client holding a token, so a
 * control that lives in a template is a control that does not exist.
 *
 * ## What is asserted here, and what is not
 *
 * These tests drive the real `approveRefund` against a fake `dbQuery`, so they
 * prove the SQL carries the guard and the refusal is classified and audited.
 * They do not prove PostgreSQL applies the predicate — that is the engine's job
 * and `tests/fresh-db` territory. What they can prove, and what matters most,
 * is that the guard is in the write itself rather than in a read before it.
 */

const queries: Array<{ sql: string; params: unknown[] }> = [];
const audits: Array<Record<string, unknown>> = [];

/** What the fake engine returns for the next query, in order. */
let responses: Array<{ rows: unknown[] }> = [];

jest.mock('../src/db/dbQuery', () => ({
  __esModule: true,
  default: {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return responses.shift() ?? { rows: [] };
    },
  },
}));

jest.mock('../src/services/adminAuditService', () => ({
  __esModule: true,
  auditFire: (entry: Record<string, unknown>) => {
    audits.push(entry);
  },
  auditLog: async () => undefined,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const svc = require('../src/services/adminFinanceService');

const REQUESTER = 'admin-alice';
const APPROVER = 'admin-bob';

const approvedRow = { id: 7, booking_id: 41, amount: '500.00', payout_reversal_needed: false };

beforeEach(() => {
  queries.length = 0;
  audits.length = 0;
  responses = [];
  delete process.env.REFUND_ALLOW_SELF_APPROVAL;
});

describe('the approval guard is part of the write, not a read before it', () => {
  it('carries the requester comparison in the UPDATE itself', async () => {
    responses = [{ rows: [approvedRow] }];
    await svc.approveRefund(7, APPROVER, 'Bob', 'req-1');

    const update = queries[0];
    expect(update.sql).toContain('UPDATE');
    expect(update.sql).toContain("status='approved'");
    // The guard, in the same statement as the write. A SELECT-then-UPDATE would
    // leave a window in which the row changes between the check and the write.
    expect(update.sql).toContain('requested_by');
    expect(update.sql).toMatch(/requested_by\s+IS\s+NULL\s+OR\s+requested_by\s*<>\s*\$2/i);
    expect(update.params).toEqual([7, APPROVER]);
  });

  it('issues exactly one query when the approval succeeds', async () => {
    // The diagnostic read must happen only on failure. An unconditional second
    // query would double the cost of the common path to improve a message
    // nobody sees.
    responses = [{ rows: [approvedRow] }];
    await svc.approveRefund(7, APPROVER, 'Bob', 'req-1');
    expect(queries).toHaveLength(1);
  });
});

describe('a self-approval is refused', () => {
  it('refuses when the approver is the admin who requested it', async () => {
    responses = [
      { rows: [] }, // the guarded UPDATE matches nothing
      { rows: [{ status: 'requested', requested_by: REQUESTER }] }, // the diagnostic read
    ];

    await expect(svc.approveRefund(7, REQUESTER, 'Alice', 'req-2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('says what is wrong without naming the other admin', async () => {
    responses = [{ rows: [] }, { rows: [{ status: 'requested', requested_by: REQUESTER }] }];
    await expect(svc.approveRefund(7, REQUESTER, 'Alice', 'req-2')).rejects.toThrow(
      /approved by someone other than the admin who requested it/i,
    );
  });

  it('records the attempt rather than only refusing it', async () => {
    /**
     * An admin trying to approve their own refund request is something somebody
     * should be able to look up later — whether it was a misunderstanding or an
     * attempt. A refusal that leaves no trace tells you nothing about how often
     * it happens.
     */
    responses = [{ rows: [] }, { rows: [{ status: 'requested', requested_by: REQUESTER }] }];
    await expect(svc.approveRefund(7, REQUESTER, 'Alice', 'req-2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const refusal = audits.find((a) => a.action === 'finance_refund_self_approval_refused');
    expect(refusal).toBeDefined();
    expect(refusal).toMatchObject({
      outcome: 'failed',
      actorUid: REQUESTER,
      entityType: 'refund_review',
      entityId: '7',
    });
  });

  it('does not approve as a side effect of refusing', async () => {
    responses = [{ rows: [] }, { rows: [{ status: 'requested', requested_by: REQUESTER }] }];
    await expect(svc.approveRefund(7, REQUESTER, 'Alice', 'req-2')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(audits.some((a) => a.action === 'finance_refund_approved')).toBe(false);
  });
});

describe('a refusal for another reason is still classified as that reason', () => {
  it('reports a wrong-status row as a business-rule failure, not a policy one', async () => {
    // Same zero rows, different cause. Reporting an already-approved refund as
    // a segregation failure would send an operator looking for a second admin
    // when what they need is a different refund.
    responses = [{ rows: [] }, { rows: [{ status: 'approved', requested_by: REQUESTER }] }];
    await expect(svc.approveRefund(7, APPROVER, 'Bob', 'req-3')).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
    });
  });

  it('reports a missing row as a business-rule failure', async () => {
    responses = [{ rows: [] }, { rows: [] }];
    await expect(svc.approveRefund(7, APPROVER, 'Bob', 'req-4')).rejects.toMatchObject({
      code: 'BUSINESS_RULE',
    });
    expect(audits.some((a) => a.action === 'finance_refund_self_approval_refused')).toBe(false);
  });
});

describe('the escape hatch announces itself', () => {
  it('drops the guard from the SQL when self-approval is configured on', async () => {
    process.env.REFUND_ALLOW_SELF_APPROVAL = 'true';
    responses = [{ rows: [approvedRow] }];
    await svc.approveRefund(7, REQUESTER, 'Alice', 'req-5');
    expect(queries[0].sql).not.toContain('requested_by');
  });

  it('marks every approval taken under the escape hatch', async () => {
    // An escape hatch that leaves no trace is indistinguishable from an absent
    // control. The flag appears in the audit metadata only when it was in play,
    // so a reader scanning approvals sees the exceptional ones.
    process.env.REFUND_ALLOW_SELF_APPROVAL = 'true';
    responses = [{ rows: [approvedRow] }];
    await svc.approveRefund(7, REQUESTER, 'Alice', 'req-5');

    const approval = audits.find((a) => a.action === 'finance_refund_approved');
    expect((approval?.metadata as Record<string, unknown>)?.selfApprovalAllowedByConfig).toBe(true);
  });

  it('leaves the marker off an ordinary approval', async () => {
    responses = [{ rows: [approvedRow] }];
    await svc.approveRefund(7, APPROVER, 'Bob', 'req-6');
    const approval = audits.find((a) => a.action === 'finance_refund_approved');
    expect((approval?.metadata as Record<string, unknown>)?.selfApprovalAllowedByConfig).toBeUndefined();
  });

  it('is off unless the value is exactly true', () => {
    // Not truthiness. 'false', '0', 'no' and an empty string must all leave the
    // control ON — a config typo must fail safe.
    for (const value of ['false', '0', 'no', '', 'TRUE ', 'yes']) {
      process.env.REFUND_ALLOW_SELF_APPROVAL = value;
      expect(svc.selfApprovalAllowed()).toBe(false);
    }
    process.env.REFUND_ALLOW_SELF_APPROVAL = 'true';
    expect(svc.selfApprovalAllowed()).toBe(true);
    process.env.REFUND_ALLOW_SELF_APPROVAL = 'TRUE';
    expect(svc.selfApprovalAllowed()).toBe(true);
  });
});

describe('the permission chain cannot express this rule', () => {
  it('still forces every approver to be able to open a request', () => {
    /**
     * The premise, asserted rather than assumed. If somebody ever removes
     * `refunds.review.open` from `refunds.approve`'s requires, segregation
     * becomes expressible as a grant and the executor guard could in principle
     * be reconsidered. This is what will notice.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PERMISSION_SEEDS } = require('../src/services/adminPermissionService');
    const seed = (key: string) =>
      (PERMISSION_SEEDS as Array<{ key: string; requires?: string[] }>).find((p) => p.key === key);

    expect(seed('refunds.approve')?.requires).toContain('refunds.review.open');
    expect(seed('refunds.mark_processed')?.requires).toContain('refunds.approve');
    expect(seed('refunds.mark_failed')?.requires).toContain('refunds.approve');
  });
});

describe('an approved refund that does not go through has somewhere to go', () => {
  it('moves an approved review to failed', async () => {
    responses = [{ rows: [{ id: 7, booking_id: 41, amount: '500.00' }] }];
    await svc.markRefundFailed(7, 'gcash wallet closed', APPROVER, 'Bob', 'req-7');

    expect(queries[0].sql).toContain("status='failed'");
    expect(queries[0].sql).toContain("status='approved'");
    expect(queries[0].params).toEqual([7, 'gcash wallet closed', APPROVER]);
  });

  it('touches no payments row, because no money moved', async () => {
    /**
     * `markRefundProcessed` writes `refunded_amount` on the payment. Failure
     * must not: recording a refunded amount for a refund that failed would
     * state that money moved when it did not, and the ledger would disagree
     * with the processor.
     */
    responses = [{ rows: [{ id: 7, booking_id: 41, amount: '500.00' }] }];
    await svc.markRefundFailed(7, 'bank rejected', APPROVER, 'Bob', 'req-8');
    expect(queries.some((q) => /UPDATE\s+\S*payments/i.test(q.sql))).toBe(false);
  });

  it('reports a review that does not exist as NOT_FOUND', async () => {
    responses = [
      { rows: [] }, // the guarded UPDATE matches nothing
      { rows: [] }, // the diagnostic read finds no row at all
    ];
    await expect(svc.markRefundFailed(7, 'x', APPROVER, 'Bob', 'req-9')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('reports a review in the wrong state as CONFLICT, and says which state', async () => {
    /**
     * Missing and wrong-status are different answers. Collapsing them sends an
     * operator looking for a row that is sitting right there — and forces the
     * transport layer to pick one HTTP code for two situations.
     */
    responses = [{ rows: [] }, { rows: [{ status: 'processed' }] }];
    await expect(svc.markRefundFailed(7, 'x', APPROVER, 'Bob', 'req-9')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    responses = [{ rows: [] }, { rows: [{ status: 'processed' }] }];
    await expect(svc.markRefundFailed(7, 'x', APPROVER, 'Bob', 'req-9')).rejects.toThrow(/processed/);
  });

  it('audits the failure with its reason', async () => {
    responses = [{ rows: [{ id: 7, booking_id: 41, amount: '500.00' }] }];
    await svc.markRefundFailed(7, 'bank rejected', APPROVER, 'Bob', 'req-10');
    const entry = audits.find((a) => a.action === 'finance_refund_failed');
    expect(entry).toMatchObject({ outcome: 'failed', reason: 'bank rejected', entityId: '7' });
  });

  it('unblocks the booking, which is the reason the terminal is needed', () => {
    /**
     * `openRefundReview` refuses a second review while one is `requested` or
     * `approved`. A refund stuck in `approved` therefore blocked every retry for
     * that booking — the customer could not be refunded by anyone. `failed` is
     * outside that set, so re-opening becomes possible again.
     */
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const source = require('fs').readFileSync(
      require('path').resolve(__dirname, '../src/services/adminFinanceService.ts'),
      'utf8',
    );
    const guard = /status IN \('requested','approved'\)/;
    expect(source).toMatch(guard);
    expect(source.match(guard)?.[0]).not.toContain('failed');
  });
});
