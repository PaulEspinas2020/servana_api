/**
 * The contract the RUNNING PROCESS implements, and its fingerprint.
 *
 * ## The gap this closes
 *
 * TAB 08 of the Admin API Master Command:
 *
 * > The portal pins a copy of `openapi.v1.json` and generates its DTOs from it.
 * > It can detect a stale pin ONLY when a `servana_api` checkout sits beside it
 * > — true on a developer machine, false in CI. … the portal currently proves
 * > its pin matches your CHECKOUT and can prove nothing about the process
 * > serving requests.
 *
 * Measured before building: this API served the document at no path at all.
 * There was no `/openapi` route, no digest header, nothing. A client's only
 * comparison was against a git checkout, which is a statement about a
 * repository rather than about a server.
 *
 * ## Why the served document is GENERATED, not read from disk
 *
 * `docs/api/openapi.v1.json` is a committed artefact. Serving that file would
 * answer "what does the repository say?" — the same question a checkout already
 * answers, from a different angle.
 *
 * `buildOpenApiDocument()` derives the document from `V1_CONTRACT` and
 * `SCHEMAS`, which are the same modules `register.ts` mounts the routers from.
 * So what this serves is not a description of the API; it is the API's own
 * source of truth, rendered. A deploy that shipped new code and a stale
 * document cannot happen here, because there is no second copy to go stale.
 *
 * That is precisely the book's third ask — *"so 'the contract the running
 * process implements' is a thing that can be fetched rather than inferred from
 * a checkout"*.
 *
 * ## Why the digest is computed once
 *
 * The document is ~330 kB of JSON and the digest is stable for the life of the
 * process: `V1_CONTRACT` is a frozen module-level array, and a new contract is
 * a new build, which is a new process. Hashing per request would spend
 * milliseconds re-deriving a constant.
 *
 * Computed LAZILY rather than at import. This module is imported by
 * `register.ts`, which several suites import to introspect the route table, and
 * an eager 330 kB serialise on import is a cost every one of them pays for
 * nothing.
 */

import crypto from 'crypto';
import { buildOpenApiDocument } from './openapi';

/** The header every `/api/v1` response carries. */
export const CONTRACT_DIGEST_HEADER = 'x-contract-sha256';

/** The header naming the algorithm, so a client never has to assume one. */
export const CONTRACT_DIGEST_ALGORITHM = 'sha256';

interface ServedContract {
  document: Record<string, unknown>;
  /** Canonical JSON — what the digest is taken over, byte for byte. */
  body: string;
  /** Full hex sha256 of `body`. */
  digest: string;
}

let cached: ServedContract | null = null;

/**
 * The document, its serialisation and its digest.
 *
 * The digest is taken over the EXACT bytes served, not over the object. A
 * client that fetches the body and hashes it must get the same answer, or the
 * header is decoration — and `JSON.stringify` on the same object can differ
 * between two serialisations if either side re-formats. Serialising once and
 * hashing that string removes the question.
 */
export function servedContract(): ServedContract {
  if (cached) return cached;

  const document = buildOpenApiDocument();
  // No indentation: this is a wire format, not a file. The committed artefact
  // is pretty-printed for diff review and is a different byte sequence on
  // purpose — a client comparing against `docs/api/openapi.v1.json` must
  // compare PARSED content, never the two hashes.
  const body = JSON.stringify(document);
  const digest = crypto.createHash(CONTRACT_DIGEST_ALGORITHM).update(body, 'utf8').digest('hex');

  cached = { document, body, digest };
  return cached;
}

/** Hex sha256 of the served contract. Cheap after the first call. */
export const contractDigest = (): string => servedContract().digest;

/**
 * Reset the memo. Tests only.
 *
 * Exported because a suite that mutates `SCHEMAS` and re-derives would
 * otherwise be handed the first process-wide answer forever, and pass while
 * proving nothing.
 */
export function resetContractDigest(): void {
  cached = null;
}
