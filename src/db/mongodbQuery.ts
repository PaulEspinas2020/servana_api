import { mongoConfig } from "../config";
import { MongoClient, Db } from "mongodb";

const URI = process.env.MONGO_URI as string;

export const mongoClient = new MongoClient(URI, {
    retryWrites: false,
    minPoolSize: 1,
    maxPoolSize: 5,
    maxIdleTimeMS: 0,
    serverSelectionTimeoutMS: 60000,
    socketTimeoutMS: 0,
    connectTimeoutMS: 0,
});

async function main(): Promise<Db> {
    try {
        await mongoClient.connect();
        console.log("Connected to MongoDB");
        const db = mongoClient.db(mongoConfig.mongoDatabase);

        // Ensure phone_otps TTL index exists (auto-expires after 10 minutes)
        await db.collection("phone_otps").createIndex(
            { expiresAt: 1 },
            { expireAfterSeconds: 0, background: true }
        );

        return db;
    } catch (err) {
        throw err;
    }
}

export default main();
