/**
 * Staged customer disclosure on provider job cards.
 *
 * Command 17 §11. `formatJobCard` used to return the customer's full name,
 * phone number and complete street address unconditionally, for every status
 * the job-cards query returns — and that query includes both `ASSIGNED` and
 * `DECLINED`.
 *
 * So a provider held the customer's home address and phone before accepting,
 * and kept them after declining. Neither is a cross-provider leak, which is
 * exactly why the isolation suites never caught it: it is each provider's own
 * feed, over-disclosing.
 *
 * These assertions are the control. The response SHAPE must not change — keys
 * are emptied, never removed — because the provider web portal consumes the
 * same endpoint.
 */
import { formatJobCard } from "../src/controllers/jobCardView";

const row = (workerStatus: string) => ({
  booking_id: 101,
  worker_uid: "provider-1",
  status: "CONFIRMED",
  schedule: "2026-08-10T09:00:00.000Z",
  payment_method: "CASH",
  payment_status: "PENDING",
  customer_id: "cust-1",
  first_name: "Maria",
  last_name: "Santos",
  phone_number: "+639171234567",
  address_one: "45 Ayala Avenue",
  address_two: "Unit 5",
  post_town: "Makati",
  zip_code: "1226",
  country: "PH",
  label: "Home",
  delivery_instructions: "Use the side entrance",
  // A real production location id, so the coordinate path is exercised rather
  // than skipped by a null.
  location_id: "loc_14.562312_121.019540",
  service_name: "Deep Clean",
  service_type: "standard",
  pricing_breakdown: {},
  worker_status: workerStatus,
  assigned_at: "2026-08-06T00:00:00.000Z",
  started_at: null,
  completed_at: null,
});

const TOP_KEYS = [
  "bookingId", "status", "scheduleAt", "customer", "address", "service",
  "addOns", "workerStatus", "assignedAt", "startedAt", "completedAt",
  "paymentMethod", "paymentStatus",
];
const CUSTOMER_KEYS = ["uid", "name", "phone"];
const ADDRESS_KEYS = [
  "addressOne", "addressTwo", "city", "zipCode", "country", "label", "instructions",
  // Added 2026-08-11 (SW-05). Present on every branch and NULL wherever the
  // street is null, because a precise pin IS the street address. This list is
  // exact on purpose — the comment below says a field appearing here is a
  // disclosure decision — so adding these two had to be a deliberate edit here,
  // which is exactly what the guard is for.
  "lat", "lng",
];

const ALL_STATUSES = [
  "ASSIGNED", "ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED",
  "DECLINED", "CANCELED", "CANCELLED",
];

describe("no key is ever removed, whatever the status", () => {
  // The provider web portal consumes this same endpoint. Emptying a value is
  // safe and ADDING a field is safe — consumers ignore what they do not read.
  // REMOVING one is the breaking change, so that is what this pins.
  it.each(ALL_STATUSES)("%s still carries every stable key", (status) => {
    const out: any = formatJobCard(row(status));
    for (const k of TOP_KEYS) expect(out).toHaveProperty(k);
    // customer and address are exact: a field appearing there is a disclosure
    // decision, not a convenience, and must be made deliberately.
    expect(Object.keys(out.customer).sort()).toEqual([...CUSTOMER_KEYS].sort());
    expect(Object.keys(out.address).sort()).toEqual([...ADDRESS_KEYS].sort());
  });

  it.each(ALL_STATUSES)("%s carries server-decided actions (C18 §5)", (status) => {
    const out: any = formatJobCard(row(status));
    expect(Array.isArray(out.availableActions)).toBe(true);
    expect(out.availableActions.length).toBeGreaterThan(0);
  });
});

describe("before acceptance, the provider gets an area — not an identity", () => {
  const out: any = formatJobCard(row("ASSIGNED"));

  it("withholds the phone number", () => {
    expect(out.customer.phone).toBeNull();
  });

  it("withholds the street address", () => {
    expect(out.address.addressOne).toBeNull();
    expect(out.address.addressTwo).toBeNull();
    expect(out.address.zipCode).toBeNull();
    expect(out.address.instructions).toBeNull();
  });

  it("still gives enough to make a travel decision", () => {
    expect(out.address.city).toBe("Makati");
    expect(out.address.country).toBe("PH");
  });

  it("withholds the coordinates, which ARE the street address", () => {
    // SW-05. The row HAS a valid location id; the gate is disclosure, not
    // availability. Sending a pin here would hand over precisely what
    // addressOne above deliberately withholds — a map pin on a house is not a
    // weaker form of an address, it is the same fact.
    expect(out.address.lat).toBeNull();
    expect(out.address.lng).toBeNull();
    expect(JSON.stringify(out)).not.toContain("14.562312");
    expect(JSON.stringify(out)).not.toContain("121.01954");
  });

  it("masks the surname rather than dropping the name entirely", () => {
    // "Maria S." — enough to recognise the job, not to identify the person.
    expect(out.customer.name).toBe("Maria S.");
    expect(out.customer.name).not.toContain("Santos");
  });

  it("leaks the full name nowhere in the payload", () => {
    expect(JSON.stringify(out)).not.toContain("Santos");
    expect(JSON.stringify(out)).not.toContain("+639171234567");
    expect(JSON.stringify(out)).not.toContain("45 Ayala Avenue");
  });
});

