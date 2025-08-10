// database.js (The Corrected Version)

const { MongoClient } = require("mongodb");

let db;
let client;

async function connectDB() {
    if (db) return db; // إذا كان الاتصال موجودًا بالفعل، أعد استخدامه

    const uri = process.env.MONGO_URI;

    if (!uri) {
        console.error("FATAL ERROR: MONGO_URI is not defined in the environment variables.");
        throw new Error("MONGO_URI is not defined. Please check your Vercel environment variables and redeploy.");
    }

    client = new MongoClient(uri);

    try {
        await client.connect();
        db = client.db("okxBotData"); // اسم قاعدة بياناتك
        console.log("Successfully connected to MongoDB.");
        return db;
    } catch (e) {
        console.error("Failed to connect to MongoDB", e);
        // في بيئة serverless، لا نستخدم process.exit(1)
        throw new Error("Failed to connect to MongoDB.");
    }
}

const getDB = () => db;

module.exports = { connectDB, getDB };
