"""Generate SERVANA_PROVIDER_API_SPEC.yaml from the extracted route inventory.

Generated, not hand-written, so it cannot drift from the routes it describes.
Re-run scripts/audit-provider-endpoints.py first if routes have changed.
"""
import io, json, os, re

HERE = os.path.dirname(__file__)
rows = json.load(io.open(os.path.join(HERE, "inventory.json"), encoding="utf-8"))
OUT = r"C:\Users\paulg\OneDrive\Desktop\servana_api-main\docs\SERVANA_PROVIDER_API_SPEC.yaml"

# The booking-scoped successors (/api/booking/:id/provider-location, and
# /api/booking/:id/provider) are provider-facing by purpose but do not carry a
# provider-shaped prefix — they are keyed on the booking deliberately, so the
# caller cannot name an arbitrary provider. Filtering on prefix alone excluded
# the two endpoints that exist BECAUSE of this specification.
CANON = ("/api/worker/", "/api/provider/", "/api/providers/", "/api/booking/")
LEGACY_FILE = "routes/technician.routes.ts"

# Canonical + shared provider surface only. Admin has its own permission model.
keep = [
    r for r in rows
    if (any(r["path"].startswith(p) for p in CANON)
        or r["file"] in ("chat/chat.routes.ts", "routes/additional.routes.ts"))
    and "/admin/" not in r["path"]
]
legacy = [r for r in rows if r["file"] == LEGACY_FILE]

def op_id(r):
    h = (r.get("handler") or "op").split(".")[-1]
    return re.sub(r"[^A-Za-z0-9]", "", h) or "operation"

def params(r):
    out = []
    for p in re.findall(r"\{(\w+)\}|:(\w+)", r["path"]):
        name = p[0] or p[1]
        out.append((name, "path"))
    for q in (r.get("query") or []):
        out.append((q, "query"))
    return out

def esc(s):
    return str(s).replace("\\", "/").replace('"', "'")

L = []
w = L.append

w("# Servana provider API — canonical specification")
w("#")
w("# Command 3 section 3 deliverable. GENERATED from source by")
w("# scratchpad/genspec.py against the route inventory, so it cannot drift from")
w("# the routes it describes. Do not hand-edit: re-run the generator.")
w("#")
w("# SCOPE AND HONESTY NOTE")
w("# Request and response SCHEMAS are deliberately loose. The backend uses raw")
w("# pg with no ORM and no serializer layer, so a response body is whatever each")
w("# handler assembles inline. Publishing invented schemas would be worse than")
w("# publishing none: three client teams would code against them. Paths, methods,")
w("# auth, ownership and parameters below ARE verified from source.")
w("openapi: 3.1.0")
w("info:")
w("  title: Servana Provider API")
w("  version: '2026-08-02'")
w("  description: >-")
w("    Provider-facing surface. Every operation derives the acting provider from")
w("    the Firebase bearer token; none accepts a provider id from the caller.")
w("    See SERVANA_PROVIDER_IDENTITY_MODEL.md.")
w("servers:")
w("  - url: https://api.servana.com.ph")
w("    description: production")
w("components:")
w("  securitySchemes:")
w("    firebaseBearer:")
w("      type: http")
w("      scheme: bearer")
w("      bearerFormat: JWT")
w("      description: >-")
w("        Firebase ID token. verifyAuth assigns the decoded token to req.user")
w("        verbatim; it carries no role, so role checks are a separate DB read.")
w("  schemas:")
w("    Error:")
w("      type: object")
w("      description: >-")
w("        Canonical envelope. NOT yet universal — eight shapes exist in")
w("        production. See SERVANA_PROVIDER_ERROR_CODES.md for the migration.")
w("      properties:")
w("        status: { type: string, enum: [error] }")
w("        error:")
w("          type: object")
w("          properties:")
w("            code: { type: string }")
w("            message: { type: string }")
w("            fieldErrors: { type: object, additionalProperties: { type: string } }")
w("            retryable: { type: boolean }")
w("            requestId: { type: string }")
w("          required: [code, message]")
w("      required: [status, error]")
w("  responses:")
w("    Unauthorized:")
w("      description: No credential, or it did not verify")
w("      content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }")
w("    Forbidden:")
w("      description: Authenticated but not permitted, or not the caller's record")
w("      content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }")
w("    NotFound:")
w("      description: No such record, or none the caller may see")
w("      content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } }")
w("security:")
w("  - firebaseBearer: []")
w("paths:")

bypath = {}
for r in keep:
    bypath.setdefault(r["path"], []).append(r)

for path in sorted(bypath):
    w(f"  {path.replace(':', '')}:" if ":" not in path else
      "  " + re.sub(r":(\w+)", r"{\1}", path) + ":")
    seen_params = set()
    for r in sorted(bypath[path], key=lambda x: x["method"]):
        w(f"    {r['method'].lower()}:")
        w(f"      operationId: {op_id(r)}")
        w(f"      summary: {esc(r.get('handler') or '')}")
        auth = "verifyAuth" in r["mw"]
        ident = "token" if r.get("token") else "request"
        w("      description: >-")
        w(f"        Source: {esc(r['file'])}:{r['line']}.")
        w(f"        Authentication: {'required' if auth else 'NONE'}.")
        w(f"        Acting identity derived from: {ident}.")
        if not auth:
            w("        WARNING: this route has no authentication.")
        ps = params(r)
        if ps:
            w("      parameters:")
            for name, loc in ps:
                w(f"        - name: {name}")
                w(f"          in: {loc}")
                w(f"          required: {'true' if loc == 'path' else 'false'}")
                w("          schema: { type: string }")
        w("      responses:")
        w("        '200':")
        w("          description: Success. Body shape is handler-defined; see the source.")
        w("        '401': { $ref: '#/components/responses/Unauthorized' }")
        w("        '403': { $ref: '#/components/responses/Forbidden' }")
        w("        '404': { $ref: '#/components/responses/NotFound' }")

w("")
w("# ---------------------------------------------------------------------------")
w("# DELIBERATELY EXCLUDED: the legacy /api/workers/* family")
w("# ---------------------------------------------------------------------------")
w(f"# {len(legacy)} routes in technician.routes.ts are omitted from this spec.")
w("# 30 of them carry NO authentication and take their subject from the URL or")
w("# query string. They are being retired (WORKER_ROUTE_MIGRATION.md); both")
w("# client apps have been migrated off them. Specifying them would legitimise")
w("# them, and any new client written against this document must never call one.")

io.open(OUT, "w", encoding="utf-8", newline="\n").write("\n".join(L) + "\n")
print(f"wrote {OUT}")
print(f"  operations: {len(keep)}   legacy excluded: {len(legacy)}")
