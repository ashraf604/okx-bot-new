// =================================================================
// OKX Bot - DIAGNOSTIC BUILD v110
// This version is for debugging the environment variables issue.
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const { connectDB, getDB } = require("./database.js");

const app = express();
app.use(express.json());

// --- MAIN HANDLER WITH DIAGNOSTICS ---
const handler = async (req, res) => {
    
    // =========================================================
    // !! IMPORTANT DIAGNOSTIC CODE START !!
    // =========================================================
    console.log("========================================");
    console.log("==== VERCEL ENVIRONMENT DIAGNOSTICS ====");
    console.log("========================================");
    console.log("Request URL:", req.url);
    console.log("--- Checking process.env contents: ---");
    // طباعة كل المتغيرات لرؤية ما هو متاح
    console.log(process.env); 
    console.log("--- Checking MONGO_URI specifically: ---");
    // طباعة المتغير المطلوب تحديدًا
    console.log("MONGO_URI is:", process.env.MONGO_URI);
    console.log("========================================");
    // =========================================================
    // !! IMPORTANT DIAGNOSTIC CODE END !!
    // =========================================================

    try {
        await connectDB(); // سيستمر في إظهار الخطأ، لكن التشخيص سيتم قبله

        if (req.url.includes('/api/monitor')) {
            console.log("Cron job triggered.");
            // Logic for monitor...
            return res.status(200).send('Cron job executed successfully.');
        }

        if (req.url.includes('/api/bot')) {
            console.log("Webhook triggered.");
            const botInstance = new Bot(process.env.TELEGRAM_BOT_TOKEN);
            await botInstance.handleUpdate(req.body);
            return res.status(200).send('Update received.');
        }
        
        res.status(200).send("Bot is alive.");

    } catch (error) {
        console.error('CRITICAL ERROR in handler:', error.message);
        if (!res.headersSent) {
            res.status(500).send('An internal server error occurred.');
        }
    }
};

// ربط الدالة الرئيسية بجميع المسارات
app.all('/api/bot', handler);
app.all('/api/monitor', handler);
app.all('/', handler);

module.exports = app;
