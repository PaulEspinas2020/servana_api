import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { rateLimitBody } from "../helpers/rateLimitBody";
import verifyAuth from "../middleware/verifyAuth";
import * as ctrl from "../controllers/accountDeletionController";

// No schema bootstrap here, and none in startup either (TAB 02). This module
// used to issue DDL at import — the worst place for it, since it ran whenever
// the router was loaded. `account_deletion_requests` now comes from the
// baseline; see the schema note in services/accountDeletionService.

/**
 * Tighter than the sign-in limiter. The public form is unauthenticated and
 * takes an arbitrary identifier, so it is a natural target for someone probing
 * a list of numbers. The flat response already denies them an answer; this
 * denies them volume.
 */
const deletionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitBody("Too many deletion requests. Please try again in an hour."),
});

const router = Router();

router.post("/account/deletion-request", deletionLimiter, ctrl.requestDeletionPublic);
router.post("/account/deletion-request/me", verifyAuth, ctrl.requestDeletionForSelf);

export default router;

/**
 * The public page Google Play links to from the store listing.
 *
 * Served from the API rather than a separate host on purpose: Play requires the
 * URL to be reachable without signing in and to stay reachable, and this is the
 * only Servana origin already deployed, TLS-terminated and monitored. A page on
 * a marketing site that nobody redeploys is the one that 404s six months later.
 *
 * Self-contained — no external CSS, fonts or scripts — so it renders identically
 * for a reviewer on a throttled connection, and it degrades to a mailto if the
 * fetch fails or JavaScript is off.
 */
export const accountDeletionPageRouter = Router();

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delete your Servana account</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:2rem 1rem; font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         background:#fff; color:#1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background:#111; color:#eee; } }
  main { max-width:38rem; margin:0 auto; }
  h1 { font-size:1.5rem; margin:0 0 .5rem; }
  h2 { font-size:1.05rem; margin:2rem 0 .5rem; }
  ul { padding-left:1.2rem; }
  label { display:block; font-weight:600; margin:1.5rem 0 .4rem; }
  input { width:100%; box-sizing:border-box; padding:.7rem .8rem; font-size:1rem;
          border:1px solid #999; border-radius:.4rem; background:transparent; color:inherit; }
  button { margin-top:1rem; padding:.75rem 1.4rem; font-size:1rem; font-weight:600;
           border:0; border-radius:.4rem; background:#0b63ce; color:#fff; cursor:pointer; }
  button:disabled { opacity:.6; cursor:default; }
  #msg { margin-top:1rem; padding:.85rem 1rem; border-radius:.4rem; background:#eef4fd; color:#0b3a75; }
  @media (prefers-color-scheme: dark) { #msg { background:#12283f; color:#cfe3ff; } }
  #msg[hidden] { display:none; }
  footer { margin-top:2.5rem; font-size:.9rem; opacity:.8; }
</style>
</head>
<body>
<main>
  <h1>Delete your Servana account</h1>
  <p>Use this form to request deletion of your Servana account and the personal
     data associated with it. You can also do this from the app under
     <strong>Settings &rarr; Privacy &amp; Legal</strong>.</p>

  <h2>What is deleted</h2>
  <ul>
    <li>Your name, email address, mobile number and profile photo</li>
    <li>Your saved addresses and location history</li>
    <li>Your account credentials and sign-in identifiers</li>
    <li>Push notification tokens and device identifiers</li>
  </ul>

  <h2>What is retained, and why</h2>
  <ul>
    <li><strong>Booking and payment records</strong> are kept where we are required
        to retain transaction records. They are detached from your identity.</li>
    <li>Records we are required to keep by law or to resolve a dispute are kept
        for as long as that obligation lasts.</li>
  </ul>

  <h2>How long it takes</h2>
  <p>Requests are actioned within <strong>30 days</strong>. We may contact you at
     the email address or mobile number you provide if we need to confirm that
     the request is yours.</p>

  <form id="f">
    <label for="identifier">Email address or mobile number on the account</label>
    <input id="identifier" name="identifier" type="text" autocomplete="off"
           placeholder="you@example.com or 09171234567" required>
    <button id="b" type="submit">Request deletion</button>
  </form>
  <p id="msg" hidden></p>

  <footer>
    Prefer email? Write to
    <a href="mailto:privacy@servana.com.ph?subject=Account%20deletion%20request">privacy@servana.com.ph</a>
    from the address on your account.
  </footer>
</main>
<script>
(function () {
  var f = document.getElementById('f'), b = document.getElementById('b'), m = document.getElementById('msg');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    b.disabled = true;
    fetch('/api/account/deletion-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: document.getElementById('identifier').value })
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        m.textContent = d.message ||
          'If an account exists for that email address or mobile number, a deletion request has been recorded.';
        m.hidden = false;
        f.hidden = true;
      })
      .catch(function () {
        b.disabled = false;
        m.textContent = 'Could not reach the server. Please email privacy@servana.com.ph instead.';
        m.hidden = false;
      });
  });
})();
</script>
</body>
</html>`;

accountDeletionPageRouter.get("/account-deletion", (_req, res) => {
  res.type("html").send(PAGE_HTML);
});
