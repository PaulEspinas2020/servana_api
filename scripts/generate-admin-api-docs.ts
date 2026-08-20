/**
 * Publishes the legacy admin surface as a contract.
 *
 *   docs/api/openapi.admin.json      every mounted /api/admin/* operation
 *   docs/api/ADMIN_SURFACE_REGISTRY.md  the same, readable, ordered by blast radius
 *
 * Run: npm run admin:docs        (rewrite)
 *      npm run admin:docs:check  (fail if the committed files are stale)
 *
 * `tests/admin-surface.test.ts` runs the check, so an admin route added without
 * a regenerate fails the gate rather than shipping undocumented.
 *
 * ## Why a second document and not more of openapi.v1.json
 *
 * `src/app.ts` runs `parityMiddleware` over everything except six prefixes, and
 * `/api/admin` is not one of them (`/api/admin/catalog` is). That middleware
 * INJECTS alias keys — `first_name`, `providerUid`, `level2`, `photoURL` and
 * some forty more — into every response on the way out.
 *
 * `openapi.v1.json` says of itself: "Routes under /api/v1 are exempt from the
 * cross-platform field-parity middleware that rewrites every other response, so
 * the shapes below are exactly what the wire carries." Folding parity-rewritten
 * operations into that document would make that sentence false for most of it,
 * and five clients generate code from it.
 *
 * So the admin surface gets its own document, which states `x-parity-rewritten`
 * per operation instead of hiding it. A client generating from this file knows
 * the declared shape is a SUBSET of the wire, which is a true and useful thing
 * to know; a client generating from a merged v1 document would believe it was
 * the whole shape, which is neither.
 */

import fs from 'fs';
import path from 'path';
import { AdminOperation, buildAdminSurface, opKey } from './lib/adminSurface';
import { ADMIN_RESPONSES, ADMIN_SCHEMAS } from '../src/api/admin/adminResponses';

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'api');
const JSON_OUT = path.join(OUT_DIR, 'openapi.admin.json');
const MD_OUT = path.join(OUT_DIR, 'ADMIN_SURFACE_REGISTRY.md');

/**
 * Blast-radius order, as TAB 01 asks for: "communications and provider-
 * onboarding first (the two that touch people outside Servana), then providers,
 * audit-logs, notifications, users."
 *
 * Anything not named here sorts after, alphabetically. A new area therefore
 * appears at the bottom rather than silently claiming priority.
 */
const AREA_ORDER = [
  'communications',
  'provider-onboarding',
  'providers',
  'admin-users',
  'finance',
  'disbursements',
  'bookings',
  'booking-drafts',
  'audit-logs',
  'notifications',
  'users',
];

const areaRank = (area: string): number => {
  const i = AREA_ORDER.indexOf(area);
  return i < 0 ? AREA_ORDER.length : i;
};

/** Express `:uid` → OpenAPI `{uid}`. */
export const toOpenApiPath = (p: string): string =>
  p.replace(/:([A-Za-z_][\w]*)/g, '{$1}');

/** Path parameter names, in declaration order. */
export const pathParams = (p: string): string[] =>
  [...p.matchAll(/:([A-Za-z_][\w]*)/g)].map((m) => m[1]);

const ENVELOPE_DESCRIPTION: Record<string, string> = {
  'status-success': 'Wrapped as `{ status: "success", data: … }`.',
  'success-flag':
    'Wrapped as `{ success: true, … }` — a BOOLEAN flag, not `status`. ' +
    'A client branching on `body.status === "success"` reads undefined here.',
  bare: 'A 2xx body with no success wrapper.',
  mixed:
    'This handler writes MORE THAN ONE success wrapper depending on the branch. ' +
    'A caller cannot assume either; treat the shape as unknown until it is fixed.',
  'non-json': 'The 2xx is not JSON. Do not generate a JSON type for this operation.',
  unknown:
    'The success shape could not be read from the handler. Not a claim that ' +
    'there is no shape — a claim that this generator could not find it.',
};

