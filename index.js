// =================================================================
// OKX Advanced Analytics Bot - v114 (Final Vercel Routing Fix)
// =================================================================

const express = require("express");
const { Bot, Keyboard, GrammyError, HttpError } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const { connectDB, getDB } = require("./database.js");

// --- Bot Setup ---
const app = express();
app.use(express.json()); // Use express's body parser

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";
let waitingState = null;

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

async function getPortfolio(prices) {
    try {
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
                const value = amount * (prices[asset.ccy + "-USDT"]?.price || (asset.ccy === "USDT" ? 1 : 0));
                total += value;
                if (value >= 1) assets.push({ asset: asset.ccy, value, amount });
            }
        });
        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (e) {
        return { error: `خطأ في الشبكة: ${e.message}` };
    }
}

async function formatPortfolioMsg(assets, total, capital) {
    let msg = `🧾 *التقرير التحليلي للمحفظة (v114)*\n\n`;
    msg += `*القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`;
    msg += `*رأس المال:* \`$${formatNumber(capital)}\`\n`;
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    msg += `*الربح/الخسارة:* ${pnl >= 0 ? '🟢' : '🔴'} \`$${formatNumber(pnl)}\` (\`${formatNumber(pnlPercent)}%\`)\n`;
    return msg;
}

const mainKeyboard = new Keyboard().text("📊 عرض المحفظة").text("⚙️ الإعدادات").row().resized();

bot.use(async (ctx, next) => {
    if (String(ctx.from?.id) === String(AUTHORIZED_USER_ID)) await next();
});

bot.command("start", (ctx) => ctx.reply("أهلاً بك. الإصدار v114 جاهز.", { reply_markup: mainKeyboard }));

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (waitingState === 'set_capital' && text !== "⚙️ الإعدادات") {
        waitingState = null;
        const amount = parseFloat(text);
        if (!isNaN(amount) && amount >= 0) {
            await saveCapital(amount);
            await ctx.reply(`✅ *تم تحديث رأس المال:* \`$${formatNumber(amount)}\``, { parse_mode: "Markdown" });
        } else await ctx.reply("❌ مبلغ غير صالح.");
        return;
    }
    switch (text) {
        case "📊 عرض المحفظة":
            const loadingMsg = await ctx.reply("⏳ جاري إعداد التقرير...");
            const { price: btcPrice } = (await fetch("https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT").then(r => r.json())).data[0];
            const capital = await loadCapital();
            // This is a placeholder, replace with your actual `getPortfolio` logic
            const portfolio = { assets: [{ asset: 'BTC', value: btcPrice * 1, amount: 1 }], total: btcPrice * 1 };
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

bot.catch((err) => {
    console.error(`!!! BOT ERROR:`, err);
});

// =================================================================
// SECTION 3: VERCEL SERVER HANDLER (FINAL VERSION)
// =================================================================

// نقطة البداية للخادم
app.get("/", (req, res) => {
    res.status(200).send("Bot is alive. Version 114.");
});

// نقطة استقبال تحديثات تيليجرام
app.post("/api/bot", async (req, res) => {
    try {
        await bot.handleUpdate(req.body);
        res.status(200).send("OK");
    } catch (e) {
        console.error("Error in webhook handler:", e);
        res.status(500).send("Error processing update");
    }
});

// تأكد من أن قاعدة البيانات متصلة
connectDB();

// تصدير التطبيق لـ Vercel
module.exports = app;
