// =================================================================
// OKX Advanced Analytics Bot - v113 (Final Debug Build with Error Catcher)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, GrammyError, HttpError } = require("grammy");
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
// !! FINAL DIAGNOSTIC STEP: CATCH ALL SILENT ERRORS !!
// =================================================================
bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
    console.error(`!!! ERROR WHILE HANDLING UPDATE ${ctx.update.update_id}:`);
    console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
    
    const e = err.error;

    if (e instanceof GrammyError) {
        console.error("Error in request:", e.description);
    } else if (e instanceof HttpError) {
        console.error("Could not contact Telegram:", e);
    } else {
        console.error("Unknown error in bot logic:", e);
    }
    console.error(`!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!`);
});


// =================================================================
// SECTION 1: DATABASE AND HELPER FUNCTIONS (UPSTASH REDIS)
// =================================================================

async function getConfig(id, defaultValue = {}) {
    const redis = getDB();
    const data = await redis.get(`config:${id}`);
    return data ? data : defaultValue;
}

async function saveConfig(id, data) {
    const redis = getDB();
    await redis.set(`config:${id}`, data);
}

const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadPositions = async () => await getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);

// =================================================================
// SECTION 2: API AND FORMATTING FUNCTIONS
// =================================================================

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
    const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
    const tickersJson = await tickersRes.json();
    if (tickersJson.code !== '0') {
        console.error("Failed to fetch market prices (OKX Error):", tickersJson.msg);
        return null;
    }
    const prices = {};
    tickersJson.data.forEach(t => {
        if (t.instId.endsWith('-USDT')) {
            prices[t.instId] = { price: parseFloat(t.last) };
        }
    });
    return prices;
}

async function getPortfolio(prices) {
    const path = "/api/v5/account/balance";
    const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
    const json = await res.json();
    if (json.code !== '0' || !json.data?.[0]?.details) {
        return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة'}` };
    }
    
    let assets = [], total = 0;
    json.data[0].details.forEach(asset => {
        const amount = parseFloat(asset.eq);
        if (amount > 0) {
            const instId = `${asset.ccy}-USDT`;
            const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0) };
            const value = amount * priceData.price;
            total += value;
            if (value >= 1) {
                assets.push({ asset: asset.ccy, value, amount });
            }
        }
    });
    
    assets.sort((a, b) => b.value - a.value);
    return { assets, total };
}

async function formatPortfolioMsg(assets, total, capital) {
    const positions = await loadPositions();
    let msg = `🧾 *التقرير التحليلي للمحفظة (v113)*\n\n`;
    msg += `*القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`;
    msg += `*رأس المال:* \`$${formatNumber(capital)}\`\n`;
    
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const pnlSign = pnl >= 0 ? '+' : '';
    msg += `*الربح/الخسارة غير المحقق:* ${pnl >= 0 ? '🟢' : '🔴'} \`${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n`;
    msg += `\n*مكونات المحفظة:*\n`;

    assets.forEach(a => {
        const percent = total > 0 ? (a.value / total) * 100 : 0;
        msg += `\n*${a.asset}* - \`$${formatNumber(a.value)}\` (${formatNumber(percent)}%)`;
        const position = positions[a.asset];
        if (position?.avgBuyPrice > 0) {
            const assetPnl = (a.value - (position.avgBuyPrice * a.amount));
            const assetPnlPercent = (position.avgBuyPrice * a.amount) > 0 ? (assetPnl / (position.avgBuyPrice * a.amount)) * 100 : 0;
            msg += `\n  *م. الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\` | *الربح:* \`${formatNumber(assetPnlPercent)}%\``;
        }
    });
    return msg;
}

// =================================================================
// SECTION 3: BOT HANDLERS
// =================================================================

const mainKeyboard = new Keyboard().text("📊 عرض المحفظة").text("⚙️ الإعدادات").row().resized();

bot.use(async (ctx, next) => {
    if (String(ctx.from?.id) === String(AUTHORIZED_USER_ID)) {
        await next();
    } else {
        console.log(`Unauthorized access from ID: ${ctx.from?.id}`);
    }
});

bot.command("start", (ctx) => {
    ctx.reply("أهلاً بك. الإصدار v113 جاهز للاختبار.", { reply_markup: mainKeyboard });
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;

    if (waitingState === 'set_capital') {
        waitingState = null;
        const amount = parseFloat(text);
        if (!isNaN(amount) && amount >= 0) {
            await saveCapital(amount);
            await ctx.reply(`✅ *تم تحديث رأس المال:* \`$${formatNumber(amount)}\``, { parse_mode: "Markdown" });
        } else {
            await ctx.reply("❌ مبلغ غير صالح.");
        }
        return;
    }
    
    switch (text) {
        case "📊 عرض المحفظة":
            const loadingMsg = await ctx.reply("⏳ جاري إعداد التقرير...");
            const prices = await getMarketPrices();
            if (!prices) {
                await ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, "❌ فشل جلب أسعار السوق.");
                return;
            }
            const capital = await loadCapital();
            const portfolio = await getPortfolio(prices);
            if (portfolio.error) {
                await ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, `❌ ${portfolio.error}`);
                return;
            }
            const msg = await formatPortfolioMsg(portfolio.assets, portfolio.total, capital);
            await ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, msg, { parse_mode: "Markdown" });
            break;
        case "⚙️ الإعدادات":
             waitingState = 'set_capital'; 
             await ctx.reply("💰 يرجى إرسال المبلغ الجديد لرأس المال (رقم فقط).");
            break;
    }
});

// =================================================================
// SECTION 4: VERCEL SERVERLESS HANDLER
// =================================================================
app.use(express.json());

// Initialize DB connection when the serverless function starts
connectDB();

app.post("/api/bot", async (req, res) => {
    try {
        await bot.handleUpdate(req.body, res);
    } catch (e) {
        console.error("CRITICAL ERROR in webhook processing:", e);
        if (!res.headersSent) {
            res.status(500).send("Webhook processing error");
        }
    }
});

app.get("/", (req, res) => {
    res.status(200).send("OKX Bot v113 is alive.");
});

module.exports = app;