function responseSchemaFor(op: AdminOperation): Record<string, unknown> {
  const authored = ADMIN_RESPONSES[opKey(op)];
  const payloadKey = op.payloadKeys.length === 1 ? op.payloadKeys[0] : null;

  if (op.envelope === 'non-json') {
    return {
      description:
        `Not JSON. Content-Type: ${op.payloadKeys[0] ?? 'unknown'}.` +
        ' Declared so no client generates a JSON type for it.',
    };
  }

  const wrapper: Record<string, unknown> =
    op.envelope === 'status-success'
      ? { status: { type: 'string', enum: ['success'] } }
      : op.envelope === 'success-flag'
        ? { success: { type: 'boolean', enum: [true] } }
        : {};

  const payload = authored
    ? authored.schema
    : {
        description:
          'UNSPECIFIED. No schema has been authored for this operation yet. ' +
          'This is an honest gap, not an empty object: the payload has a real ' +
          'shape and nobody has written it down. A guessed schema would be worse ' +
          'than this, because a client would generate types from it.',
      };

  const properties: Record<string, unknown> = { ...wrapper };
  if (payloadKey) properties[payloadKey] = payload;

  return {
    type: 'object',
    description: ENVELOPE_DESCRIPTION[op.envelope],
    ...(Object.keys(properties).length ? { properties } : {}),
    ...(payloadKey ? {} : { 'x-payload-keys': op.payloadKeys }),
  };
}

function operationObject(op: AdminOperation): Record<string, unknown> {
  const authored = ADMIN_RESPONSES[opKey(op)];
  const params = pathParams(op.path);

  return {
    summary: `${op.handler} — ${op.area}`,
    operationId: `${op.method}_${toOpenApiPath(op.path)}`
      .replace(/[^\w]+/g, '_')
      .replace(/_+$/, ''),
    tags: [op.area],
    ...(params.length
      ? {
          parameters: params.map((name) => ({
            name,
            in: 'path',
            required: true,
            schema: { type: 'string' },
          })),
        }
      : {}),
    responses: {
      '200': {
        description: authored ? 'Authored against the service.' : 'Envelope declared; payload not yet authored.',
        content: { 'application/json': { schema: responseSchemaFor(op) } },
      },
    },
    'x-guard': op.guard,
    ...(op.permission ? { 'x-permission': op.permission } : {}),
    ...(op.handlerGuard ? { 'x-handler-guard': op.handlerGuard } : {}),
    'x-envelope': op.envelope,
    'x-payload-keys': op.payloadKeys,
    'x-parity-rewritten': op.parityRewritten,
    'x-source': op.source,
    ...(op.controller ? { 'x-controller': op.controller } : {}),
    ...(authored ? { 'x-derived-from': authored.derivedFrom } : {}),
    ...(authored?.note ? { 'x-note': authored.note } : {}),
    'x-callers': ['adminWeb'],
  };
}

