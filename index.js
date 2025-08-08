// =================================================================
// OKX Advanced Analytics Bot - v67 (PHASE 2: ANALYTICAL ENGINE)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// --- Bot Setup ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// --- State Variables ---
let waitingState = null;

// === Database Functions ===
const getCollection = (collectionName) => getDB().collection(collectionName);

async function getConfig(id, defaultValue = {}) {
    try {
        const doc = await getCollection("configs").findOne({ _id: id });
        return doc ? doc.data : defaultValue;
    } catch (e) {
        console.error(`Error in getConfig for id: ${id}`, e);
        return defaultValue;
    }
}

async function saveConfig(id, data) {
    try {
        await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true });
    } catch (e) {
        console.error(`Error in saveConfig for id: ${id}`, e);
    }
}

async function saveClosedTrade(tradeData) {
    try {
        await getCollection("tradeHistory").insertOne(tradeData);
    } catch (e) {
        console.error("Error in saveClosedTrade:", e);
    }
}

const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadSettings = async () => await getConfig("settings", { dailySummary: true, autoPostToChannel: false, debugMode: false });
const saveSettings = (settings) => saveConfig("settings", settings);
const loadPositions = async () => await getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);
const loadHistory = async () => await getConfig("dailyHistory", []);
const saveHistory = (history) => saveConfig("dailyHistory", history);
const loadHourlyHistory = async () => await getConfig("hourlyHistory", []);
const saveHourlyHistory = (history) => saveConfig("hourlyHistory", history);
const loadBalanceState = async () => await getConfig("balanceState", {});
const saveBalanceState = (state) => saveConfig("balanceState", state);
const loadAlerts = async () => await getConfig("priceAlerts", []);
const saveAlerts = (alerts) => saveConfig("priceAlerts", alerts);
const loadAlertSettings = async () => await getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);
const loadPriceTracker = async () => await getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);

// === Helper & API Functions ===
function formatNumber(num, decimals = 2) {
    const number = parseFloat(num);
    if (isNaN(number) || !isFinite(number)) {
        return (0).toFixed(decimals);
    }
    return number.toFixed(decimals);
}

async function sendDebugMessage(message) {
    const settings = await loadSettings();
    if (settings.debugMode) {
        try {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" });
        } catch (e) {
            console.error("Failed to send debug message:", e);
        }
    }
}

function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body);
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64");
    return {
        "OK-ACCESS-KEY": process.env.OKX_API_KEY,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
        "Content-Type": "application/json",
    };
}

async function getMarketPrices() {
    try {
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        if (tickersJson.code !== '0') {
            console.error("Failed to fetch market prices (OKX Error):", tickersJson.msg);
            return null;
        }
        const prices = {};
        tickersJson.data.forEach(t => {
            const lastPrice = parseFloat(t.last);
            const openPrice = parseFloat(t.open24h);
            let change24h = 0;
            if (openPrice > 0) {
                change24h = (lastPrice - openPrice) / openPrice;
            }
            prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h: change24h };
        });
        return prices;
    } catch (error) {
        console.error("Exception in getMarketPrices (Invalid Response):", error.message);
        return null;
    }
}

async function getPortfolio(prices) {
    // This function is complete and unchanged
}

async function getBalanceForComparison() {
    // This function is complete and unchanged
}

async function getInstrumentDetails(instId) {
    // This function is complete and unchanged
}

async function getHistoricalHighLow(instId, startDate, endDate) {
    // This function is complete and unchanged
}

// =================================================================
// START: NEW TECHNICAL ANALYSIS ENGINE
// =================================================================

async function getHistoricalCandles(instId, limit = 100) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&limit=${limit}`);
        const json = await res.json();
        if (json.code !== '0' || !json.data || json.data.length === 0) {
            console.error(`Could not fetch candle history for ${instId}:`, json.msg);
            return [];
        }
        // Return closing prices, oldest first
        return json.data.map(c => parseFloat(c[4])).reverse();
    } catch (e) {
        console.error(`Exception in getHistoricalCandles for ${instId}:`, e);
        return [];
    }
}

function calculateSMA(closes, period) {
    if (closes.length < period) return null;
    const relevantCloses = closes.slice(-period);
    const sum = relevantCloses.reduce((acc, val) => acc + val, 0);
    return sum / period;
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0;
    let losses = 0;

    // Calculate initial average gains and losses
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) {
            gains += diff;
        } else {
            losses -= diff; // losses are positive values
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Smooth the rest
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgLoss = (avgLoss * (period - 1) - diff) / period;
            avgGain = (avgGain * (period - 1)) / period;
        }
    }
    
    if (avgLoss === 0) return 100; // Prevent division by zero
    
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    return rsi;
}

async function getTechnicalAnalysis(instId) {
    const closes = await getHistoricalCandles(instId, 100);
    if (closes.length === 0) {
        return { error: "تعذر جلب البيانات الفنية." };
    }

    const rsi = calculateRSI(closes);
    const sma20 = calculateSMA(closes, 20);
    const sma50 = calculateSMA(closes, 50);

    return {
        rsi: rsi ? formatNumber(rsi) : null,
        sma20: sma20 ? formatNumber(sma20, 4) : null,
        sma50: sma50 ? formatNumber(sma50, 4) : null,
    };
}
// =================================================================
// END: NEW TECHNICAL ANALYSIS ENGINE
// =================================================================

function calculatePerformanceStats(history) {
    // This function is complete and unchanged
}

function createChartUrl(history, periodLabel, pnl) {
    // This function is complete and unchanged
}

async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) {
    // This function is complete and unchanged
}

async function formatPortfolioMsg(assets, total, capital) {
    // This function is complete and unchanged
}

async function monitorBalanceChanges() {
    // This function is complete and unchanged
}

async function checkPriceAlerts() {
    // This function is complete and unchanged
}

async function runDailyJobs() {
    // This function is complete and unchanged
}

async function runHourlyJobs() {
    // This function is complete and unchanged
}

async function checkPriceMovements() {
    // This function is complete and unchanged
}

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();

async function sendSettingsMenu(ctx) {
    // This function is complete and unchanged
}

async function sendMovementAlertsMenu(ctx) {
    // This function is complete and unchanged
}

bot.use(async (ctx, next) => {
    // This function is complete and unchanged
});

bot.command("start", async (ctx) => {
    await ctx.reply(`🤖 *بوت OKX التحليلي المتكامل*\n*الإصدار: v67 - Analytical Engine*\n\nأهلاً بك! أنا هنا لمساعدتك في تتبع وتحليل محفظتك الاستثمارية.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));

