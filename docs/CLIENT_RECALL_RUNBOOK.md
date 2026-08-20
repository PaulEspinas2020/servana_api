# Client recall runbook

**How to stop a bad mobile build being used, and how long it takes.**

Read this before raising a minimum. Raising it blocks **every installed build below
it**, and there is no way to unblock a worker except a store release — which takes
days. This is the one lever on this platform whose blast radius is larger going
forward than going back.

## What the lever is

`GET /api/v1/client-config` — unauthenticated, cacheable, served from a JSON file.

```json
{
  "data": {
    "platforms": {
      "ios":     { "minimumSupported": "1.0.0", "latestAvailable": "1.0.0", "message": "..." },
      "android": { "minimumSupported": "1.0.0", "latestAvailable": "1.0.0", "message": "..." }
    },
    "source": "config"
  }
}
```

The client compares its own version against `minimumSupported` and refuses to run when
it is below. `latestAvailable` never blocks — it drives a soft prompt. `message` is
shown verbatim, so the wording of a block is ours.

## Raising the minimum

1. **Decide the floor.** It is the lowest version you are willing to keep serving, not
   the version of the fix. A worker on the floor keeps working.
2. **Edit the file** named by `CLIENT_CONFIG_PATH` (or `config/client-config.json` if
   unset), on the host:
   ```
   minimumSupported: "1.4.0"
   message: "This version of Servana Worker is no longer supported. Please update from
             the App Store to keep receiving jobs."
   ```
3. **Confirm it parses,** before it can be served:
   `python3 -m json.tool "$CLIENT_CONFIG_PATH" > /dev/null && echo ok`
4. **Confirm it took effect** — poll until it flips:
   ```
   curl -s https://api.servana.com.ph/api/v1/client-config | jq '.data.platforms, .data.source'
   ```
   `source` must read `config`. If it reads `default`, **the file was not usable and no
   recall is in force** — see below.

No restart. No deploy. No migration. No database.

## How long it takes — the measured number

| Stage | Duration |
|---|---|
| In-process cache TTL | **60s** (`CONFIG_TTL_SECONDS`) |
| `Cache-Control: public, max-age=60` downstream | up to **60s** |
| **Worst case, edit → a device that already asked** | **~2 minutes** |
| A device asking for the first time | immediate |

Measured, not estimated. Demonstrated against compiled `dist/` in a single process:
a worker on `1.0.0` was supported at T+0, the file was edited with no restart, and the
same PID served the new floor at T+61s. Transcript in the TAB 02 commit message.

## `source: "default"` — what it means and why it exists

`default` means the config file was **absent, unreadable or malformed**, and the server
is serving a permissive `0.0.0` floor that blocks nobody.

**If you are mid-recall and see `default`, the recall is not being applied.** Fix the
file. The most likely cause is a JSON syntax error in the emergency edit — which is why
step 3 above exists.

This is deliberate, and the reasoning is worth understanding before anyone "fixes" it:

- The **client fails closed** — an unreadable answer blocks the app, because a build too
  old to parse the response is the one most likely being recalled.
- The **server therefore fails open.** If both halves failed closed, deleting or
  fat-fingering one file on the host would brick every installed worker app at once,
  with no recovery path — the apps that need the fix are the ones refusing to run.

Losing the config degrades to *recall nobody*, never to *recall everybody*. The cost is
that a lost file silently lifts a recall, and `source` is how you see that from outside.

If `CLIENT_CONFIG_PATH` is set, **that file is authoritative** — a malformed one does not
fall through to whatever config the release happened to ship. A silent fall-through would
either lift a recall or impose an unintended one, with no way to tell which from outside.

## What this lever cannot do

- **It cannot fix anything.** It stops a build being used; the fix still ships through the
  store, on the store's timetable.
- **It cannot reach a device that never asks.** A client offline since before the recall
  learns about it when it next has a network.
- **It cannot be undone for a worker who has already been blocked**, except by lowering the
  minimum again — which they will pick up within ~2 minutes. Lowering is as fast as raising.
- **It is not a feature-flag service,** and must not become one. This endpoint is
  unauthenticated: every key added here is published to the world and becomes a second
  source of truth for behaviour. `tests/v1-client-config.test.ts` fails when an undeclared
  key appears.

## Before you pull it

Raising the minimum takes work away from every provider running an older build. It is the
right call for a build that is losing jobs or corrupting data, and the wrong call for a
cosmetic bug. If you are not sure, ship the fix and raise `latestAvailable` — the soft
prompt — and leave the floor alone.