export function buildAdminOpenApi(ops = buildAdminSurface()): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of ops) {
    const p = toOpenApiPath(op.path);
    paths[p] = paths[p] ?? {};
    paths[p][op.method] = operationObject(op);
  }

  const authored = ops.filter((o) => ADMIN_RESPONSES[opKey(o)]).length;

  return {
    openapi: '3.1.0',
    info: {
      title: 'Servana Admin API — the legacy surface, as mounted',
      version: '1.0.0',
      description: [
        'Every /api/admin/* operation the app mounts. GENERATED from the route tree by',
        '`npm run admin:docs` — do not edit by hand.',
        '',
        'READ THIS BEFORE GENERATING A CLIENT.',
        '',
        'These routes are NOT exempt from `parityMiddleware`. Unless x-parity-rewritten is',
        'false, the wire carries ADDITIONAL alias keys this document does not declare —',
        'first_name, providerUid, level2, photoURL and some forty more, injected on the way',
        'out. So a declared shape here is a SUBSET of what arrives, never the whole of it.',
        'That is the opposite of openapi.v1.json, whose shapes are exactly the wire.',
        '',
        'An operation whose 200 payload reads "UNSPECIFIED" has a real shape that nobody has',
        'written down yet. It is deliberately not guessed: a wrong schema is worse than an',
        'absent one, because a client generates types from it and breaks in a way that looks',
        'like the backend is at fault.',
      ].join('\n'),
    },
    servers: [{ url: 'https://api.servana.com.ph' }],
    'x-generated-from': 'scripts/generate-admin-api-docs.ts',
    'x-operation-count': ops.length,
    'x-authored-response-count': authored,
    'x-parity-rewritten-count': ops.filter((o) => o.parityRewritten).length,
    paths,
    components: { schemas: ADMIN_SCHEMAS },
  };
}

// ─── ADMIN_SURFACE_REGISTRY.md ────────────────────────────────────────────────

const esc = (s: string): string => s.replace(/\|/g, '\\|');

export function registryMarkdown(ops = buildAdminSurface()): string {
  const authored = ops.filter((o) => ADMIN_RESPONSES[opKey(o)]).length;
  const byArea = new Map<string, AdminOperation[]>();
  for (const op of ops) {
    if (!byArea.has(op.area)) byArea.set(op.area, []);
    byArea.get(op.area)!.push(op);
  }
  const areas = [...byArea.keys()].sort(
    (a, b) => areaRank(a) - areaRank(b) || a.localeCompare(b),
  );

  const envelopes = new Map<string, number>();
  for (const op of ops) envelopes.set(op.envelope, (envelopes.get(op.envelope) ?? 0) + 1);

  const guards = new Map<string, number>();
  for (const op of ops) guards.set(op.guard, (guards.get(op.guard) ?? 0) + 1);

  const out: string[] = [];
  out.push('# Admin Surface Registry');
  out.push('');
  out.push(
    '> GENERATED by `npm run admin:docs` from a static read of the route tree plus the',
    '> authored schemas in `src/api/admin/adminResponses.ts`. Do not edit by hand.',
  );
  out.push('');
  out.push(`Operations mounted under \`/api/admin/*\`: **${ops.length}**.`);
  out.push('');
  out.push(
    'The Admin API Master Command reports this surface as "51+, a floor", measured from',
    'the admin portal\'s call sites. Measured from the routers it is **' + ops.length + '**.',
    'The book\'s number was a floor on what one client could be seen to call, which is a',
    'different quantity from the size of the surface.',
  );
  out.push('');

  out.push('## Response envelope');
  out.push('');
  out.push('| Envelope | Count | What a client must do |');
  out.push('|---|---:|---|');
  for (const [k, v] of [...envelopes].sort((a, b) => b[1] - a[1])) {
    out.push(`| \`${k}\` | ${v} | ${esc(ENVELOPE_DESCRIPTION[k] ?? '')} |`);
  }
  out.push('');
  out.push(
    'Two success wrappers exist on one surface. A client that unwraps `body.data` reads',
    '`undefined` from every `success-flag` route — and three of those do not use `data` as',
    'the payload key at all (`disbursements`, `disbursement`, `worker`). Nothing anywhere',
    'said so before this document.',
  );
  out.push('');

  out.push('## Authorization');
  out.push('');
  out.push('| Guard | Count | Meaning |');
  out.push('|---|---:|---|');
  const GUARD_MEANING: Record<string, string> = {
    'super-admin': '`requireSuperAdmin`. Stricter than any named permission.',
    permission: 'Role 1 plus a named permission the chain declares.',
    'admin-role': 'Role 1, and no named permission on the chain.',
    authenticated:
      'A verified identity only. The HANDLER is the authority — see `x-handler-guard`.',
  };
  for (const [k, v] of [...guards].sort((a, b) => b[1] - a[1])) {
    out.push(`| \`${k}\` | ${v} | ${esc(GUARD_MEANING[k] ?? '')} |`);
  }
  out.push('');
  out.push(
    'The v1 contract REQUIRES a named permission on every `auth: \'admin\'` entry —',
    '`register.ts` throws at import time without one. The legacy tree has no such rule, so',
    'the `admin-role` rows are role-1 routes with no second gate. That is an asymmetry',
    'between the two trees, recorded here rather than asserted to be a defect: a v1',
    'successor for one of these must not be QUIETER than the route it replaces.',
  );
  out.push('');

  out.push('## Payload schemas');
  out.push('');
  out.push(`Authored: **${authored}** of ${ops.length}.`);
  out.push('');
  out.push(
    'The remainder publish their envelope, guard, permission and parity status, and declare',
    'the payload `UNSPECIFIED`. That is deliberate. A guessed schema is worse than an absent',
    'one: absent says "nobody wrote this down", wrong says "this is the shape" and a client',
    'generates types from it. `tests/admin-surface.test.ts` ratchets this count so it can',
    'only rise.',
  );
  out.push('');

  for (const area of areas) {
    const list = byArea.get(area)!;
    out.push(`## \`/api/admin/${area}\` (${list.length})`);
    out.push('');
    out.push('| Method | Path | Guard | Permission | Envelope | Payload | Parity |');
    out.push('|---|---|---|---|---|---|---|');
    for (const op of list) {
      const has = ADMIN_RESPONSES[opKey(op)] ? '✅ authored' : '— unspecified';
      out.push(
        `| \`${op.method.toUpperCase()}\` | \`${esc(op.path)}\` | ${op.guard} | ` +
          `${op.permission ? `\`${esc(op.permission)}\`` : '—'} | \`${op.envelope}\` | ` +
          `${has} | ${op.parityRewritten ? 'rewritten' : 'exempt'} |`,
      );
    }
    out.push('');
  }

  return out.join('\n') + '\n';
}

