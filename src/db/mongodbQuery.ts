import { mongoConfig } from "../config";
import { MongoClient, Db } from "mongodb";

/**
 * MongoDB, connected on FIRST USE rather than on import (TAB 03).
 *
 * ## What this replaces
 *
 * ```
 * export const mongoClient = new MongoClient(URI, { … });
 * export default main();          // ← called at module load
 * ```
 *
 * Two import-time side effects in three lines. `new MongoClient` THROWS
 * immediately on a malformed URI, so importing anything that transitively
 * reached this module failed outright when `MONGO_URI` was unset — which is the
 * state of a clean checkout and of CI. And `main()` was invoked at load, so the
 * import opened a real connection.
 *
 * That is what stopped `src/app.ts` being importable by a test, which is TAB
 * 03's acceptance criterion: "tests can import and compose the app without
 * opening ports or touching real services".
 *
 * ## Why a thenable and not a function
 *
 * Every one of the eight call sites reads `(await mongoDb).collection(…)`.
 * Exporting `getDb()` would mean editing all of them, and each edit is a chance
 * to miss one and leave a promise unawaited. A lazy thenable keeps `await
 * mongoDb` working unchanged and moves the connection to the first await.
 *
 * The promise is cached, so concurrent callers share one connection attempt
 * rather than racing to open several — which is what the eager version
 * effectively guaranteed and this must not lose.
 */

const URI = (): string => process.env.MONGO_URI as string;

let client: MongoClient | null = null;
let connection: Promise<Db> | null = null;

/** The driver client. Constructed on first use — see the note above. */
export const getMongoClient = (): MongoClient => {
  if (!client) {
    client = new MongoClient(URI(), {
      retryWrites: false,
      minPoolSize: 1,
      maxPoolSize: 5,
      maxIdleTimeMS: 0,
      serverSelectionTimeoutMS: 60000,
      socketTimeoutMS: 0,
      connectTimeoutMS: 0,
    });
  }
  return client;
};

async function main(): Promise<Db> {
  const c = getMongoClient();
  await c.connect();
  console.log("Connected to MongoDB");
  return c.db(mongoConfig.mongoDatabase);
}

/** One connection attempt, shared by every caller. */
const connect = (): Promise<Db> => {
  if (!connection) {
    connection = main().catch((error) => {
      // Clear the cache so a later call can retry rather than resolving the
      // same rejection forever. An eager connection had no second chance.
      connection = null;
      throw error;
    });
  }
  return connection;
};

/** For tests and for shutdown. */
export const closeMongo = async (): Promise<void> => {
  if (client) await client.close();
  client = null;
  connection = null;
};

/**
 * `await mongoDb` connects on first use and reuses the connection after.
 *
 * Typed `PromiseLike<Db>` rather than `Promise<Db>`: it is deliberately NOT a
 * promise, because a promise would have to exist — and therefore have started
 * connecting — before anyone awaited it.
 */
const mongoDb: PromiseLike<Db> = {
  then: (onFulfilled, onRejected) => connect().then(onFulfilled, onRejected),
};

export default mongoDb;
