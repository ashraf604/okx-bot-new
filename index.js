// OKX Portfolio Bot with Trade Monitoring, PnL, Capital Setting, Egypt TZ, and Clean Structure

const express = require("express");
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";
const CAPITAL_FILE = "capital.json";
let monitoring = false;
let lastTrades = {};

// Egypt Timezone
function getEgyptTime() {
    return new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" });
}

// Save and Load Capital
function saveCapital(amount) {
    fs.writeFileSync(CAPITAL_FILE, JSON.stringify({ capital: amount }));
}
function loadCapital() {
    try {
        const data = JSON.parse(fs.readFileSync(CAPITAL_FILE));
        return data.capital;
    } catch {
        return 0;
    }
}

// OKX Headers
function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + path + body;
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY)
        .update(prehash).digest("base64");
    return {
        "OK-ACCESS-KEY": process.env.OKX_API_KEY,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
        "Content-Type": "application/json",
    };
}

// Get Portfolio Data
async function getPortfolio() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, {
            headers: getHeaders("GET", "/api/v5/account/balance")
        });
        const json = await res.json();
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        const prices = {};
        tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last));

        let assets = [];
        let total = 0;

        json.data[0].details.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0);
                const value = amount * price;
                if (value >= 1) {
                    assets.push({ asset: asset.ccy, price, value, amount });
                    total += value;
                }
            }
        });

        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (e) {
        console.error(e);
        return { assets: [], total: 0 };
    }
}

// Format Portfolio Message
function formatPortfolioMsg(assets, total, capital) {
    let pnl = capital > 0 ? total - capital : 0;
    let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;

    let msg = `📊 *ملخص المحفظة* 📊\n\n`;
    msg += `💰 *القيمة الحالية:* $${total.toFixed(2)}\n`;
    msg += `💼 *رأس المال الأساسي:* $${capital.toFixed(2)}\n`;
    msg += `📈 *PnL:* ${pnl >= 0 ? '🟢' : '🔴'} ${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\n`;
    msg += `------------------------------------\n`;

    assets.forEach(a => {
        msg += `💎 *${a.asset}*\n`;
        if (a.asset !== "USDT") msg += `  السعر: $${a.price.toFixed(4)}\n`;
        msg += `  القيمة: $${a.value.toFixed(2)}\n`;
        msg += `  الكمية: ${a.amount}\n\n`;
    });

    msg += `🕒 *آخر تحديث:* ${getEgyptTime()}`;
    return msg;
}

// Trade Monitoring
async function checkNewTrades() {
    if (!monitoring) return;

    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/transactions?type=1`, {
            headers: getHeaders("GET", "/api/v5/account/transactions?type=1")
        });
        const json = await res.json();

        if (json.code !== '0') {
            console.error("Error fetching trades:", json);
            return;
        }

        let trades = json.data;
        trades.forEach(async trade => {
            if (!lastTrades[trade.instId] || trade.fillTime > lastTrades[trade.instId]) {
                lastTrades[trade.instId] = trade.fillTime;
                const msg = `📈 *صفقة جديدة*\n\n💎 *${trade.instId}*\n🪙 *الكمية:* ${trade.fillSz}\n💰 *السعر:* ${trade.fillPx}\n🕒 *${getEgyptTime()}*`;
                await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
            }
        });
    } catch (e) {
        console.error("Trade check error:", e);
    }
}

// Commands
bot.command("start", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const keyboard = new InlineKeyboard()
        .text("📊 عرض المحفظة", "refresh")
        .text(monitoring ? "🛑 إيقاف المراقبة" : "✅ تفعيل المراقبة", "toggle_monitor")
        .row()
        .text("⚙️ تعيين رأس المال", "set_capital");
    await ctx.reply("🤖 *أهلاً بك في بوت مراقبة محفظة OKX*\n\n- اختر من الأزرار أدناه.", {
        parse_mode: "Markdown",
        reply_markup: keyboard
    });
});

bot.callbackQuery("refresh", async ctx => {
    await ctx.answerCallbackQuery();
    const { assets, total } = await getPortfolio();
    const capital = loadCapital();
    const msg = formatPortfolioMsg(assets, total, capital);
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.callbackQuery("toggle_monitor", async ctx => {
    monitoring = !monitoring;
    await ctx.answerCallbackQuery({ text: monitoring ? "✅ تم تشغيل المراقبة." : "🛑 تم إيقاف المراقبة." });
    if (monitoring) {
        setInterval(checkNewTrades, 30000); // فحص الصفقات كل 30 ثانية
    }
});

bot.callbackQuery("set_capital", async ctx => {
    await ctx.answerCallbackQuery();
    await ctx.reply("📥 أرسل لي المبلغ الذي تريد تعيينه كـ رأس المال.\nمثال: 5000");
    bot.on("message:text", async ctx2 => {
        if (ctx2.from.id !== AUTHORIZED_USER_ID) return;
        const amount = parseFloat(ctx2.message.text);
        if (!isNaN(amount) && amount > 0) {
            saveCapital(amount);
            await ctx2.reply(`✅ تم تعيين رأس المال إلى: $${amount.toFixed(2)}`);
        } else {
            await ctx2.reply("❌ المبلغ غير صالح، حاول مرة أخرى.");
        }
    });
});

// Webhook or polling
app.use(express.json());
app.use(webhookCallback(bot, "express"));

app.listen(PORT, async () => {
    console.log(`✅ Bot running on port ${PORT}`);
    const domain = process.env.RAILWAY_STATIC_URL;
    if (domain) {
        await bot.api.setWebhook(`https://${domain}/${bot.token}`);
        console.log(`✅ Webhook set to: https://${domain}/${bot.token}`);
    } else {
        bot.start();
    }
});
