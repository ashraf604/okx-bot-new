// =================================================================
// OKX Advanced Analytics Bot - v112 (Upstash Redis Final Build)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const { connectDB, getDB } = require("./database.js");

// --- Bot Setup ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// --- State Variable ---
let waitingState = null;

// =================================================================
// SECTION 1: DATABASE AND HELPER FUNCTIONS (MODIFIED FOR UPSTASH REDIS)
// =================================================================

async function getConfig(id, defaultValue = {}) {
    const redis = getDB();
    try {
        const data = await redis.get(`config:${id}`);
        return data ? data : defaultValue;
    } catch (e) {
        console.error(`Error in getConfig for id: ${id}`, e);
        return defaultValue;
    }
}

async function saveConfig(id, data) {
    const redis = getDB();
    try {
        await redis.set(`config:${id}`, data);
    } catch (e) {
        console.error(`Error in saveConfig for id: ${id}`, e);
    }
}

async function saveClosedTrade(tradeData) {
    const redis = getDB();
    try {
        // نستخدم قائمة (list) لتخزين تاريخ الصفقات
        await redis.lpush("tradeHistory", JSON.stringify(tradeData));
    } catch (e) {
        console.error("Error in saveClosedTrade:", e);
    }
}

async function getHistoricalPerformance(asset) {
    const redis = getDB();
    try {
        const historyRaw = await redis.lrange("tradeHistory", 0, -1);
        const history = historyRaw.map(item => JSON.parse(item)).filter(trade => trade.asset === asset);

        if (history.length === 0) {
            return { realizedPnl: 0, tradeCount: 0, winningTrades: 0, losingTrades: 0, avgDuration: 0 };
        }
        
        const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0);
        const winningTrades = history.filter(trade => trade.pnl > 0).length;
        const losingTrades = history.filter(trade => trade.pnl <= 0).length;
        const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0);
        const avgDuration = history.length > 0 ? totalDuration / history.length : 0;

        return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration };
    } catch (e) {
        console.error(`Error fetching historical performance for ${asset}:`, e);
        return null;
    }
}

async function saveVirtualTrade(tradeData) {
    const redis = getDB();
    try {
        const tradeWithId = { ...tradeData, _id: crypto.randomBytes(16).toString("hex") };
        await redis.hset("virtualTrades", { [tradeWithId._id]: JSON.stringify(tradeWithId) });
        return tradeWithId;
    } catch (e) {
        console.error("Error saving virtual trade:", e);
    }
}

async function getActiveVirtualTrades() {
    const redis = getDB();
    try {
        const allTrades = await redis.hgetall("virtualTrades");
        if (!allTrades) return [];
        return Object.values(allTrades)
            .map(item => JSON.parse(item))
            .filter(trade => trade.status === 'active');
    } catch (e) {
        console.error("Error fetching active virtual trades:", e);
        return [];
    }
}

async function updateVirtualTradeStatus(tradeId, status, finalPrice) {
    const redis = getDB();
    try {
        const tradeRaw = await redis.hget("virtualTrades", tradeId);
        if (tradeRaw) {
            const trade = JSON.parse(tradeRaw);
            trade.status = status;
            trade.closePrice = finalPrice;
            trade.closedAt = new Date();
            await redis.hset("virtualTrades", { [tradeId]: JSON.stringify(trade) });
        }
    } catch (e) {
        console.error(`Error updating virtual trade ${tradeId}:`, e);
    }
}

// Helper functions now use the new getConfig/saveConfig
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadSettings = async () => await getConfig("settings", { dailySummary: true, autoPostToChannel: false, debugMode: false });
const saveSettings = (settings) => saveConfig("settings", settings);
const loadPositions = async () => await getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);

// The rest of the bot's logic remains the same.
// All functions from here down are copied from the previous final version
// as they do not directly interact with the database.

function formatNumber(num, decimals = 2) {
    const number = parseFloat(num);
    if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals);
    return number.toFixed(decimals);
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
            if (t.instId.endsWith('-USDT')) {
                const lastPrice = parseFloat(t.last);
                const openPrice = parseFloat(t.open24h);
                let change24h = 0;
                if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice;
                prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h, volCcy24h: parseFloat(t.volCcy24h) };
            }
        });
        return prices;
    } catch (error) {
        console.error("Exception in getMarketPrices:", error.message);
        return null;
    }
}

async function getPortfolio(prices) {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) {
            return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة من المنصة'}` };
        }
        
        let assets = [], total = 0, usdtValue = 0;
        json.data[0].details.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 };
                const value = amount * priceData.price;
                total += value;

                if (asset.ccy === "USDT") {
                    usdtValue = value;
                }

                if (value >= 1) {
                    assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h });
                }
            }
        });
        
        assets.sort((a, b) => b.value - a.value);
        return { assets, total, usdtValue };
    } catch (e) {
        console.error(e);
        return { error: "خطأ في الاتصال بالمنصة." };
    }
}

