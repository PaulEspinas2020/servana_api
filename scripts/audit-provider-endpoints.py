"""Command 3 §1 — generate the provider-facing endpoint audit inventory.

Extracts, per route, straight from source:
  method / path / router file:line / middleware chain / controller symbol
  identity source (token vs client-supplied)  <-- the ownership question
  query params read, body fields read, services called
  response keys, status codes
  which clients call it
"""
import io, os, re, json

BE = r"C:\Users\paulg\OneDrive\Desktop\servana_api-main"
SRC = os.path.join(BE, "src")
CLIENTS = {
    "worker": r"C:\Users\paulg\OneDrive\Desktop\ServanaWorker\lib",
    "portal": r"C:\Users\paulg\OneDrive\Desktop\Servana.com.ph\src",
    "customer": r"C:\Users\paulg\OneDrive\Desktop\servana_client-main\lib",
    "admin": r"C:\Users\paulg\OneDrive\Desktop\servana_adminportal\src",
}

ROUTE_FILES = [
    "routes/provider.routes.ts", "routes/technician.routes.ts",
    "routes/providerCatalog.routes.ts", "routes/additional.routes.ts",
    "routes/disbursement.routes.ts", "routes/location.routes.ts",
    "chat/chat.routes.ts", "routes/booking.routes.ts", "routes/payment.routes.ts",
]

# ---------------------------------------------------------------- controllers
controllers = {}
for dp, _, fs in os.walk(SRC):
    for f in fs:
        if f.endswith(".ts"):
            p = os.path.join(dp, f)
            controllers[os.path.splitext(f)[0]] = io.open(p, encoding="utf-8").read()


def find_handler(sym):
    """Locate `export const <name>` across controller files; return its body."""
    if "." in sym:
        _, name = sym.rsplit(".", 1)
    else:
        name = sym
    name = name.strip()
    for mod, src in controllers.items():
        m = re.search(r"export\s+const\s+" + re.escape(name) + r"\s*[=:]", src)
        if not m:
            continue
        # body = from match to the next top-level `};`
        rest = src[m.start():]
        end = rest.find("\n};")
        return mod, (rest[: end + 3] if end > 0 else rest[:3000])
    return None, None


def analyse(body):
    if not body:
        return {}
    token = bool(re.search(r"req\.user\?\.uid|\(req as any\)\.user\?\.uid", body))
    claimed = sorted(set(re.findall(r"req\.params\.(\w+)", body)
                         + re.findall(r"req\.params as \{\s*(\w+)", body)))
    body_uid = bool(re.search(r"req\.body[^;]*\buid\b", body))
    query = sorted(set(re.findall(r"req\.query\.(\w+)", body)
                       + re.findall(r"\}\s*=\s*req\.query", body) and
                       re.findall(r"const\s*\{([^}]*)\}\s*=\s*req\.query", body)))
    qflat = []
    for q in query:
        qflat += [x.strip().split(":")[0] for x in q.split(",") if x.strip()]
    qflat = sorted(set(x for x in qflat if x.isidentifier()))
    bodyf = []
    for m in re.findall(r"const\s*\{([^}]*)\}\s*=\s*req\.body", body):
        bodyf += [x.strip().split(":")[0] for x in m.split(",") if x.strip()]
    services = sorted(set(re.findall(r"\b(\w+(?:Service|service))\.(\w+)", body) and
                          [f"{a}.{b}" for a, b in re.findall(r"\b(\w+(?:Service|service))\.(\w+)", body)]))
    codes = sorted(set(re.findall(r"status\((\d{3})\)", body)))
    resp = sorted(set(re.findall(r"res\.json\(\{\s*([\w]+)", body)))
    paginated = bool(re.search(r"\b(limit|offset|page|cursor)\b", body))
    return dict(token=token, claimed=claimed, body_uid=body_uid, query=qflat,
                body_fields=sorted(set(bodyf)), services=services[:6],
                codes=codes, resp=resp, paginated=paginated)


# ---------------------------------------------------------------- routes
rx = re.compile(r"""router\.(get|post|put|patch|delete)\(\s*["']([^"']*)["']\s*,?([^;]*?)\)\s*;""", re.S)
rows = []
for rel in ROUTE_FILES:
    p = os.path.join(SRC, rel.replace("/", os.sep))
    if not os.path.exists(p):
        continue
    src = io.open(p, encoding="utf-8").read()
    # Router-level middleware applies to every route in the file, or to a path
    # prefix. Missing this reported all 10 authenticated chat routes as
    # unauthenticated — a false critical. `router.use(verifyAuth)` binds exactly
    # as hard as naming it per route.
    router_mw = []
    for um in re.finditer(r"""router\.use\(\s*(?:["']([^"']+)["']\s*,\s*)?([\w, ]+)\)""", src):
        prefix, mws_txt = um.group(1) or "", um.group(2)
        router_mw.append((prefix, [x.strip() for x in mws_txt.split(",") if x.strip()]))
    lines = src.split("\n")
    for m in rx.finditer(src):
        method, path, rest = m.group(1).upper(), m.group(2), m.group(3)
        line = src[: m.start()].count("\n") + 1
        parts = [c.strip() for c in re.split(r",(?![^(]*\))", rest) if c.strip()]
        handler = parts[-1] if parts else ""
        mws = parts[:-1]
        for prefix, rmws in router_mw:
            if not prefix or path.startswith(prefix):
                mws = rmws + mws
        mod, bodytext = find_handler(handler)
        a = analyse(bodytext)
        rows.append(dict(
            method=method, path="/api" + path, file=rel, line=line,
            mw=[w.split("(")[0].strip() for w in mws],
            handler=handler.split("(")[0].strip(), controller=mod, **a))

# ---------------------------------------------------------------- client usage
usage = {}
for name, root in CLIENTS.items():
    txt = []
    for dp, ds, fs in os.walk(root):
        ds[:] = [d for d in ds if d not in ("node_modules", ".git", "build")]
        for f in fs:
            if f.endswith((".dart", ".ts", ".tsx")):
                try:
                    txt.append(io.open(os.path.join(dp, f), encoding="utf-8", errors="replace").read())
                except Exception:
                    pass
    usage[name] = "\n".join(txt)


def called_by(path):
    # strip params to a prefix that survives interpolation
    stem = re.split(r"/:", path)[0]
    out = []
    for name, blob in usage.items():
        if stem and stem in blob:
            out.append(name)
    return out


for r in rows:
    r["clients"] = called_by(r["path"])

json.dump(rows, io.open(os.path.join(os.path.dirname(__file__), "inventory.json"), "w", encoding="utf-8"), indent=1)
print(f"extracted {len(rows)} provider-facing routes")

auth = sum(1 for r in rows if "verifyAuth" in r["mw"])
print(f"  with verifyAuth:     {auth}")
print(f"  WITHOUT verifyAuth:  {len(rows)-auth}")
tok = sum(1 for r in rows if r.get("token"))
print(f"  identity from token: {tok}")
cli = sum(1 for r in rows if r.get("claimed") and not r.get("token"))
print(f"  identity CLIENT-SUPPLIED only: {cli}")
