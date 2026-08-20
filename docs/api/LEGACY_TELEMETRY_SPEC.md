<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-convergence-docs.ts, derived from
    src/api/v1/convergence.ts      (the federated capability registry)
    src/api/v1/contract.ts         (the canonical endpoints and their callers)
    src/api/v1/legacyTelemetry.ts  (retirement criteria)
    src/api/v1/legacyTelemetry.ts
  Regenerate: npm run convergence:docs
-->

# Legacy telemetry specification

> The measurement that turns "temporarily" into a date somebody can defend.

## 1. What is counted

`legacyContractTelemetry` derives its watch list FROM `V1_CONTRACT[].legacy`,
so a route can only be DOCUMENTED as superseded if it is also being COUNTED.
There is no second list to keep in step: add a legacy mapping to the contract
and it starts reporting on the next boot.

**104 distinct legacy routes** are on the watch list today.

Per route, per one-hour window:

| Field | Meaning |
| --- | --- |
| `hits` | Requests matched to this legacy path |
| `bearer` | How many carried an Authorization header |
| `clients` | Counts per coarse client label |

## 2. What is deliberately NOT counted

No uid. No path parameter value. No query string. No body. No raw User-Agent.

A telemetry log that names who called is a log that has to be protected like the
data it describes, and this one exists to answer a single question — is anyone
still calling this? — which needs none of that.

The client label is the explicit `X-Servana-Client` header when a client sends
one, optionally with `X-Servana-Client-Version`. Otherwise it degrades to a
User-Agent FAMILY (`ua:dart`, `ua:browser`, `ua:tool`, `ua:other`) and never
the User-Agent itself, which on mobile carries the device model and OS build.

## 3. Where it goes

One `console.info` line per route per window:

```
[legacy-contract] GET /api/services/full hits=412 bearer=impl window=60m clients=[customer-mobile@1.4.2=380 ua:dart=32]
```

A log line rather than a metrics endpoint, deliberately. The API runs under PM2
on a single box, so `pm2 logs servana-prod | grep legacy-contract` is a tool
the team already has. A `/admin/telemetry` route would need a contract entry, a
permission and a portal screen before it told anybody anything.

`snapshot()` returns the current window as an object for tests and for ops.

## 4. Reading it for a retirement decision

1. `grep legacy-contract` for the route over the window its callers require
   (14 days web, 90 days if any mobile client is listed).
2. Zero hits across every window, **and** every caller cell reads `migrated`,
   **and** the canonical successor is mounted.
3. Delete the alias as its own change.

A non-zero count from `ua:dart` with no version header is the case that most
often stops a retirement: it is a Flutter build old enough to predate the header
being sent, which is exactly the installed base the window exists to protect.

## 5. What this cannot tell you

It counts requests that ARRIVE. A client that has migrated but still ships the
old call behind a feature flag registers zero and is not migrated. That is why
condition 2 of the retirement gate is the caller matrix and not the traffic
count — the two answer different questions, and only the pair is sufficient.

## 6. Never blocks

Every path through the middleware is wrapped. A bug in telemetry is a missing
log line, not an outage on five live clients.
