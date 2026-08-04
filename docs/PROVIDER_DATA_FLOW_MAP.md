# Provider data flow map

**Command 4 §2 deliverable.** Where provider and customer data enters a client,
where it rests, and what removes it.

Companion: `PROVIDER_DATA_ISOLATION_AUDIT.md` ·
`PROVIDER_ACCESS_CONTROL_MATRIX.md`

## Identity, end to end

```
Firebase sign-in
   └─ ID token ──────────► verifyAuth  →  req.user = raw DecodedIdToken
                                             │
                                    req.user.uid  ← the ONLY identity
                                             │
        ┌────────────────────────────────────┼──────────────────────────┐
        ▼                                    ▼                          ▼
  role: SELECT role            requireActiveProvider:          SQL scoping:
  FROM user_credentials        SELECT account_status           WHERE worker_uid = $1
  (verifyRoles)                (fails closed)                  (every provider query)
```

**The Firebase uid is the primary key.** There is no second id and no
translation table — `user_credentials.uid` is the upsert conflict target.
`getWorkerByUid` is a profile fan-out on that same uid, not a lookup.

Role is **never** on the token: no Firebase custom claims are set anywhere, so
every role check is a database read.

## Worker app — what holds provider data

| Location | Holds | Scoped how | Cleared by |
|---|---|---|---|
| `SessionController` | identity, token | in memory | `signOut()` |
| `SessionStore` | token, refresh token, identity | `flutter_secure_storage` (Keystore / Keychain) | `SessionStore.clear()` |
| `SharedPreferences` | `hasEverLaunched`, `onboardingCompleted` | device-global, **non-sensitive by design** | never — deliberately survives sign-out |
| `JobCardsStore` | bookings, customer names, phones, addresses | `ProviderScopedCache` + `_isCurrent` guard | `purgeProviderData()` |
| `EarningsStore` | provider earnings | `ProviderScopedCache` + `_isCurrent` guard | `purgeProviderData()` |
| Flutter `imageCache` | decoded profile photo bytes | keyed by URL (per-provider) | `purgeProviderData()` |
| Profile screen state | form fields | widget-local | disposed with the route |

Two stores hold provider data and **both** are registered for purging. That is
the complete set — verified against every DI registration, not assumed.

### Sign-out

`SessionController.signOut()`:

1. `purgeProviderData()` — evicts `imageCache`, then every registered cache.
   One cache throwing does **not** strand the others.
2. clears token and identity in memory
3. `SessionStore.clear()` — deletes token, refresh token and identity from
   secure storage, plus any legacy plaintext copy
4. `notifyListeners()` → the router resolves to `signedOut` or `sessionExpired`

An expiry stays distinguishable from a deliberate sign-out, because the router
shows a different screen for each.

## Stale-response protection (§19)

Every store that writes provider data across an `await` captures the identity
**before** the call and compares it **after**:

```dart
final reqId = ++_reqCounter;
final forWorker = _session.workerIdOrNull;
...
if (!_isCurrent(reqId, forWorker)) return;   // discard
```

`clearProviderData()` bumps the counter, so a request already in flight fails
its check on arrival rather than repopulating a store that was just emptied.

The same guard now covers the **profile hydration path**, which was the one real
cross-account write found by this audit: it merges into the session identity and
persists it, so an unguarded late response contaminated the next provider's
stored session and survived a restart.

## Customer app — the provider-facing edges

| Flow | Endpoint | Authorization |
|---|---|---|
| Live tracking | `GET /api/booking/:id/provider-location` | `assertBookingAccess` |
| Who is coming | `GET /api/booking/:id/provider` | `assertBookingAccess` + audience projection |

Both are **booking-scoped, not provider-scoped**. The caller names a booking
they already own; there is no way to phrase either request about an arbitrary
provider. That re-framing is what allowed the unauthenticated
`/api/workers/location/:uid` to be deleted rather than merely guarded.

## Push (§21)

Not wired in the worker app — `firebase_messaging` is not a dependency, and
login sends `fcmToken: ''`.

The backend rules exist ahead of the client:

- `POST /api/provider/fcm-token` releases the token from any other provider
  **before** claiming it, so no window has two owners for one device.
- `DELETE /api/provider/fcm-token` releases it on sign-out, scoped to the caller
  **and** the token presented, so a provider on two phones keeps the other.

## Logging (§22)

One path: `_RedactedLogInterceptor`, two independent layers.

1. **Structural** — every string prints as `String(<length>)`, so a value cannot
   leak through a key nobody thought to list.
2. **Key-based** — `token`, `password`, `otp`, `phone`, `email`, `address`,
   `lat`/`lng`, `name`, `uid`, `customer` redact by name; `Authorization`,
   `Cookie` and `X-API-Key` redact by header.

Covered by 12 fixtures including a real job-card payload. Negative fixtures
matter equally: `status`, `bookingId` and `page` must **not** redact, because a
log where everything reads `<redacted>` gets switched off.

**No analytics identity is ever set** — `setUserId`/`setUserProperty` appear
nowhere — so §16's reset requirement has nothing to act on.

## What this map does not cover

- **Provider portal storage.** The Angular portal's cache partitioning and
  sign-out clearing were not audited; this pass covered the backend and the two
  Flutter apps.
- **Branch membership.** Branch ids exist on bookings and in the catalog, but no
  provider-to-branch membership model was traced, so no flow is drawn for it.
- **Real-time channels.** Socket.IO exists in the backend; the worker app does
  not connect to it, so there is no stream teardown to document yet.
