// OKX Portfolio Monitor Bot (clean version, hides < $1 coins, clear buttons)

const express = require("express"); const { Bot, InlineKeyboard, webhookCallback } = require("grammy"); const fetch = require("node-fetch"); const crypto = require("crypto"); require("dotenv").config();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN); const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "0", 10); const API_BASE_URL = "https://www.okx.com"; const PORT = process.env.PORT || 3000;

let monitoring = false; let monitorInterval = null; let previousAssets = []; let baseCapital = parseFloat(process.env.BASE_CAPITAL || "0");

const app = express(); app.use(express.json());

function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const bodyString = typeof body === "object" ? JSON.stringify(body) : body; const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY) .update(timestamp + method.toUpperCase() + path + bodyString) .digest("base64"); return { "Content-Type": "application/json", "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "x-simulated-trading": "0", }; }

async function getMarketTickers() { const res = await fetch(${API_BASE_URL}/api/v5/market/tickers?instType=SPOT); const data = await res.json(); return data.code === "0" ? data.data : []; }

async function getPortfolioData() { const res = await fetch(${API_BASE_URL}/api/v5/account/balance, { headers: getHeaders("GET", "/api/v5/account/balance") }); const data = await res.json(); if (data.code !== "0") return { assets: [], totalUsd: 0 };

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
        if (usdValue >= 0.01) {
            portfolio.push({
                asset: asset.ccy,
                price,
                usdValue,
                amount
            });
        }
    }
});

const totalUsd = portfolio.reduce((acc, a) => acc + a.usdValue, 0);
portfolio.forEach(a => a.percentage = totalUsd > 0 ? (a.usdValue / totalUsd) * 100 : 0);
portfolio.sort((a, b) => b.usdValue - a.usdValue);

return { assets: portfolio, totalUsd };

}

async function showPortfolio(ctx) { const { assets, totalUsd } = await getPortfolioData(); if (!assets || assets.length === 0) return ctx.reply("❌ لا توجد بيانات محفظة حالياً.");

let msg = `📊 *ملخص المحفظة* 📊\n\n`;
msg += `💰 *القيمة الحالية:* $${totalUsd.toFixed(2)}\n`;
if (baseCapital > 0) {
    const pnl = totalUsd - baseCapital;
    const pnlPerc = (pnl / baseCapital) * 100;
    const pnlEmoji = pnl >= 0 ? "🟢" : "🔴";
    msg += `💼 *رأس المال الأساسي:* $${baseCapital.toFixed(2)}\n`;
    msg += `📈 PnL: ${pnlEmoji} ${pnl.toFixed(2)} (${pnlPerc.toFixed(2)}%)\n`;
}
msg += `------------------------------------\n`;

assets.filter(a => a.usdValue >= 1).forEach(a => {
    msg += `💎 *${a.asset}*\n`;
    if (a.asset !== "USDT") msg += `  السعر: $${a.price.toFixed(4)}\n`;
    msg += `  القيمة: $${a.usdValue.toFixed(2)} (${a.percentage.toFixed(2)}%)\n`;
    msg += `  الكمية: ${a.amount.toFixed(6)}\n\n`;
});

const cairoTime = new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
msg += `آخر تحديث: ${cairoTime}`;

await ctx.reply(msg, { parse_mode: "Markdown" });

}

async function startMonitoring(ctx) { if (monitoring) return ctx.reply("⚠️ المراقبة مفعلة بالفعل."); monitoring = true; previousAssets = (await getPortfolioData()).assets; await ctx.reply("✅ تم تشغيل مراقبة المحفظة.");

monitorInterval = setInterval(async () => {
    const { assets } = await getPortfolioData();
    if (!assets) return;
    const changes = [];

    assets.forEach(a => {
        const prev = previousAssets.find(pa => pa.asset === a.asset);
        if (prev) {
            const diff = a.amount - prev.amount;
            if (Math.abs(diff * a.price) >= 1) {
                const action = diff > 0 ? "🟢 شراء" : "🔴 بيع";
                changes.push(`${action}: ${a.asset} - ${Math.abs(diff).toFixed(4)}`);
            }
        } else if (a.usdValue >= 1) {
            changes.push(`🟢 شراء جديد: ${a.asset} - ${a.amount.toFixed(4)}`);
        }
    });

    previousAssets.forEach(pa => {
        const curr = assets.find(a => a.asset === pa.asset);
        if (!curr && pa.usdValue >= 1) {
            changes.push(`🔴 بيع كامل: ${pa.asset} - ${pa.amount.toFixed(4)}`);
        }
    });

    previousAssets = assets;

    if (changes.length > 0) {
        await bot.api.sendMessage(AUTHORIZED_USER_ID, `📈 *حركة الصفقات*:\n\n${changes.join("\n")}`, { parse_mode: "Markdown" });
    }
}, 300000); // كل 5 دقائق

}

async function stopMonitoring(ctx) { if (!monitoring) return ctx.reply("ℹ️ المراقبة متوقفة بالفعل."); clearInterval(monitorInterval); monitoring = false; await ctx.reply("🛑 تم إيقاف مراقبة المحفظة."); }

bot.command("start", ctx => ctx.reply( "🤖 مرحباً بك في بوت مراقبة محفظة OKX.\n\n" + "- /portfolio لعرض المحفظة.\n" + "- /startmonitor لتفعيل المراقبة.\n" + "- /stopmonitor لإيقاف المراقبة.\n" + "- /setcapital 5000 لتحديد رأس المال لحساب PnL.", ));

bot.command("portfolio", showPortfolio); bot.command("startmonitor", startMonitoring); bot.command("stopmonitor", stopMonitoring); bot.command("setcapital", async ctx => { const value = parseFloat(ctx.message.text.split(" ")[1]); if (isNaN(value) || value <= 0) { await ctx.reply("❌ برجاء إدخال رقم صحيح."); } else { baseCapital = value; await ctx.reply(✅ تم تحديث رأس المال إلى: $${baseCapital.toFixed(2)}); } });

bot.use(async (ctx, next) => { if (ctx.from?.id !== AUTHORIZED_USER_ID) return; await next(); });

const webhook = webhookCallback(bot, "express"); app.use(webhook); app.listen(PORT, () => console.log(✅ Bot running on port ${PORT}));

