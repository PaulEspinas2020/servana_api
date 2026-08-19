/**
 * `.env` must be loaded before anything reads `process.env`.
 *
 * On 2026-08-19 production answered 500 on every database-backed route with
 * `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string` — `pg`
 * being handed `undefined`. The `.env` file was present, correct, and in the
 * process's own working directory throughout.
 *
 * Two faults combined:
 *
 *  1. `app.ts` calls `dotenv.config()` in its module body, after its imports.
 *     In CommonJS every imported module's top-level code runs first, so a
 *     module reading `process.env` at import scope sees nothing from the file.
 *  2. `config.ts` — imported by 53 modules, and the module that captures the
 *     database credentials into a module-level `const` — guarded its own load
 *     with `if (!process.env.NODE_ENV)`. `NODE_ENV` is always set in
 *     production, so it never ran.
 *
 * So `.env` had never supplied the database credentials in production. The API
 * only worked because PM2's environment happened to carry them, which is why a
 * restart that lost them took the platform down.
 *
 * These are source-order assertions rather than behavioural ones deliberately.
 * The invariant IS the order of the import statements: module caching makes it
 * effectively untestable at runtime inside one Jest process, and the way this
 * regresses is somebody adding an import above the loader — which is visible
 * here and nowhere else.
 */
import fs from "fs";
import os from "os";
import path from "path";

const root = path.resolve(__dirname, "..");

function readSource(relative: string): string[] {
  return fs.readFileSync(path.join(root, relative), "utf8").split(/\r?\n/);
}

/** The first line that is an actual `import`, ignoring comments and blanks. */
function firstImportLine(lines: string[]): string | undefined {
  return lines
    .map((line) => line.trim())
    .find((line) => line.startsWith("import "));
}

describe("the environment is loaded before anything reads it", () => {
  it.each([
    ["src/config.ts", "53 modules import it and it captures db credentials"],
    ["src/app.ts", "the entry point"],
  ])("%s imports the env loader first", (file) => {
    const first = firstImportLine(readSource(file));

    expect(first).toBeDefined();
    expect(first).toMatch(/^import ["'](\.\/)?env\/loadEnv["'];?$/);
  });

  it("config.ts no longer guards the load behind NODE_ENV", () => {
    const source = readSource("src/config.ts").join("\n");

    // The original line. It never ran in production, because NODE_ENV is
    // always set there. Matching only outside comments: the replacement quotes
    // the old line in a comment to explain why it went.
    const live = source
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    expect(live).not.toContain("if (!process.env.NODE_ENV)");
  });

  it("the loader does not overwrite variables already in the environment", () => {
    // This is what makes importing it safe everywhere, and it is a property of
    // dotenv rather than of our code — so it is worth pinning. Production runs
    // today entirely on PM2's process environment; if this stopped holding,
    // adding the loader would start changing live configuration.
    const key = "SERVANA_ENV_LOAD_ORDER_PROBE";
    process.env[key] = "from-the-process";

    const dotenv = require("dotenv") as typeof import("dotenv");
    // os.tmpdir(), never the repo: the release-gate hermeticity test asserts
    // that no test writes into a tracked directory, and it is right to.
    const tmp = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "servana-env-probe-")),
      ".env.probe",
    );
    fs.writeFileSync(tmp, `${key}=from-the-file\n`);

    try {
      dotenv.config({ path: tmp });
      expect(process.env[key]).toBe("from-the-process");
    } finally {
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
      delete process.env[key];
    }
  });

  it("the loader exists and is importable for its side effect", () => {
    const loader = path.join(root, "src/env/loadEnv.ts");
    expect(fs.existsSync(loader)).toBe(true);

    const source = fs.readFileSync(loader, "utf8");
    expect(source).toContain("dotenv.config(");
    // It must consider the CWD, which is what PM2 sets to the app directory.
    expect(source).toContain("process.cwd()");
  });
});
