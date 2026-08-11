/**
 * Handler types, in their own module on purpose.
 *
 * `register.ts` imports the domain modules and the domain modules need the
 * handler type. Putting the type in `register.ts` would make that a cycle;
 * TypeScript elides type-only imports so it would compile today, but it would
 * break the first time somebody imports a VALUE from `register` into a domain
 * module — and it would break at runtime, on boot, with an undefined that
 * looks nothing like its cause.
 */

import { Request, Response } from 'express';

export type V1Handler = (req: Request, res: Response) => unknown | Promise<unknown>;

/** Handler map keyed by `ContractEntry.id`. */
export type V1Handlers = Record<string, V1Handler>;
