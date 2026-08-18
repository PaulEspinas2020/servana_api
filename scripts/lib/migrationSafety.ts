/**
 * Migration safety rules (§147), as functions rather than as conventions.
 *
 * ## The bug this was written to fix
 *
 * `run-migrations.ts` owns the transaction: it runs `BEGIN`, then the migration
 * body, then the `schema_migrations` ledger insert, then `COMMIT`. That is the
 * right shape — the ledger row and the schema change land together or not at
 * all, so a half-applied migration cannot be recorded as applied.
 *
 * It stripped the file's own transaction control with two anchored regexes: one
 * matching `BEGIN;` anchored to the very START of the file, and one matching
 * `COMMIT;` anchored to the very END. (Both are reproduced verbatim in
 * `tests/migration-safety.test.ts`, where they can be written as code rather
 * than as a comment — a regex ending in a case-insensitive flag contains the
 * character pair that closes a block comment, which is its own small lesson.)
 *
 * Every migration in this repository opens with a comment header, so `BEGIN;`
 * is never at offset 0. Most close with a verification or operating note, so
 * `COMMIT;` is never the last thing in the file. **Neither regex matched
 * anything in 16 of the 36 migrations.**
 *
 * The consequence is not cosmetic. A surviving `COMMIT;` commits the WRAPPER's
 * transaction in the middle of the migration. Everything after it — including
 * the ledger insert — then runs outside any transaction, and the wrapper's own
 * `COMMIT` errors with "there is no transaction in progress". A failure in that
 * window leaves the schema changed and the ledger empty, so the next deploy
 * replays a migration that has already half-run.
 *
 * ## Why the fix is here and not in the migration files
 *
 * `run-migrations.ts` checksums the RAW file and refuses to proceed if an
 * applied migration's checksum has changed. Twenty of these files are applied in
 * production. Editing them to remove `BEGIN;` would change their checksums and
 * break the migration runner permanently — the remedy would be worse than the
 * defect.
 *
 * The checksum is taken before stripping, so fixing the stripper changes no
 * checksum and no file. That is the additive path.
 *
 * ## What "statement level" means here
 *
 * `BEGIN` and `END` are also PL/pgSQL block delimiters, and this repository uses
 * `DO $$ ... BEGIN ... END $$` in eleven migrations. Stripping those would
 * corrupt the procedure body and turn a working migration into a syntax error.
 * So the scanner blanks `$$`-quoted bodies, dollar-quoted tags and comments
 * before it looks, and only matches transaction control that terminates a
 * statement.
 */

/** Roles a migration-created object may belong to. */
export const APPROVED_OWNER_ROLES: readonly string[] = Object.freeze(['admin']);

/**
 * Migrations at or after this number must declare ownership explicitly.
 *
 * Everything before it is already applied in production and immutable — the
 * runner rejects a checksum change — so demanding an edit would be demanding a
 * broken deploy. Those are reported as ADVISORY instead, and the live remedy is
 * `npm run check:db-ownership`, which reads the actual catalog rather than
 * guessing from a file.
 */
export const OWNERSHIP_REQUIRED_FROM = 29;

// ─── Masking ──────────────────────────────────────────────────────────────────

/**
 * Replace comments and dollar-quoted bodies with equal-length blanks.
 *
 * Length-preserving on purpose: offsets in the masked text still point at the
 * real text, so a finding can name a line number a human can go and look at.
 */
export const maskNonCode = (sql: string): string => {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return sql
    // $tag$ ... $tag$ and $$ ... $$
    .replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, blank)
    // /* block comments */
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // -- line comments
    .replace(/--[^\n]*/g, blank)
    // 'string literals'
    .replace(/'(?:[^']|'')*'/g, blank);
};

const TRANSACTION_CONTROL =
  /\b(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END\s+TRANSACTION)\s*;/gi;

export interface TransactionFinding {
  line: number;
  statement: string;
}

/** Statement-level transaction control, ignoring PL/pgSQL blocks and comments. */
export const findTransactionControl = (sql: string): TransactionFinding[] => {
  const masked = maskNonCode(sql);
  const findings: TransactionFinding[] = [];
  for (const match of masked.matchAll(TRANSACTION_CONTROL)) {
    const upto = masked.slice(0, match.index ?? 0);
    findings.push({
      line: upto.split('\n').length,
      statement: match[0].replace(/\s+/g, ' ').trim().toUpperCase(),
    });
  }
  return findings;
};

// ─── The stripper ─────────────────────────────────────────────────────────────

/**
 * Remove statement-level transaction control so the wrapper's transaction is
 * the only one.
 *
 * Blanks rather than deletes, again to preserve offsets — a Postgres syntax
 * error reports a character position, and it should point at the same place in
 * the file a human opens.
 */
export const stripTransactionControl = (sql: string): string => {
  const masked = maskNonCode(sql);
  let out = sql;
  for (const match of masked.matchAll(TRANSACTION_CONTROL)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    out = out.slice(0, start) + match[0].replace(/[^\n]/g, ' ') + out.slice(end);
  }
  return out;
};

// ─── Ownership ────────────────────────────────────────────────────────────────

const CREATE_TABLE = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][\w.]*)/gi;
const OWNER_TO = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w.]*)\s+OWNER\s+TO\s+([A-Za-z_]\w*)/gi;

export interface OwnershipFinding {
  table: string;
  reason: string;
}