describe("a provider who declined retains nothing", () => {
  it.each(["DECLINED", "CANCELED", "CANCELLED"])("%s discloses nothing", (s) => {
    const out: any = formatJobCard(row(s));
    expect(out.customer.uid).toBeNull();
    expect(out.customer.name).toBe("");
    expect(out.customer.phone).toBeNull();
    expect(out.address.city).toBeNull();
    expect(out.address.addressOne).toBeNull();
    expect(out.address.lat).toBeNull();
    expect(out.address.lng).toBeNull();
    const json = JSON.stringify(out);
    expect(json).not.toContain("Maria");
    expect(json).not.toContain("Santos");
    expect(json).not.toContain("Makati");
    expect(json).not.toContain("+639171234567");
    expect(json).not.toContain("14.562312");
  });
});

describe("the operational window keeps full detail", () => {
  // A provider who accepted must be able to travel there and call ahead.
  // Narrowing this would break the job, not protect the customer.
  it.each(["ACCEPTED", "EN_ROUTE", "ARRIVED", "IN_PROGRESS", "COMPLETED"])("%s is unchanged", (s) => {
    const out: any = formatJobCard(row(s));
    expect(out.customer.name).toBe("Maria Santos");
    expect(out.customer.phone).toBe("+639171234567");
    expect(out.customer.uid).toBe("cust-1");
    expect(out.address.addressOne).toBe("45 Ayala Avenue");
    expect(out.address.addressTwo).toBe("Unit 5");
    expect(out.address.city).toBe("Makati");
    expect(out.address.zipCode).toBe("1226");
    expect(out.address.instructions).toBe("Use the side entrance");
    // SW-05 — the pin travels with the street, parsed from the canonical
    // loc_{lat}_{lng} rather than re-derived on the device.
    expect(out.address.lat).toBe(14.562312);
    expect(out.address.lng).toBe(121.01954);
  });

  it("sends no pin when the address row has no usable location id", () => {
    // SW-13. One production row holds a Google place id here. A provider gets
    // the address text and no map, which is honest; guessing would put them at
    // the wrong door.
    const out: any = formatJobCard({
      ...row("ACCEPTED"),
      location_id: "ChIJ8T1GpMGzljMRq2q5T1u7I0w",
    });
    expect(out.address.addressOne).toBe("45 Ayala Avenue");
    expect(out.address.lat).toBeNull();
    expect(out.address.lng).toBeNull();
  });

  it("falls back to service_address coordinates for admin-created bookings", () => {
    // Those have no user_address row at all, so location_id is absent.
    const out: any = formatJobCard({
      ...row("ACCEPTED"),
      location_id: null,
      service_address_lat: "14.5995",
      service_address_lon: "120.9842",
    });
    expect(out.address.lat).toBe(14.5995);
    expect(out.address.lng).toBe(120.9842);
  });
});

describe("unknown statuses fail closed", () => {
  it("an unrecognised worker status does not get full disclosure", () => {
    // A status added server-side later must not silently open the payload.
    const out: any = formatJobCard(row("SOME_NEW_STATE"));
    expect(out.customer.phone).toBeNull();
    expect(out.address.addressOne).toBeNull();
    expect(JSON.stringify(out)).not.toContain("Santos");
  });

  it("a missing worker status fails closed too", () => {
    const r: any = row("ASSIGNED");
    delete r.worker_status;
    const out: any = formatJobCard(r);
    expect(out.customer.phone).toBeNull();
    expect(out.address.addressOne).toBeNull();
  });

  it("lowercase from the database is still recognised", () => {
    const out: any = formatJobCard(row("accepted"));
    expect(out.customer.phone).toBe("+639171234567");
  });
});

describe("name masking edge cases", () => {
  it("handles a missing surname", () => {
    const r: any = { ...row("ASSIGNED"), last_name: null };
    expect(formatJobCard(r).customer.name).toBe("Maria");
  });

  it("handles a missing first name", () => {
    const r: any = { ...row("ASSIGNED"), first_name: null };
    expect(formatJobCard(r).customer.name).toBe("S.");
  });

  it("returns empty rather than 'null null' when both are absent", () => {
    const r: any = { ...row("ASSIGNED"), first_name: null, last_name: null };
    expect(formatJobCard(r).customer.name).toBe("");
  });
});

describe("the arrival stages keep the address (C18)", () => {
  // EN_ROUTE and ARRIVED sit between ACCEPTED and IN_PROGRESS. The first cut of
  // this staging listed only ACCEPTED and IN_PROGRESS as operational, which
  // would have masked the address for a provider actively travelling to it.
  it.each(["EN_ROUTE", "ARRIVED"])("%s still gets the street address", (s) => {
    const out: any = formatJobCard(row(s));
    expect(out.address.addressOne).toBe("45 Ayala Avenue");
    expect(out.customer.phone).toBe("+639171234567");
    expect(out.customer.name).toBe("Maria Santos");
  });
});
