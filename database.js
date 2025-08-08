// database.js

const { MongoClient } = require("mongodb");

require("dotenv").config();



const uri = process.env.MONGO_URI;

if (!uri) {

    throw new Error("MONGO_URI is not defined in your environment variables.");

}



const client = new MongoClient(uri);

let db;



async function connectDB() {

    if (db) return db;

    try {

        await client.connect();

        db = client.db("okxBotData"); // اسم قاعدة بياناتك

        console.log("Successfully connected to MongoDB.");

        return db;

    } catch (e) {

        console.error("Failed to connect to MongoDB", e);

        process.exit(1);

    }

}



const getDB = () => db;



module.exports = { connectDB, getDB };
