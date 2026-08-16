<!--
  GENERATED FILE - do not edit by hand.
  Source: scripts/generate-account-docs.ts, derived from
    src/services/account/accountPolicy.ts        (the settings catalog and security surface)
    src/services/events/domainEvents.ts          (notification categories, pointed at)
    src/api/v1/contract.ts                       (the canonical endpoints)
  Regenerate: npm run account:docs
-->

# Settings v1 Contract

> One settings store for every account and every client. No separate web and
> mobile stores, and notification preferences are a POINTER to the TAB 09 model
> rather than a second copy of it.

## 1. The settings catalog

One store, one catalog, every account and every client.

There was no server-side settings store before this. Locale and privacy choices were
held per-client, so Customer Web and Customer Mobile each remembered a different
language for the same person and neither could tell the backend.

| Setting | Group | Label | Default | Writable | Note |
| --- | --- | --- | --- | --- | --- |
| `locale` | `locale` | Language | `en-PH` | yes | BCP-47. Drives server-rendered copy; clients may still override locally. |
| `timeZone` | `locale` | Time zone | `Asia/Manila` | yes | IANA. Servana operates in Asia/Manila and a booking at 08:00 local is 00:00 UTC, so getting this wrong moves a job across a day boundary. |
| `profileDiscoverable` | `privacy` | Discoverable profile | `true` | yes | Whether the public provider projection may be surfaced in search. |
| `shareUsageAnalytics` | `privacy` | Share usage analytics | `false` | yes | OFF by default. Privacy by default means the permissive value is the chosen one. |
| `twoFactorEnabled` | `security` | Two-factor authentication | `false` | — | READ-ONLY here. Enabling it is a credential ceremony with proof of possession; a settings PATCH that could flip it would be a way to turn it OFF from a stolen session. |

Writable at `PATCH /api/v1/me/settings`: `locale`, `timeZone`, `profileDiscoverable`, `shareUsageAnalytics`.

Every declared setting is ALWAYS present in the response, filled from the account's row
or the catalog default. A client never has to decide what a missing key means, which is
the decision that produces two different answers in two clients.

PATCH rather than PUT: a full replace means a client that knows about four settings
silently resets the one it has never heard of every time the backend adds another. An
unknown key is REFUSED rather than ignored, so two clients cannot come to disagree
about what a person chose.

The GET returns settings GROUPED and the PATCH accepts either the grouped or the flat
shape, so a client can round-trip what it read without reshaping it.

## 2. Notification preferences are a POINTER

The nine notification categories are declared in
`services/events/domainEvents.NOTIFICATION_CATEGORIES` and served by
`GET/PATCH /api/v1/me/notification-preferences`.

`/api/v1/me/settings` returns the endpoint AND the current values for
convenience, and owns neither. Restating the categories here would be a second
preference model — which is precisely what TAB 09 existed to prevent, and it very
nearly had one: the preference table is keyed on a uid and has no role column, yet
both legacy routes onto it were gated on a provider role, so customers received
notifications they had no way to configure.

## 3. Security

`GET /api/v1/me/security` reports POSTURE:

- `emailVerified`
- `phoneVerified`
- `twoFactorEnabled`
- `passwordUpdatedAt`
- `activeDeviceCount`

### It is READ-ONLY, deliberately

Every security ACTION already has a dedicated endpoint with its own proof of
possession. Folding them into a settings PATCH would put credential changes behind a
JSON body — including the ability to turn two-factor **off** from a session that
should not be able to.

The response names where each action lives, so a client does not hardcode it:

| Action | Endpoint |
| --- | --- |
| `changePassword` | POST /api/v1/auth/reset-password (or the provider password flow) |
| `revokeSessions` | POST /api/v1/auth/logout |
| `releaseDevice` | DELETE /api/v1/me/devices |
| `changeEmail` | the identifier re-verification workflow |
| `changeMobile` | the identifier re-verification workflow |

`twoFactorEnabled` appears in the settings catalog as `writableBySelf: false` for the
same reason. It is readable there and changeable only through the credential ceremony.
