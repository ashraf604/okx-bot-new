const express = require("express");
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();

// إعدادات
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN || "");
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "0", 10);
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

let isMonitoring = false;
let monitoringInterval = null;
let previousPortfolioState = {};
let capital = parseFloat(process.env.DEFAULT_CAPITAL || "0");

// أدوات التوقيع
function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const bodyString = typeof body === 'object' ? JSON.stringify(body) : body;
    const signString = timestamp + method.toUpperCase() + path + bodyString;
    const signature = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(signString).digest("base64");
    return {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": process.env.OKX_API_KEY,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE
    };
}

// جلب أسعار السوق
async function getMarketTickers() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const data = await res.json();
        return data.code === "0" ? data.data : [];
    } catch (e) {
        console.error("Error fetching market tickers:", e);
        return [];
    }
}

// جلب بيانات المحفظة
async function getPortfolioData() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, { headers: getHeaders("GET", "/api/v5/account/balance") });
        const data = await res.json();
        if (data.code !== "0") return { assets: null, totalUsd: 0 };

        const tickers = await getMarketTickers();
        const prices = {};
        tickers.forEach(t => { prices[t.instId] = parseFloat(t.last); });

        const portfolio = [];
        data.data[0].details.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0);
                const usdValue = amount * price;
                if (usdValue >= 0.01) {
                    portfolio.push({ asset: asset.ccy, price, usdValue, amount });
                }
            }
        });

        const totalUsd = portfolio.reduce((sum, a) => sum + a.usdValue, 0);
        portfolio.forEach(a => { a.percentage = totalUsd > 0 ? ((a.usdValue / totalUsd) * 100) : 0; });
        portfolio.sort((a, b) => b.usdValue - a.usdValue);

        return { assets: portfolio, totalUsd };
    } catch (e) {
        console.error("Error fetching portfolio:", e);
        return { assets: null, totalUsd: 0 };
    }
}

// عرض المحفظة
async function showPortfolio(ctx) {
    const { assets, totalUsd } = await getPortfolioData();
    if (!assets) return ctx.reply("❌ حدث خطأ أثناء جلب بيانات المحفظة.");

    let msg = `📊 *ملخص المحفظة* 📊\n\n`;
    msg += `💰 *القيمة الحالية:* $${totalUsd.toFixed(2)}\n`;

    if (capital > 0) {
        const pnl = totalUsd - capital;
        const pnlPercent = (pnl / capital) * 100;
        const pnlEmoji = pnl >= 0 ? "🟢" : "🔴";
        msg += `💼 *رأس المال الأساسي:* $${capital.toFixed(2)}\n`;
        msg += `📈 *PnL:* ${pnlEmoji} ${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\n`;
    }

    msg += `------------------------------------\n`;
    assets.forEach(a => {
        msg += `💎 *${a.asset}*\n`;
        if (a.asset !== "USDT") msg += `  السعر: $${a.price.toFixed(4)}\n`;
        msg += `  القيمة: $${a.usdValue.toFixed(2)} (${a.percentage.toFixed(2)}%)\n`;
        msg += `  الكمية: ${a.amount.toFixed(6)}\n\n`;
    });

    msg += `_آخر تحديث: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}_`;

    ctx.reply(msg, { parse_mode: "Markdown" });
}

// مقارنة الصفقات
function checkTrades(currentAssets, previousAssets) {
    const notifications = [];
    const prevMap = new Map(previousAssets.map(a => [a.asset, a]));

    currentAssets.forEach(a => {
        const prev = prevMap.get(a.asset);
        if (!prev && a.usdValue >= 1) {
            notifications.push(`🟢 *شراء جديد:* ${a.amount.toFixed(4)} ${a.asset}`);
        } else if (prev) {
            const diff = a.amount - prev.amount;
            if (Math.abs(diff) * a.price > 1) {
                const action = diff > 0 ? "🔵 شراء إضافي" : "🟠 بيع جزئي";
                notifications.push(`${action}: ${Math.abs(diff).toFixed(4)} ${a.asset}`);
            }
            prevMap.delete(a.asset);
        }
    });

    prevMap.forEach(prev => {
        if (prev.usdValue >= 1) {
            notifications.push(`🔴 *بيع كامل:* ${prev.amount.toFixed(4)} ${prev.asset}`);
        }
    });

    return notifications.length > 0 ? `🔄 *حركة الصفقات:* 🔄\n\n${notifications.join('\n')}` : null;
}

// بدء المراقبة
async function startMonitoring(ctx) {
    if (isMonitoring) return ctx.reply("⚠️ المراقبة مفعلة بالفعل.");
    isMonitoring = true;
    ctx.reply("✅ تم بدء مراقبة المحفظة والصفقات.");

    const initialState = await getPortfolioData();
    if (!initialState.assets) {
        isMonitoring = false;
        return ctx.reply("❌ فشل بدء المراقبة.");
    }
    previousPortfolioState = initialState;

    monitoringInterval = setInterval(async () => {
        const current = await getPortfolioData();
        if (!current.assets) return;
        const notification = checkTrades(current.assets, previousPortfolioState.assets);
        if (notification) {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, notification, { parse_mode: "Markdown" });
        }
        previousPortfolioState = current;
    }, 60000);
}

// إيقاف المراقبة
async function stopMonitoring(ctx) {
    if (!isMonitoring) return ctx.reply("ℹ️ المراقبة متوقفة بالفعل.");
    clearInterval(monitoringInterval);
    isMonitoring = false;
    ctx.reply("🛑 تم إيقاف مراقبة المحفظة.");
}

// تغيير رأس المال
bot.command("setcapital", async (ctx) => {
    const parts = ctx.message.text.split(" ");
    if (parts.length !== 2) return ctx.reply("⚠️ الاستخدام: /setcapital 5000");
    const value = parseFloat(parts[1]);
    if (isNaN(value) || value <= 0) return ctx.reply("⚠️ الرجاء إدخال رقم صحيح.");
    capital = value;
    ctx.reply(`✅ تم تعيين رأس المال الأساسي إلى $${capital.toFixed(2)}.`);
});

// الأوامر
bot.command("start", async (ctx) => {
    const keyboard = new InlineKeyboard()
        .text("📊 عرض المحفظة", "show_portfolio").row()
        .text("✅ بدء المراقبة", "start_monitor").text("🛑 إيقاف المراقبة", "stop_monitor");
    await ctx.reply(
        `🤖 *أهلاً بك في بوت مراقبة محفظة OKX.*\n\n- /portfolio لعرض المحفظة.\n- /startmonitor لتفعيل المراقبة.\n- /stopmonitor لإيقاف المراقبة.\n- /setcapital [المبلغ] لتحديد رأس المال لحساب PnL.`,
        { parse_mode: "Markdown", reply_markup: keyboard }
    );
});

bot.command("portfolio", showPortfolio);
bot.command("startmonitor", startMonitoring);
bot.command("stopmonitor", stopMonitoring);

bot.on("callback_query:data", async ctx => {
    await ctx.answerCallbackQuery();
    const d = ctx.callbackQuery.data;
    if (d === "show_portfolio") await showPortfolio(ctx);
    if (d === "start_monitor") await startMonitoring(ctx);
    if (d === "stop_monitor") await stopMonitoring(ctx);
});

bot.catch(err => console.error("--- BOT ERROR ---", err));
app.use(webhookCallback(bot, "express"));

app.listen(PORT, () => {
    console.log(`🚀 Bot is running on port ${PORT}`);
});
