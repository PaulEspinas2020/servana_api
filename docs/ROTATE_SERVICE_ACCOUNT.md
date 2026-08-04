# Rotating the Firebase Admin service account key

`servana-serviceAccountKey.json` is a **live Admin SDK credential** for project
`servana-59bee`. Anyone holding it can:

- read and write all Firestore and Storage data, **bypassing every Security Rule**
- **mint auth tokens for any UID** — impersonate any customer, provider or admin
- send FCM to any device
- do whatever else its IAM role permits in GCP

It was committed to `Upupapp/servana_api` in `7468e4b` ("first commit") and
`4d30ebc` ("update service account key"), and remained tracked despite being
listed in `.gitignore` — `.gitignore` does not untrack a file git already knows
about. It is now untracked, but **untracking does not un-leak it**: anyone who
has cloned, forked, or holds a CI cache still has a copy, and so does GitHub's
object store until history is rewritten.

**Rotation is the only thing that revokes it.** Deleting the old key in the
console kills every copy of it, wherever it lives.

---

## Before you start

The rotation is zero-downtime because nothing in production reads the committed
file:

| Where | How the key is supplied |
| --- | --- |
| Production | `deploy.yml:25` copies it from `/home/github-runner/env/servana-serviceAccountKey.json` on the runner, overwriting whatever is in the checkout |
| Anywhere | `FIREBASE_SERVICE_ACCOUNT_JSON` env var, preferred over the file (`firebaseApp.ts`) |
| Local dev | the file in the repo root, provisioned by hand |

Both old and new keys are valid simultaneously, so you deploy the new one and
verify *before* revoking the old.

---

## Sequence

Do these in order. The old key stays live until step 5 — that is deliberate.

### 1. Generate the new key

Firebase console → ⚙ Project settings → **Service accounts** →
**Generate new private key**. A JSON file downloads. Do not put it in the repo.

### 2. Install it on the server

```bash
ssh root@192.46.224.126 "cp /home/github-runner/env/servana-serviceAccountKey.json \
  /home/github-runner/env/servana-serviceAccountKey.json.bak-$(date +%F)"

# copy the new key up, then:
ssh root@192.46.224.126 "chmod 600 /home/github-runner/env/servana-serviceAccountKey.json && \
  chown github-runner:github-runner /home/github-runner/env/servana-serviceAccountKey.json"
```

Keep the backup until step 6 — it is the rollback.

### 3. Deploy

Trigger the workflow, or restart in place:

```bash
ssh root@192.46.224.126 "pm2 restart servana-prod && pm2 logs servana-prod --lines 40"
```

### 4. Verify the new key actually works

Do not skip this. A malformed key fails at `admin.initializeApp`, which is
startup — so a healthy process is most of the answer, but exercise a path that
genuinely uses the Admin SDK:

```bash
# should return 401 with code UNAUTHENTICATED, not 500 —
# proves verifyAuth reached Firebase token verification
curl -s -o /dev/null -w '%{http_code}\n' https://api.servana.com.ph/api/provider/profile

# should return 401, not a stack trace
curl -s https://api.servana.com.ph/api/provider/profile -H 'Authorization: Bearer invalid'
```

Then confirm a real sign-in works from the customer app, since that is the path
that mints and verifies tokens end to end.

### 5. Revoke the old key

Only now. Firebase console → **Service accounts** → **Manage service account
permissions** → Keys → delete the key whose `private_key_id` matches the old
file.

**This is the step that matters.** Everything before it is preparation; this is
what makes the copy in git history worthless.

### 6. Clean up

```bash
ssh root@192.46.224.126 "shred -u /home/github-runner/env/servana-serviceAccountKey.json.bak-*"
```

---

## Rollback

Before step 5, rollback is: restore the `.bak-` file, `pm2 restart servana-prod`.
After step 5 there is no rollback — the old key is gone. That is the point, and
it is why step 4 exists.

---

## Optional: scrub history

Rotation makes the leaked copy inert, so this is hygiene rather than urgency:

```bash
git filter-repo --path servana-serviceAccountKey.json --invert-paths
```

It rewrites shared history — every collaborator must re-clone — so weigh the
coordination cost. **Do it after rotation, never instead of it.** Scrubbing
history without rotating leaves the key live in every existing clone.

---

## Not to be confused with the client config

`firebase_options.dart`, `google-services.json` and `GoogleService-Info.plist`
in the mobile apps are **not secrets** and do **not** need rotating. They ship
inside every APK and IPA; anyone can extract them. They identify the project and
authorise nothing — access is enforced by Security Rules and by API-key
restrictions (package name + SHA-1 on Android, bundle ID on iOS).

Keeping them out of the repo is still worthwhile so per-environment config is
not baked into a branch, but that is tidiness. This document is about the one
credential where it is not.
