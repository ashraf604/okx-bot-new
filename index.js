// =================================================================
// OKX Advanced Analytics Bot - v76 (Refactored & Final)
// =================================================================

const express = require("express");
const { webhookCallback } = require("grammy");
require("dotenv").config();

const { connectDB } = require("./database.js");
const { bot } = require("./botInstance.js");
const { initializeHandlers } = require("./bot/handlers.js");
const { startBackgroundTasks } = require("./bot/tasks.js");

const app = express();
const PORT = process.env.PORT || 3000;

async function startBot() {
    try {
        await connectDB();
        
        initializeHandlers();    // تفعيل كل الأوامر والردود
        startBackgroundTasks(); // بدء كل مهام المراقبة في الخلفية

        if (process.env.NODE_ENV === "production") {
            app.use(express.json());
            
            // Endpoint for Railway's health checks
            app.get("/", (req, res) => {
                res.status(200).send("OK - Bot is healthy.");
            });

            // Secure webhook endpoint for Telegram
            app.use(`/${process.env.TELEGRAM_BOT_TOKEN}`, webhookCallback(bot, 'express'));

            app.listen(PORT, () => {
                console.log(`Server listening on port ${PORT}`);
            });
        } else {
            // For local development
            await bot.start();
            console.log("Bot started with polling.");
        }
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        process.exit(1);
    }
}

startBot();
