// =================================================================
// OKX Advanced Analytics Bot - v116 (Final Webhook Handler Fix)
// =================================================================

const express = require("express");
const { Bot, Keyboard, GrammyError, HttpError, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const { connectDB, getDB } = require("./database.js");

// --- Bot Setup ---
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID;
const API_BASE_URL = "https://www.okx.com";
let waitingState = null;

// =================================================================
// SECTION 1: DATABASE AND HELPER FUNCTIONS (UPSTASH REDIS)
// =================================================================

async function getConfig(id, defaultValue = {}) {
    try {
        const redis = getDB();
        const data = await redis.get(`config:${id}`);
        return data ? data : defaultValue;
    } catch (e) {
        console.error(`DB Error in getConfig for id: ${id}`, e);
        return defaultValue;
    }
}

async function saveConfig(id, data) {
    try {
        const redis = getDB();
        await redis.set(`config:${id}`, data);
    } catch (e) {
        console.error(`DB Error in saveConfig for id: ${id}`, e);
    }
}

const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });

// =================================================================
// SECTION 2: API, FORMATTING, AND BOT LOGIC
// =================================================================

function formatNumber(num, decimals = 2) {
    const number = parseFloat(num);
    return !isNaN(number) ? number.toFixed(decimals) : (0).toFixed(decimals);
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
        const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const json = await res.json();
        if (json.code !== '0' || !json.data) {
            throw new Error(`OKX API Error for prices: ${json.msg || 'No data'}`);
        }
        const prices = {};
        json.data.forEach(t => {
            if (t.instId.endsWith('-USDT')) {
                prices[t.instId] = { price: parseFloat(t.last) };
            }
        });
        return prices;
    } catch (e) {
        console.error("Exception in getMarketPrices:", e);
        return null;
    }
}

async function getPortfolio(prices) {
    try {
        if (!prices) {
            throw new Error("Market prices are not available for portfolio calculation.");
        }
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
                const priceData = prices[instId];
                const price = priceData ? priceData.price : (asset.ccy === "USDT" ? 1 : 0);
                const value = amount * price;
                total += value;
                if (value >= 1) {
                    assets.push({ asset: asset.ccy, value, amount });
                }
            }
        });
        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (e) {
        console.error("Exception in getPortfolio:", e);
        return { error: `خطأ في الشبكة عند جلب المحفظة.` };
    }
}

async function formatPortfolioMsg(assets, total, capital) {
    let msg = `🧾 *التقرير التحليلي للمحفظة (v116)*\n\n`;
    msg += `*القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`;
    msg += `*رأس المال:* \`$${formatNumber(capital)}\`\n`;
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const pnlSign = pnl >= 0 ? '+' : '';
    msg += `*الربح/الخسارة:* ${pnl >= 0 ? '🟢' : '🔴'} \`${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n`;
    msg += `\n*مكونات المحفظة:*\n`;
    assets.forEach(a => {
        const percent = total > 0 ? (a.value / total) * 100 : 0;
        msg += `\n*${a.asset}* - \`$${formatNumber(a.value)}\` (${formatNumber(percent)}%)`;
    });
    return msg;
}

const mainKeyboard = new Keyboard().text("📊 عرض المحفظة").text("⚙️ الإعدادات").row().resized();

bot.use(async (ctx, next) => {
    if (String(ctx.from?.id) === String(AUTHORIZED_USER_ID)) {
        await next();
    } else {
        console.log(`Unauthorized access attempt from ID: ${ctx.from?.id}`);
    }
});

bot.command("start", (ctx) => ctx.reply("أهلاً بك. الإصدار النهائي v116 جاهز.", { reply_markup: mainKeyboard }));

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (waitingState === 'set_capital' && text !== "⚙️ الإعدادات") {
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
            try {
                const prices = await getMarketPrices();
                if (!prices) {
                    return ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, "❌ فشل جلب أسعار السوق.");
                }
                const capital = await loadCapital();
                const portfolio = await getPortfolio(prices);
                if (portfolio.error) {
                    return ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, `❌ ${portfolio.error}`);
                }
                const msg = await formatPortfolioMsg(portfolio.assets, portfolio.total, capital);
                await ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, msg, { parse_mode: "Markdown" });
            } catch(e) {
                 console.error("Error in 'عرض المحفظة' handler:", e);
                 await ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, "❌ حدث خطأ داخلي أثناء عرض المحفظة.");
            }
            break;
        case "⚙️ الإعدادات":
            waitingState = 'set_capital';
            await ctx.reply("💰 يرجى إرسال المبلغ الجديد لرأس المال (رقم فقط).");
            break;
    }
});

bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`--- BOT ERROR ---`);
    console.error(`Update ID: ${ctx.update.update_id}`);
    console.error(err.error);
    console.error(`--- END BOT ERROR ---`);
});

// =================================================================
// SECTION 3: VERCEL SERVER HANDLER (ROBUST VERSION)
// =================================================================
const app = express();
app.use(express.json());

// Initialize DB connection once.
connectDB();

// The official, recommended way to handle webhooks with express
const webhookHandler = webhookCallback(bot, "express");

app.post("/api/bot", webhookHandler);

app.get("/", (req, res) => {
    res.status(200).send("Bot v116 is alive and webhook is ready.");
});

// General error handler for express
app.use((err, req, res, next) => {
    console.error("--- EXPRESS ERROR ---", err);
    if (!res.headersSent) {
        res.status(500).send("Something broke!");
    }
});

module.exports = app;
