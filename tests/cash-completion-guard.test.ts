/**
 * A cash job cannot be completed until the cash is recorded as received.
 *
 * The rule has not changed. Where it is enforced has: B2 moved it out of
 * `completeJob`'s UPDATE and into the canonical guard
 * `cashPaymentSettledBeforeCompletion`, which the executor runs inside the
 * transaction before any write.
 *
 * These assertions follow the property rather than the location. Pointing them
 * at the old SQL would fail a migration that kept the rule intact; deleting
 * them would drop a money-path guarantee. The behavioural coverage lives in
 * `booking-b2-complete.test.ts`; this file pins the SHAPE — that the rule is a
 * precondition, not a post-transition check.
 */

import fs from "fs";
import path from "path";

const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

/** Comments stripped — a docblock describing the rule is not the rule. */
const codeOf = (rel: string): string =>
  read(rel)
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

const service = read("src/services/technicianService.ts");
const executor = codeOf("src/services/booking/transitionExecutor.ts");

describe("cash completion guard", () => {
  it("makes payment eligibility a PRECONDITION of the transition", () => {
    // The predicate itself, unchanged, now in the guard.
    const guard = executor.slice(
      executor.indexOf("cashPaymentSettledBeforeCompletion"),
      executor.indexOf("export const BOOKING_ACTIONS"),
    );
    expect(guard).toMatch(/FROM \$\{s\}\.payments p/);
    expect(guard).toContain("<> 'CASH'");
    expect(guard).toContain("= 'PAID'");
  });

  it("the completion action names the guard", () => {
    expect(executor).toMatch(
      /PROVIDER_COMPLETE:\s*\{[\s\S]{0,200}guard: 'cashPaymentSettledBeforeCompletion'/,
    );
  });

  it("the guard runs BEFORE any write, not after the commit", () => {
    // This is the ordering the whole rule depends on. A check after the commit
    // would answer UnpaidCashBookingError for a booking already COMPLETED.
    const guardCall = executor.indexOf("await BOOKING_GUARDS[guardName]");
    const applyCall = executor.indexOf("await applyState(client, loaded, toState, input)");
    // lastIndexOf: the event-only branch commits earlier in the FILE, and
    // indexOf would find that one. This assertion is about the transition
    // path's ordering, whose COMMIT is the last.
    const commit = executor.lastIndexOf("client.query('COMMIT')");

    expect(guardCall).toBeGreaterThan(-1);
    expect(guardCall).toBeLessThan(applyCall);
    expect(applyCall).toBeLessThan(commit);
  });

  it("it reads on the caller's connection, so the executor's is the locked one", () => {
    expect(executor).toContain("query: (sql, params) => client.query(sql, params as any[])");
  });

  it("the old copy is gone from the service, not merely bypassed", () => {
    const complete = codeOf("src/services/technicianService.ts")
      .slice(codeOf("src/services/technicianService.ts").indexOf("export const completeJob"));
    expect(complete).not.toMatch(/UPDATE \$\{dbSchema\}\.booking_workers bw/);
    expect(complete).not.toMatch(/EXISTS \([\s\S]{0,300}payments p/);
  });

  it("uses a stable error code for unpaid cash", () => {
    expect(service).toContain('readonly code = "CASH_PAYMENT_REQUIRED"');
    expect(service).toContain("throw new UnpaidCashBookingError()");
  });

  it("the executor's reason code is what selects that error", () => {
    // The one refusal callers branch on. Everything else flattens to the
    // generic message, exactly as before.
    expect(service).toContain("'BOOKING_CASH_PAYMENT_REQUIRED'");
    expect(executor).toContain("'BOOKING_CASH_PAYMENT_REQUIRED'");
  });
});
