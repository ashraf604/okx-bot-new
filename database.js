// database.js (Upstash Redis Final Version)

const { Redis } = require("@upstash/redis");

let redis;

// هذه هي الدالة الوحيدة التي نحتاجها للاتصال
function connectDB() {
    if (redis) {
        return redis;
    }
    
    // Redis.fromEnv() ستقوم تلقائيًا بقراءة متغيرات البيئة KV_URL و KV_REST_API_TOKEN
    // التي أضافتها Vercel. لا حاجة لكتابتها هنا.
    redis = Redis.fromEnv();
    
    console.log("Successfully initialized Upstash Redis client.");
    return redis;
}

const getDB = () => {
    if (!redis) {
        // تأكد من أن الاتصال موجود دائمًا
        return connectDB();
    }
    return redis;
};

module.exports = { connectDB, getDB };
