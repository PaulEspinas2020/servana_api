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
        return mongoClient.db(mongoConfig.mongoDatabase);
    } catch (err) {
        throw err;
    }
}

export default main();
