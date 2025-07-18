const express = require("express");
const { Bot, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();

const requiredEnv = ["TELEGRAM_BOT_TOKEN", "OKX_API_KEY", "OKX_API_SECRET_KEY", "OKX_API_PASSPHRASE", "AUTHORIZED_USER_ID"];
for (const envVar of requiredEnv) {
    if (!process.env[envVar]) {
        console.error(`!!! متغير البيئة ${envVar} غير موجود.`);
    }
}

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID, 10);
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());

let isMonitoring = false;
let monitoringInterval = null;
let previousPortfolioState = [];

function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const bodyString = typeof body === "object" ? JSON.stringify(body) : body;
    const signString = timestamp + method.toUpperCase() + path + bodyString;
    const signature = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY)
        .update(signString)
        .digest("base64");
    return {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": process.env.OKX_API_KEY,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
    };
}

async function getMarketTickers() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const data = await res.json();
        return data.code === "0" ? data.data : [];
    } catch (e) {
        console.error("Error fetching tickers:", e);
        return [];
    }
}

async function getPortfolioData() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, {
            headers: getHeaders("GET", "/api/v5/account/balance"),
        });
        const data = await res.json();
        if (data.code !== "0") return { assets: null, totalUsd: 0 };

        const tickers = await getMarketTickers();
        const prices = {};
        tickers.forEach(t => prices[t.instId] = parseFloat(t.last));

        const portfolio = [];
        data.data[0].details.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0);
                const usdValue = amount * price;
                if (usdValue >= 1) {
                    portfolio.push({
                        asset: asset.ccy,
                        instId,
                        amount,
                        usdValue,
                        price,
                    });
                }
            }
        });

        const totalUsd = portfolio.reduce((sum, a) => sum + a.usdValue, 0);
        portfolio.forEach(a => {
            a.percentage = totalUsd > 0 ? ((a.usdValue / totalUsd) * 100) : 0;
        });
        portfolio.sort((a, b) => b.usdValue - a.usdValue);

        return { assets: portfolio, totalUsd };
    } catch (e) {
        console.error("Error fetching portfolio:", e);
        return { assets: null, totalUsd: 0 };
    }
}

async function showBalance(ctx) {
    await ctx.reply("🔄 جارٍ تحديث المحفظة...");
    const { assets, totalUsd } = await getPortfolioData();
    if (!assets) return ctx.reply("❌ تعذر جلب بيانات المحفظة حالياً.");

    let msg = `*📊 ملخص المحفظة 📊*\n\n`;
    msg += `💰 *القيمة الحالية:* $${totalUsd.toFixed(2)}\n`;
    msg += `------------------------------------\n`;

    assets.forEach(a => {
        msg += `💎 *${a.asset}*\n`;
        if (a.asset !== "USDT") msg += `  السعر: $${a.price.toFixed(4)}\n`;
        msg += `  القيمة: $${a.usdValue.toFixed(2)} (${a.percentage.toFixed(2)}%)\n`;
        msg += `  الكمية: ${a.amount.toFixed(6)}\n\n`;
    });

    msg += `_آخر تحديث: ${new Date().toLocaleString("ar-EG")}_`;

    ctx.reply(msg, { parse_mode: "Markdown" });
}

function checkTrades(currentAssets, previousAssets) {
    const notifications = [];
    const prevMap = new Map(previousAssets.map(a => [a.asset, a]));

    for (const curr of currentAssets) {
        const prev = prevMap.get(curr.asset);
        if (!prev) {
            notifications.push(`🟢 *شراء جديد:* ${curr.amount.toFixed(4)} ${curr.asset}`);
        } else {
            const change = curr.amount - prev.amount;
            if (Math.abs(change) * curr.price > 1) {
                const action = change > 0 ? "🔵 شراء إضافي" : "🟠 بيع جزئي";
                notifications.push(`${action}: ${Math.abs(change).toFixed(4)} ${curr.asset}`);
            }
            prevMap.delete(curr.asset);
        }
    }

    for (const sold of prevMap.values()) {
        notifications.push(`🔴 *بيع كامل:* ${sold.amount.toFixed(4)} ${sold.asset}`);
    }

    return notifications.length ? `*🔔 إشعار الصفقات 🔔*\n\n${notifications.join("\n")}` : null;
}

async function startMonitoring(ctx) {
    if (isMonitoring) return ctx.reply("⚠️ المراقبة مفعلة بالفعل.");
    isMonitoring = true;
    ctx.reply("✅ تم تشغيل مراقبة صفقاتك تلقائياً.");

    const initial = await getPortfolioData();
    if (!initial.assets) {
        isMonitoring = false;
        return ctx.reply("❌ تعذر بدء المراقبة.");
    }
    previousPortfolioState = initial.assets;

    monitoringInterval = setInterval(async () => {
        const current = await getPortfolioData();
        if (!current.assets) return;
        const notification = checkTrades(current.assets, previousPortfolioState);
        if (notification) {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, notification, { parse_mode: "Markdown" });
        }
        previousPortfolioState = current.assets;
    }, 60000);
}

async function stopMonitoring(ctx) {
    if (!isMonitoring) return ctx.reply("ℹ️ المراقبة متوقفة بالفعل.");
    clearInterval(monitoringInterval);
    isMonitoring = false;
    ctx.reply("🛑 تم إيقاف المراقبة.");
}

bot.command("start", ctx => {
    const keyboard = new InlineKeyboard()
        .text("📊 عرض المحفظة", "balance")
        .text("🚦 بدء المراقبة", "monitor")
        .text("🛑 إيقاف المراقبة", "stop");

    ctx.reply("*🤖 مرحباً بك في بوت مراقبة محفظة OKX.*\nاختر من الأزرار:", {
        parse_mode: "Markdown",
        reply_markup: keyboard,
    });
});

bot.on("callback_query:data", async ctx => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();
    if (data === "balance") await showBalance(ctx);
    if (data === "monitor") await startMonitoring(ctx);
    if (data === "stop") await stopMonitoring(ctx);
});

bot.command("balance", showBalance);
bot.command("monitor", startMonitoring);
bot.command("stop", stopMonitoring);

bot.catch(err => console.error(err));
app.use(webhookCallback(bot, "express"));
app.listen(PORT, () => console.log(`🚀 Bot server running on ${PORT}`));
