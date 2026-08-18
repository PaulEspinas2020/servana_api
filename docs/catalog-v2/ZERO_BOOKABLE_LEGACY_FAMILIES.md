# ZERO_BOOKABLE_LEGACY_FAMILIES

Six legacy families hold provider links but contain **no bookable Specific Service**.
Recorded per §2. **Not altered in Deploy 1** — this is cleanup debt, not a blocker,
and it produces no incorrect runtime behaviour (an approval against an empty family
simply grants nothing).

| Family id | Name | Category | Provider links | Why it grants no canonical capability |
|---:|---|---|---:|---|
| 54 | Nails | Personal Care | 6 | No `service_options` MAIN rows, so the Phase-2 fan-out produced 0 canonical capabilities |
| 53 | Hair | Personal Care | 6 | same |
| 69 | Plumbing | Home Maintenance | 2 | same |
| 66 | Aesthetics & Beauty | Beauty & Wellness | 1 | same |
| 68 | Barbering | Beauty & Wellness | 1 | same |
| 70 | Carpentry | Home Maintenance | 1 | same |

**17 links across 8 distinct providers.**

Note `Nails` and `Hair` carry the **same six providers**, and `C37TCZ9Q2CZnkSY1GT7DzwBypKc2`
appears in five of the six families — a provider who applied broadly across families
that were never populated with services.

The names are legitimate service areas (unlike the 9 junk families already removed),
so the right resolution is almost certainly to **create the missing Specific Services
under them**, not to delete the approvals. Deleting the links would silently remove
provider intent.

**Recommended later action:** decide per family whether to populate it with Specific
Services (then re-run the capability fan-out, which is additive and idempotent) or to
retire the family and notify the affected providers. Do not auto-resolve.
