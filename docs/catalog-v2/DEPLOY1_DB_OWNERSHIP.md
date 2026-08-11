# DEPLOY1_DB_OWNERSHIP

Ownership gate per §3 / §5 / §23. This is the control that the earlier outage failed.

| Check | Result |
|---|---|
| Deploy / runtime role | `admin` |
| Tables in `servana` owned by `admin` | **120 / 120** |
| `service_families` view owner | **`admin`** |
| Objects owned by `postgres` | **0** |
| Migration executed by | the deployment's own migration step |
| Manual production DDL used | **none** |

The four `catalog_*` tables were created as `postgres` during the earlier incident
and have since been transferred to `admin`; that is why the count is now clean.

Migration 023 sets `ALTER VIEW ... OWNER TO admin` explicitly rather than relying on
the connecting role, so the object is correct regardless of who runs it.

**Recommended hardening (not yet implemented):** a CI assertion that fails the build
when any object in `servana` is owned by a role other than `admin`. Until that
exists, this gate is verified manually per deploy.