/**
 * Tables a migration creates without saying who owns them.
 *
 * The deploy runs `psql -U admin`, so a table created that way already belongs
 * to `admin` and the declaration is belt-and-braces. It is required from
 * migration 029 anyway, because the failure this guards against was a migration
 * applied BY HAND as `postgres`: 29 of 116 tables ended up owned by the wrong
 * role, the app had no privileges on them, and provider document upload
 * returned a bare 500 for every provider until somebody read the catalog.
 * An explicit OWNER makes the migration correct regardless of who runs it.
 */
export const findUnownedTables = (sql: string): OwnershipFinding[] => {
  const code = maskNonCode(sql);
  const created = [...code.matchAll(CREATE_TABLE)].map((m) => m[1].toLowerCase());
  const owned = new Map<string, string>();
  for (const match of code.matchAll(OWNER_TO)) {
    owned.set(match[1].toLowerCase(), match[2].toLowerCase());
  }

  const findings: OwnershipFinding[] = [];
  for (const table of [...new Set(created)]) {
    const owner = owned.get(table);
    if (!owner) {
      findings.push({ table, reason: 'no ALTER TABLE ... OWNER TO for a table this migration creates' });
    } else if (!APPROVED_OWNER_ROLES.includes(owner)) {
      findings.push({ table, reason: `owner "${owner}" is not an approved runtime role (${APPROVED_OWNER_ROLES.join(', ')})` });
    }
  }
  return findings;
};

// ─── The scan ─────────────────────────────────────────────────────────────────

export type Severity = 'BLOCKING' | 'ADVISORY';

export interface MigrationFinding {
  file: string;
  rule: 'transaction-control' | 'object-ownership' | 'filename' | 'destructive';
  severity: Severity;
  detail: string;
}

/**
 * The marker a migration uses to declare that it destroys something.
 *
 * Deliberately explicit rather than inferred. A scanner guessing from SQL would
 * be wrong in both directions: `DROP TRIGGER ... ` immediately recreated (031)
 * is not destructive, and a `DELETE FROM` hidden inside an `EXECUTE format(...)`
 * string — which is exactly how 037 drops its constraints — cannot be seen by
 * pattern-matching at all. The author knows; the scanner does not.
 */
export const DESTRUCTIVE_MARKER = 'SERVANA:DESTRUCTIVE';

/**
 * Whether a migration declares itself destructive.
 *
 * Read from a comment, so it survives `stripTransactionControl` and needs no
 * separate manifest that could drift from the file it describes.
 */
export const declaresDestructive = (sql: string): boolean => sql.includes(DESTRUCTIVE_MARKER);

/**
 * The env var that authorises ONE destructive migration by name.
 *
 * Per-migration on purpose. A blanket "allow destructive" flag set once in a CI
 * environment would silently authorise every future destructive migration too,
 * which is the accident this exists to prevent — not the one it would create.
 */
export const DESTRUCTIVE_ACK_VAR = 'SERVANA_APPLY_DESTRUCTIVE';

/**
 * Whether `name` is authorised to run destructively.
 *
 * The value is a comma-separated list of migration names, so a deploy that
 * genuinely intends two of them can say so without a blanket flag.
 */
export const destructiveAuthorised = (
  name: string,
  raw: string | undefined = process.env[DESTRUCTIVE_ACK_VAR],
): boolean =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(name);

export const migrationNumber = (fileName: string): number | null => {
  const match = /^(\d{3})-/.exec(fileName);
  return match ? Number(match[1]) : null;
};

/**
 * Every rule, applied to one migration.
 *
 * Transaction control is reported ADVISORY on the file and BLOCKING on the
 * STRIPPER: the file may keep its `BEGIN;` — twenty of them are applied and
 * frozen — but `stripTransactionControl` must be able to remove it. That is the
 * property that actually protects a deploy, and `tests/migration-safety.test.ts`
 * asserts it over every file in the directory.
 */
export const scanMigration = (fileName: string, sql: string): MigrationFinding[] => {
  const findings: MigrationFinding[] = [];
  const number = migrationNumber(fileName);

  if (number === null) {
    findings.push({
      file: fileName,
      rule: 'filename',
      severity: 'BLOCKING',
      detail: 'A migration must be named NNN-description.sql; the runner only picks up that form.',
    });
  }

  for (const finding of findTransactionControl(sql)) {
    findings.push({
      file: fileName,
      rule: 'transaction-control',
      severity: 'ADVISORY',
      detail:
        `line ${finding.line}: ${finding.statement} — the deploy wrapper owns the transaction. ` +
        'Stripped before execution; new migrations should omit it.',
    });
  }

  if (declaresDestructive(sql)) {
    findings.push({
      file: fileName,
      rule: 'destructive',
      severity: 'ADVISORY',
      detail:
        `declares ${DESTRUCTIVE_MARKER} — the runner will refuse it unless ` +
        `${DESTRUCTIVE_ACK_VAR} names it.`,
    });
  }

  const ownershipRequired = number !== null && number >= OWNERSHIP_REQUIRED_FROM;
  for (const finding of findUnownedTables(sql)) {
    findings.push({
      file: fileName,
      rule: 'object-ownership',
      severity: ownershipRequired ? 'BLOCKING' : 'ADVISORY',
      detail: `${finding.table}: ${finding.reason}`,
    });
  }

  return findings;
};

/** The statement-level transaction control that survives stripping. Must be empty. */
export const residualTransactionControl = (sql: string): TransactionFinding[] =>
  findTransactionControl(stripTransactionControl(sql));