// ─── entry point ──────────────────────────────────────────────────────────────

export interface GeneratedFile {
  file: string;
  content: string;
}

export function generateAll(): GeneratedFile[] {
  const ops = buildAdminSurface();
  return [
    { file: JSON_OUT, content: JSON.stringify(buildAdminOpenApi(ops), null, 2) + '\n' },
    { file: MD_OUT, content: registryMarkdown(ops) },
  ];
}

/** Files whose committed content differs from what the generator produces. */
export function staleFiles(): string[] {
  return generateAll()
    .filter(({ file, content }) => {
      if (!fs.existsSync(file)) return true;
      // Compare on normalised line endings: this repo is checked out CRLF on
      // Windows and LF on the Linode box, and a byte compare would fail the
      // gate for one of them regardless of content.
      const onDisk = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      return onDisk !== content.replace(/\r\n/g, '\n');
    })
    .map(({ file }) => path.relative(path.resolve(__dirname, '..'), file));
}

if (require.main === module) {
  const check = process.argv.includes('--check');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (check) {
    const stale = staleFiles();
    if (stale.length) {
      console.error('\nAdmin surface docs are STALE:\n');
      for (const f of stale) console.error(`  ${f}`);
      console.error('\nRun `npm run admin:docs` and commit the result.\n');
      process.exit(1);
    }
    const ops = buildAdminSurface();
    const authored = ops.filter((o) => ADMIN_RESPONSES[opKey(o)]).length;
    console.log(
      `Admin surface docs are up to date. ${ops.length} operations, ` +
        `${authored} with an authored response schema.`,
    );
  } else {
    for (const { file, content } of generateAll()) {
      fs.writeFileSync(file, content);
      console.log(`wrote ${path.relative(path.resolve(__dirname, '..'), file)}`);
    }
  }
}
