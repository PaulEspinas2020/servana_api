/**
 * The API's security headers (TAB 05, F-06).
 *
 * ## The gap
 *
 * `helmet` was not a dependency. Live responses carried no HSTS, no `nosniff`
 * and no `Referrer-Policy`; the only header control in the application was
 * `app.disable('x-powered-by')`.
 *
 * ## Every option is set explicitly, and that is the point
 *
 * `helmet()` with no arguments was measured against this Express version before
 * anything was written, and its defaults include two that would break this
 * platform:
 *
 *   cross-origin-resource-policy: same-origin
 *   content-security-policy: default-src 'self'; …
 *
 * The first is the §4 break. Provider documents and catalog banners are fetched
 * from other origins — five consumer applications, two of them installed mobile
 * builds that cannot be re-released to work around a header. `same-origin`
 * would refuse those fetches, and it would do it in the browser, which reports
 * it as a network failure rather than as a policy decision. So it is set to
 * `cross-origin` deliberately rather than inherited.
 *
 * Beyond that, relying on ANY default here is a bet that the next helmet major
 * will not change it. Setting each one explicitly costs a few lines and turns
 * a future silent behaviour change into a visible diff.
 *
 * ## CSP: off for JSON, on for the one page that is HTML
 *
 * The received advice is `contentSecurityPolicy: false` for an API, and it is
 * nearly right here. This API serves exactly one HTML document —
 * `accountDeletionPageRouter`, the Google Play data-deletion page a reviewer
 * opens directly in a browser — so a blanket `false` would leave the only
 * framable, script-capable surface in the application with no policy at all.
 *
 * The API gets no CSP, because a CSP on a JSON body protects nothing and misleads
 * the next reader into thinking the API renders something. The page gets a
 * strict one, including `frame-ancestors 'none'`, which is the control modern
 * browsers actually honour — `X-Frame-Options` is the legacy spelling and both
 * are sent.
 */

import { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

/**
 * One year, with subdomains, and deliberately WITHOUT `preload`.
 *
 * `preload` is close to a one-way door: it asks browser vendors to hard-code
 * the domain into a shipped list, and removal takes months to propagate to
 * everyone who already has it. That is a decision for whoever owns the domain,
 * made once, knowingly — not a side effect of a security-headers commit. The
 * header is fully effective without it for every visitor after their first
 * request.
 */
const HSTS_MAX_AGE_SECONDS = 31536000;

export const apiSecurityHeaders = helmet({
  // See the docblock: this API serves JSON. The one HTML page has its own.
  contentSecurityPolicy: false,

  strictTransportSecurity: {
    maxAge: HSTS_MAX_AGE_SECONDS,
    includeSubDomains: true,
    preload: false,
  },

  // The header that stops a browser guessing a content type it was told. An
  // uploaded document served as the wrong type is how a stored file becomes
  // executable script.
  xContentTypeOptions: true,

  // An API is not a document and must never be framed.
  xFrameOptions: { action: 'deny' },

  /**
   * `strict-origin-when-cross-origin`: full URL to our own origin, origin only
   * to other HTTPS origins, nothing when downgrading to HTTP.
   *
   * `no-referrer` — helmet's default — is stricter and worse here: several
   * paths carry ids that make server-side logs and error reports useful, and
   * this policy keeps them for same-origin requests while still never leaking
   * a path to a third party. It also matches what the portal already sends, and
   * two halves of one product disagreeing about referrer policy is a debugging
   * tax nobody budgets for.
   */
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },

  /**
   * THE ONE THAT WOULD HAVE BROKEN THINGS. Measured, not assumed: helmet's
   * default is `same-origin`, which refuses cross-origin fetches of provider
   * documents and catalog banners from all five consumers.
   */
  crossOriginResourcePolicy: { policy: 'cross-origin' },

  /**
   * COOP and COEP are document-level controls about the browsing context. This
   * API returns JSON to fetch clients and one static page that opens no
   * windows, so neither buys anything — and COEP in particular would require
   * every cross-origin subresource to opt in, which is a way to break image
   * loading for no benefit. Off, explicitly.
   */
  crossOriginOpenerPolicy: false,
  crossOriginEmbedderPolicy: false,

  // Harmless, cheap, and each closes a small legacy hole.
  xDnsPrefetchControl: { allow: false },
  xDownloadOptions: true,
  xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
  originAgentCluster: true,

  /**
   * `X-XSS-Protection: 0`.
   *
   * Counter-intuitive and correct: the legacy XSS auditor it enables was itself
   * exploitable and every current browser has removed it. `0` explicitly
   * disables the remnant rather than leaving it to a default.
   */
  xXssProtection: true,

  // Already handled by `app.disable('x-powered-by')`; set here too so the
  // guarantee does not depend on which of the two somebody deletes.
  hidePoweredBy: true,
});

/**
 * The CSP for the account-deletion page, and nothing else.
 *
 * ## Why hashes and not `'unsafe-inline'`
 *
 * The page is a single self-contained document with one inline `<style>` and
 * one inline `<script>` — the script prevents the form's native submit and
 * POSTs to `/api/account/deletion-request` instead. `'unsafe-inline'` would
 * permit that script and every other one an injection could introduce, which is
 * most of what a CSP is for.
 *
 * ## Why the hashes are COMPUTED and not written down
 *
 * A pasted `sha256-…` literal is correct until somebody edits a line of the
 * script, and then the page silently stops working — for a Google Play reviewer
 * opening a data-deletion page, which is the one visitor whose experience this
 * page exists to satisfy. Deriving the hash from the very string being served
 * means the two cannot disagree. There is no version of "the CSP is stale"
 * available here.
 */

import { createHash } from 'crypto';

const sha256 = (source: string): string =>
  `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;

/** Inner text of every `<tag>…</tag>` block, which is what a CSP hash covers. */
const inlineBlocks = (html: string, tag: 'script' | 'style'): string[] => {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
};

/**
 * Builds the policy for one static HTML document.
 *
 * `connect-src 'self'` is required: the script fetches the deletion endpoint on
 * this same origin, and `default-src 'none'` would otherwise refuse it — a CSP
 * that blocks the page's only action is a page that looks fine and does
 * nothing.
 */
export const staticPageCsp = (html: string): string => {
  const scripts = inlineBlocks(html, 'script').map(sha256);
  const styles = inlineBlocks(html, 'style').map(sha256);

  return [
    "default-src 'none'",
    `script-src ${scripts.length ? scripts.join(' ') : "'none'"}`,
    `style-src ${styles.length ? styles.join(' ') : "'none'"}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    // The form is submitted by script; a native submit is a JS-disabled
    // fallback that this page does not implement, so 'self' is the honest
    // bound rather than 'none'.
    "form-action 'self'",
    // The control modern browsers honour. helmet sends X-Frame-Options too.
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
};

/**
 * Applies a page CSP for a document whose HTML is known at module load.
 *
 * Mounted by the page router rather than globally, so it can be this strict:
 * the policy names the exact scripts and styles the document contains, which is
 * only possible when the document is static.
 */
export const staticPageCspMiddleware = (html: string) => {
  const policy = staticPageCsp(html);
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('Content-Security-Policy', policy);
    next();
  };
};
