// index.js - النسخة النهائية المستقرة

const express = require("express");
const { Bot, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// حساب رأس المال الأساسي تلقائي
let baseCapital = 0;

function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const sign = timestamp + method + path + body;
    const signature = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY)
        .update(sign)
        .digest("base64");
    return {
        "Content-Type": "application/json",
        "OK-ACCESS-KEY": process.env.OKX_API_KEY,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
    };
}

async function getPortfolio() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, {
            headers: getHeaders("GET", "/api/v5/account/balance")
        });
        const data = await res.json();
        if (data.code !== "0") return null;
        return data.data[0];
    } catch (e) {
        console.error(e);
        return null;
    }
}

async function getMarketPrices() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const data = await res.json();
        if (data.code !== "0") return {};
        const prices = {};
        data.data.forEach(t => prices[t.instId] = parseFloat(t.last));
        return prices;
    } catch (e) {
        console.error(e);
        return {};
    }
}

bot.command("start", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply("🤖 مرحبًا بك! ارسل /portfolio لعرض محفظتك مع PnL.");
});

bot.command("portfolio", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply("⏳ جارٍ جلب بيانات المحفظة...");

    const portfolio = await getPortfolio();
    const prices = await getMarketPrices();
    if (!portfolio) return ctx.reply("❌ تعذر جلب البيانات.");

    let totalUsd = 0;
    const assets = [];
    for (const asset of portfolio.details) {
        const amount = parseFloat(asset.eq);
        if (amount <= 0) continue;
        const instId = `${asset.ccy}-USDT`;
        const price = asset.ccy === "USDT" ? 1 : prices[instId] || 0;
        const usdValue = amount * price;
        if (usdValue < 0.5) continue;
        totalUsd += usdValue;
        assets.push({
            ccy: asset.ccy,
            price,
            usdValue,
            amount
        });
    }
    assets.sort((a, b) => b.usdValue - a.usdValue);

    if (baseCapital === 0) baseCapital = totalUsd;
    const pnl = totalUsd - baseCapital;
    const pnlPercent = ((pnl / baseCapital) * 100).toFixed(2);

    let msg = `*📊 ملخص المحفظة 📊*\n\n`;
    msg += `💰 *القيمة الحالية:* $${totalUsd.toFixed(2)}\n`;
    msg += `💼 *رأس المال الأساسي:* $${baseCapital.toFixed(2)}\n`;
    msg += `📈 *PnL:* $${pnl.toFixed(2)} (${pnlPercent}%)\n`;
    msg += `------------------------------------\n`;
    assets.forEach(a => {
        msg += `💎 *${a.ccy}*\n`;
        if (a.ccy !== "USDT") msg += `  السعر: $${a.price.toFixed(4)}\n`;
        msg += `  القيمة: $${a.usdValue.toFixed(2)}\n`;
        msg += `  الكمية: ${a.amount}\n\n`;
    });
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

app.use(express.json());
app.use(webhookCallback(bot, "express"));
app.listen(PORT, () => console.log("✅ Bot is running on port " + PORT));

