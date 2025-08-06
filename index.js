// =================================================================
// OKX Bot - v59 (Deployable Version)
// =================================================================
// This version is adapted to run correctly on a server like Railway,
// assuming all environment variables are correctly set.
// =================================================================

require("dotenv").config();
const express = require("express");
const { Bot, Keyboard, webhookCallback } = require("grammy");
const { connectDB, getDB } = require("./database.js"); // Assuming v59 uses this

// --- Critical Setup ---
// An error here (e.g., missing token) will cause a silent crash.
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);

// --- Basic Security ---
bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        await next();
    } else {
        console.log(`Unauthorized access attempt by user: ${ctx.from?.id}`);
    }
});

// --- Commands for v59 ---
const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").row()
    .text("⚙️ الإعدادات").text("💰 رأس المال")
    .resized();

bot.command("start", (ctx) => {
    ctx.reply("مرحبًا بك! نسخة 59 تعمل الآن. اختر أحد الأوامر:", {
        reply_markup: mainKeyboard,
    });
});

// Add other command handlers like handlePortfolioRequest here...


// --- Server Start Logic (Crucial for Deployment) ---
async function startBot() {
    try {
        await connectDB();
        console.log("Successfully connected to MongoDB.");

        // This part is for running on Railway
        if (process.env.NODE_ENV === "production") {
            console.log("Starting bot in production (webhook) mode...");
            app.use(express.json());

            // This route responds to Railway's health check
            app.get("/", (req, res) => {
                res.status(200).send("OK! Bot is alive.");
            });
            
            app.use(webhookCallback(bot, "express"));

            app.listen(PORT, () => {
                console.log(`Bot v59 is successfully listening on port ${PORT}`);
            });
        } else {
            // This part is for running locally on your computer
            console.log("Starting bot in development (polling) mode...");
            bot.start();
        }
    } catch (e) {
        console.error("FATAL ERROR: Could not start the bot.", e);
        process.exit(1); // Exit with an error code to make the failure clear
    }
}

startBot();
