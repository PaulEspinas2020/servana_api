/**
 * Staged customer disclosure on `GET /provider/bookings/:id`.
 *
 * Sibling of `job-card-customer-disclosure.test.ts`, for the same defect
 * reintroduced on a different route.
 *
 * `formatJobCard` withholds the customer's street until the provider has
 * actually accepted the job — before that they get the AREA, which is what a
 * travel decision needs (Command 17 §11). `getProviderBookingDetail` was added
 * later as the authenticated web-portal equivalent of the unauthenticated
 * `GET /bookings/:id`, and it answered by spreading the raw database row. So an
 * ASSIGNED provider who had accepted nothing could read `address`, `zip_code`
 * and the whole `service_address` JSON by calling it directly.
 *
 * It has no UI anywhere — a sweep of all five clients found zero callers of the
 * bare detail route — but "no screen calls it" is not authorization (§12), and
 * the route is reachable by any provider with a booking assignment.
 *
 * The disclosure rule is duplicated here rather than imported because the
 * controller applies it inline; the point of these cases is that the two routes
 * agree, so they are asserted against the same expectations.
 */

/** Mirrors the staging applied in `getProviderBookingDetail`. */
const OPERATIONAL = ["ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED"];

const disclose = (row: any) => {
  const workerStatus = String(row.worker_status ?? "").toUpperCase();
  const operational = OPERATIONAL.includes(workerStatus);
  const serviceAddress =
    row.service_address && typeof row.service_address === "object"
      ? { ...row.service_address }
      : row.service_address;
  if (!operational && serviceAddress && typeof serviceAddress === "object") {
    delete serviceAddress.addressLine;
    delete serviceAddress.addressTwo;
  }
  return {
    ...row,
    address: operational ? row.address : null,
    zip_code: operational ? row.zip_code : null,
    service_address: serviceAddress,
    clientPaymentStatus: row.payment_status ? String(row.payment_status).toLowerCase() : "pending",
  };
};

const row = (workerStatus: string) => ({
  id: 101,
  user_id: "cust-1",
  worker_status: workerStatus,
  payment_status: "PAID",
  address: "45 Ayala Avenue",
  post_town: "Makati City",
  zip_code: "1226",
  country: "PH",
  service_address: { addressLine: "45 Ayala Avenue", addressTwo: "Unit 12B", city: "Makati City" },
});

describe("provider booking detail — before acceptance", () => {
  it("withholds the street address at ASSIGNED", () => {
    expect(disclose(row("ASSIGNED")).address).toBeNull();
  });

  it("withholds the zip code at ASSIGNED", () => {
    expect(disclose(row("ASSIGNED")).zip_code).toBeNull();
  });

  it("strips the street out of the service_address JSON too", () => {
    // Emptying the flattened column alone would have leaked it straight back:
    // the same street is carried inside the JSON blob under its own key.
    const out = disclose(row("ASSIGNED")).service_address;
    expect(out.addressLine).toBeUndefined();
    expect(out.addressTwo).toBeUndefined();
  });

  it("still gives the AREA, which is what a travel decision needs", () => {
    expect(disclose(row("ASSIGNED")).post_town).toBe("Makati City");
    expect(disclose(row("ASSIGNED")).service_address.city).toBe("Makati City");
  });

  it("does not mutate the caller's row object", () => {
    // The JSON blob comes off a shared query result; deleting keys in place
    // would corrupt any other consumer of the same row.
    const original = row("ASSIGNED");
    disclose(original);
    expect(original.service_address.addressLine).toBe("45 Ayala Avenue");
  });

  it("keeps every key present, only emptied", () => {
    // Shape is a contract even with no callers today (§4).
    const out = disclose(row("ASSIGNED"));
    expect(Object.prototype.hasOwnProperty.call(out, "address")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, "zip_code")).toBe(true);
  });
});

describe("provider booking detail — once operational", () => {
  it.each(OPERATIONAL)("discloses the street at %s", (status) => {
    const out = disclose(row(status));
    expect(out.address).toBe("45 Ayala Avenue");
    expect(out.zip_code).toBe("1226");
    expect(out.service_address.addressLine).toBe("45 Ayala Avenue");
  });
});

describe("payment status casing", () => {
  it("adds a lower-cased clientPaymentStatus", () => {
    // Provider Web's `mapClientPaymentStatus` is case-sensitive, and the three
    // job-list endpoints all emit this field lower-cased. This route emitted
    // only raw UPPERCASE `payment_status`, which that mapper renders "unknown".
    expect(disclose(row("ACCEPTED")).clientPaymentStatus).toBe("paid");
  });

  it("keeps the raw key for backward compatibility (§4)", () => {
    expect(disclose(row("ACCEPTED")).payment_status).toBe("PAID");
  });

  it("defaults to pending when there is no payment row", () => {
    expect(disclose({ ...row("ACCEPTED"), payment_status: null }).clientPaymentStatus).toBe("pending");
  });
});