bot.command("pnl", async (ctx) => {
    // This function is complete and unchanged
});

bot.on("callback_query:data", async (ctx) => {
    // This function is complete and unchanged
});

// =================================================================
// START: MODIFIED 'message:text' HANDLER (ONLY 'coin_info' case is touched)
// =================================================================
bot.on("message:text", async (ctx) => {
    try {
        const text = ctx.message.text.trim();
        if (ctx.message.text && ctx.message.text.startsWith('/')) { return; }
        switch (text) {
            case "📊 عرض المحفظة":
                await ctx.reply("⏳ لحظات... جاري إعداد تقرير المحفظة.");
                // ... (rest of the case is unchanged)
                return;
            case "📈 أداء المحفظة": 
                // ... (unchanged)
                return;
            case "ℹ️ معلومات عملة": 
                waitingState = 'coin_info';
                await ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`)."); 
                return;
            case "⚙️ الإعدادات": 
                await sendSettingsMenu(ctx);
                return;
            case "🔔 ضبط تنبيه": 
                // ... (unchanged)
                return;
            case "🧮 حاسبة الربح والخسارة": 
                // ... (unchanged)
                return;
        }
        if (waitingState) {
            const state = waitingState;
            waitingState = null;
            switch (state) {
                case 'set_capital': 
                    // ... (unchanged)
                    return;
                case 'set_global_alert_state':
                    // ... (unchanged)
                    return;
                case 'set_coin_alert_state':
                    // ... (unchanged)
                    return;
                case 'coin_info':
                    const instId = text.toUpperCase();
                    await ctx.reply(`⏳ جاري البحث عن بيانات ${instId} وتجهيز التحليل الفني...`);
                    
                    // --- THIS IS A TEST FOR NOW ---
                    // We will call the new function to see if it works.
                    // The final report will be built in Phase 3.
                    
                    const techAnalysis = await getTechnicalAnalysis(instId);
                    
                    if(techAnalysis.error){
                        await ctx.reply(techAnalysis.error);
                    } else {
                        let testMsg = `*🧪 نتائج المحرك التحليلي (مرحلة 2):*\n\n` +
                                      `*العملة:* \`${instId}\`\n` +
                                      `*مؤشر القوة النسبية (RSI):* \`${techAnalysis.rsi || 'N/A'}\`\n` +
                                      `*متوسط 20 يوم (SMA20):* \`$${techAnalysis.sma20 || 'N/A'}\`\n` +
                                      `*متوسط 50 يوم (SMA50):* \`$${techAnalysis.sma50 || 'N/A'}\``;
                        await ctx.reply(testMsg, {parse_mode: "Markdown"});
                    }
                    return;
                    
                case 'set_alert':
                    // ... (unchanged)
                    return;
                case 'delete_alert_number':
                    // ... (unchanged)
                    return;
                case 'confirm_delete_all': 
                    // ... (unchanged)
                    return;
            }
        }
    } catch (error) { console.error("Caught a critical error in message:text handler:", error); }
});
// =================================================================
// END: MODIFIED 'message:text' HANDLER
// =================================================================


// === Healthcheck endpoint for hosting platforms ===
app.get("/healthcheck", (req, res) => {
    res.status(200).send("OK");
});

// === Start Bot ===
async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected.");
console.log("Environment variables seen by bot:", process.env);
        // NOTE: Timers are now managed to prevent memory leaks on restarts
        const intervals = [];
        intervals.push(setInterval(monitorBalanceChanges, 60000));
        intervals.push(setInterval(checkPriceAlerts, 30000));
        intervals.push(setInterval(checkPriceMovements, 60000));
        intervals.push(setInterval(runHourlyJobs, 3600000));
        intervals.push(setInterval(runDailyJobs, 86400000));

        // Graceful shutdown
        const shutdown = () => {
            console.log("Shutting down bot...");
            intervals.forEach(clearInterval);
            // Add any other cleanup here
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        if (process.env.NODE_ENV === "production") {
            app.use(express.json());
            app.use(webhookCallback(bot, "express"));
            app.listen(PORT, () => console.log(`Server on port ${PORT}`));
        } else {
            await bot.start();
            console.log("Bot started with polling.");
        }
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
    }
}

startBot();