async function formatPortfolioMsg(assets, total, capital) {
    const positions = await loadPositions();
    let msg = `🧾 *التقرير التحليلي للمحفظة (Upstash Build)*\n\n`;
    msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n*نظرة عامة على الأداء:*\n`;
    msg += ` ▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`;
    msg += ` ▫️ *رأس المال:* \`$${formatNumber(capital)}\`\n`;
    
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const pnlSign = pnl >= 0 ? '+' : '';
    msg += ` ▫️ *إجمالي الربح غير المحقق:* ${pnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n`;

    msg += `━━━━━━━━━━━━━━━━━━━━\n*مكونات المحفظة:*\n`;

    assets.forEach((a, index) => {
        const percent = total > 0 ? (a.value / total) * 100 : 0;
        msg += "\n";
        if (a.asset === "USDT") {
            msg += `*USDT* (الرصيد النقدي) 💵\n*القيمة:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)`;
        } else {
            msg += `╭─ *${a.asset}/USDT*\n`;
            msg += `├─ *القيمة الحالية:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)\n`;
            const position = positions[a.asset];
            if (position?.avgBuyPrice > 0) {
                const totalCost = position.avgBuyPrice * a.amount;
                const assetPnl = a.value - totalCost;
                const assetPnlPercent = totalCost > 0 ? (assetPnl / totalCost) * 100 : 0;
                msg += `├─ *متوسط الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\`\n`;
                msg += `╰─ *ربح/خسارة غير محقق:* ${assetPnl >= 0 ? '🟢' : '🔴'} \`${assetPnl >= 0 ? '+' : ''}${formatNumber(assetPnl)}\` (\`${assetPnl >= 0 ? '+' : ''}${formatNumber(assetPnlPercent)}%\`)`;
            } else {
                msg += `╰─ *متوسط الشراء:* \`غير مسجل\``;
            }
        }
        if (index < assets.length - 1) msg += `\n━━━━━━━━━━━━━━━━━━━━`;
    });
    return msg;
}

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة")
    .text("⚙️ الإعدادات").row()
    .resized();

bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        await next();
    }
});

bot.command("start", (ctx) => {
    const welcomeMessage = `🤖 *أهلاً بك في بوت OKX التحليلي.*\n\n` +
        `*الإصدار: v112 - Upstash Final Build*\n\n` +
        `هذا الإصدار يستخدم قاعدة بيانات سريعة ومستقرة. كل شيء يجب أن يعمل الآن بسلاسة.`;
    ctx.reply(welcomeMessage, { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (waitingState === 'set_capital') {
        waitingState = null;
        const amount = parseFloat(text);
        if (!isNaN(amount) && amount >= 0) {
            await saveCapital(amount);
            await ctx.reply(`✅ *تم تحديث رأس المال إلى:* \`$${formatNumber(amount)}\``, { parse_mode: "Markdown" });
        } else {
            await ctx.reply("❌ مبلغ غير صالح.");
        }
        return;
    }
    
    switch (text) {
        case "📊 عرض المحفظة":
            const loadingMsgPortfolio = await ctx.reply("⏳ جاري إعداد التقرير...");
            try {
                 const prices = await getMarketPrices();
                 if (!prices) throw new Error("فشل جلب أسعار السوق.");
                 const capital = await loadCapital();
                 const portfolioData = await getPortfolio(prices);
                 if (portfolioData.error) throw new Error(portfolioData.error);
                 const msgPortfolio = await formatPortfolioMsg(portfolioData.assets, portfolioData.total, capital);
                 await ctx.api.editMessageText(loadingMsgPortfolio.chat.id, loadingMsgPortfolio.message_id, msgPortfolio, { parse_mode: "Markdown" });
            } catch (e) {
                console.error("Error in 'عرض المحفظة':", e);
                await ctx.api.editMessageText(loadingMsgPortfolio.chat.id, loadingMsgPortfolio.message_id, `❌ حدث خطأ: ${e.message}`);
            }
            break;
        case "⚙️ الإعدادات":
             waitingState = 'set_capital'; 
             await ctx.reply("💰 يرجى إرسال المبلغ الجديد لرأس المال (رقم فقط).");
            break;
    }
});

// =================================================================
// SECTION 6: VERCEL SERVERLESS HANDLER
// =================================================================
app.use(express.json());

const handler = async (req, res) => {
    try {
        connectDB();

        if (req.url.includes('/api/bot')) {
            await bot.handleUpdate(req.body, res);
        } else {
            res.status(200).send("OKX Bot with Upstash DB is alive.");
        }
    } catch (error) {
        console.error('CRITICAL ERROR in main handler:', error);
        if (!res.headersSent) {
            res.status(500).send('An internal server error occurred.');
        }
    }
};

app.all('/api/bot', handler);
app.all('/', handler);

module.exports = app;

