// =================================================================
// OKX Advanced Analytics Bot - v76 (Revised with Quick Stats Fix)
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

async function getHistoricalPerformance(asset) {
    try {
        const history = await getCollection("tradeHistory").find({ asset: asset }).toArray();
        if (history.length === 0) {
            return {
                realizedPnl: 0,
                tradeCount: 0,
                winningTrades: 0,
                losingTrades: 0,
                avgDuration: 0
            };
        }
        const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0);
        const winningTrades = history.filter(trade => trade.pnl > 0).length;
        const losingTrades = history.filter(trade => trade.pnl <= 0).length;
        const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0);
        const avgDuration = totalDuration / history.length;
        return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration };
    } catch (e) {
        console.error(`Error fetching historical performance for ${asset}:`, e);
        return null;
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

// === Helpers ===
function formatNumber(num, decimals = 2) {
    const number = parseFloat(num);
    if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals);
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

// Fetch market tickers
async function getMarketPrices() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const json = await res.json();
        if (json.code !== '0') return null;
        const prices = {};
        json.data.forEach(t => {
            if (t.instId.endsWith("-USDT")) {
                const last = parseFloat(t.last);
                const open = parseFloat(t.open24h);
                const change24h = open > 0 ? (last - open) / open : 0;
                prices[t.instId] = { price: last, open24h: open, change24h, volCcy24h: parseFloat(t.volCcy24h) };
            }
        });
        return prices;
    } catch {
        return null;
    }
}

// Fetch portfolio
async function getPortfolio(prices) {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== '0') return { error: json.msg };
        let assets = [], total = 0;
        json.data[0].details.forEach(a => {
            const amount = parseFloat(a.eq);
            if (amount > 0) {
                const instId = `${a.ccy}-USDT`;
                const priceData = prices[instId] || { price: a.ccy === "USDT" ? 1 : 0, change24h: 0 };
                const value = amount * priceData.price;
                total += value;
                if (value >= 1) assets.push({ asset: a.ccy, amount, price: priceData.price, value, change24h: priceData.change24h });
            }
        });
        assets.sort((x, y) => y.value - x.value);
        return { assets, total };
    } catch {
        return { error: "Connection error" };
    }
}

// Quick stats (fixed)
async function formatQuickStats(assets, total, capital) {
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const statusEmoji = pnl >= 0 ? '🟢' : '🔴';
    const statusText = pnl >= 0 ? 'ربح' : 'خسارة';

    let msg = "⚡ *إحصائيات سريعة*\n\n";
    msg += `💎 *إجمالي الأصول:* \`${assets.filter(a => a.asset !== 'USDT').length}\`\n`;
    msg += `💰 *القيمة الحالية:* \`$${formatNumber(total)}\`\n`;
    msg += `📈 *نسبة الربح/الخسارة:* \`${formatNumber(pnlPercent)}%\`\n`;
    msg += `🎯 *الحالة:* ${statusEmoji} ${statusText}\n\n`;
    msg += `⏰ *آخر تحديث:* ${new Date().toLocaleTimeString("ar-EG")}`;

    return msg;
}

// Format portfolio report
async function formatPortfolioMsg(assets, total, capital) {
    const positions = await loadPositions();
    let dailyPnlText = "▫️ *الأداء اليومي (24س):* `لا توجد بيانات كافية`\n";
    let total24h = 0;
    assets.forEach(a => {
        if (a.asset === "USDT") total24h += a.value;
        else if (a.change24h !== undefined) {
            const v = a.amount * (a.price / (1 + a.change24h));
            total24h += v;
        }
    });
    if (total24h > 0) {
        const dp = total - total24h;
        const dpPct = (dp / total24h) * 100;
        const emoji = dp >= 0 ? '🟢⬆️' : '🔴⬇️';
        dailyPnlText = `▫️ *الأداء اليومي (24س):* ${emoji} \`${dp>=0?'+':''}${formatNumber(dp)}\` (\`${dp>=0?'+':''}${formatNumber(dpPct)}%\`)\n`;
    }

    const pnl = capital > 0 ? total - capital : 0;
    const pnlPct = capital > 0 ? (pnl / capital) * 100 : 0;
    const pnlEmoji = pnl >= 0 ? '🟢⬆️' : '🔴⬇️';

    const usdt = assets.find(a => a.asset === "USDT");
    const cashPct = total>0 ? (usdt?usdt.value:0)/total*100 : 0;
    const liqText = `▫️ *توزيع السيولة:* 💵 نقدي ${formatNumber(cashPct,1)}% / 📈 مستثمر ${formatNumber(100-cashPct,1)}%`;

    let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n`;
    msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 *نظرة عامة على الأداء:*\n`;
    msg += `▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`;
    msg += `▫️ *رأس المال المسجل:* \`$${formatNumber(capital)}\`\n`;
    msg += `▫️ *إجمالي الربح غير المحقق:* ${pnlEmoji} \`${pnl>=0?'+':''}${formatNumber(pnl)}\` (\`${pnl>=0?'+':''}${formatNumber(pnlPct)}%\`)\n`;
    msg += dailyPnlText;
    msg += liqText + `\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n💎 *مكونات المحفظة:*\n`;

    assets.forEach((a,i) => {
        const pct = total>0? a.value/total*100:0;
        msg += `\n╭─ *${a.asset}/USDT*\n`;
        msg += `├─ *القيمة الحالية:* \`$${formatNumber(a.value)}\` (*${formatNumber(pct)}%*)\n`;
        msg += `├─ *السعر:* \`$${formatNumber(a.price,4)}\`\n`;
        msg += `├─ *الأداء اليومي:* ${a.change24h>=0?'🟢⬆️':'🔴⬇️'} \`${formatNumber(a.change24h*100)}%\`\n`;
        const pos = positions[a.asset];
        if (pos && pos.avgBuyPrice) {
            const cost = pos.avgBuyPrice * a.amount;
            const ap = a.value - cost;
            const apPct = cost>0?ap/cost*100:0;
            msg += `╰─ *متوسط الشراء:* \`$${formatNumber(pos.avgBuyPrice,4)}\` | *غير محقق:* ${ap>=0?'🟢':'🔴'} \`${ap>=0?'+':''}${formatNumber(ap)}\` (\`${ap>=0?'+':''}${formatNumber(apPct)}%\`)\n`;
        } else {
            msg += `╰─ *متوسط الشراء:* \`غير مسجل\`\n`;
        }
        if (i<assets.length-1) msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    });

    return msg;
}

// ... (rest of code unchanged: monitorBalanceChanges, alerts, charts, commands etc.)

// === Healthcheck endpoint for hosting platforms ===
app.get("/healthcheck", (req, res) => {
    res.status(200).send("OK");
});

// === Start Bot ===
async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected.");

        setInterval(monitorBalanceChanges, 60000);
        setInterval(checkPriceAlerts, 30000);
        setInterval(checkPriceMovements, 60000);
        setInterval(runHourlyJobs, 3600000);
        setInterval(runDailyJobs, 86400000);

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
