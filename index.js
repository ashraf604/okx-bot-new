// okx_profit_tracker/index.js

const express = require("express"); const { Bot, InlineKeyboard, webhookCallback } = require("grammy"); const fetch = require("node-fetch"); const crypto = require("crypto"); const fs = require("fs"); require("dotenv").config();

// --- إعدادات أساسية --- const requiredEnv = ["TELEGRAM_BOT_TOKEN", "OKX_API_KEY", "OKX_API_SECRET_KEY", "OKX_API_PASSPHRASE", "AUTHORIZED_USER_ID", "RAILWAY_STATIC_URL"]; for (const envVar of requiredEnv) { if (!process.env[envVar]) { console.error(!!! متغير البيئة ${envVar} غير موجود.); } }

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN || ""); const API_BASE_URL = "https://www.okx.com"; const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "0", 10); const PORT = process.env.PORT || 3000; const SETTINGS_FILE = "settings.json"; const app = express(); app.use(express.json());

// --- تحميل رأس المال الأساسي --- function loadBaseCapital() { try { const data = fs.readFileSync(SETTINGS_FILE, "utf-8"); const json = JSON.parse(data); return json.baseCapital || null; } catch (e) { return null; } }

function saveBaseCapital(amount) { const data = { baseCapital: amount }; fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data)); }

// --- دوال OKX API --- function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const bodyString = typeof body === 'object' ? JSON.stringify(body) : body; const signString = timestamp + method.toUpperCase() + path + bodyString; const signature = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(signString).digest("base64"); return { "Content-Type": "application/json", "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": signature, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "x-simulated-trading": "0" }; }

async function getMarketTickers() { try { const res = await fetch(${API_BASE_URL}/api/v5/market/tickers?instType=SPOT); const data = await res.json(); return (data.code === "0" && data.data) ? data.data : []; } catch (e) { console.error("Error fetching market tickers:", e); return []; } }

async function getPortfolioData() { try { const res = await fetch(${API_BASE_URL}/api/v5/account/balance, { headers: getHeaders("GET", "/api/v5/account/balance") }); const data = await res.json(); if (data.code !== "0") return { assets: null, totalUsd: 0 };

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
            if (usdValue >= 1) {
                portfolio.push({ asset: asset.ccy, instId, amount, usdValue, price });
            }
        }
    });
    const totalUsd = portfolio.reduce((sum, a) => sum + a.usdValue, 0);
    portfolio.forEach(a => { a.percentage = totalUsd > 0 ? ((a.usdValue / totalUsd) * 100) : 0; });
    portfolio.sort((a, b) => b.usdValue - a.usdValue);
    return { assets: portfolio, totalUsd };
} catch (e) { console.error("Error fetching portfolio:", e); return { assets: null, totalUsd: 0 }; }

}

// --- Middleware --- bot.use(async (ctx, next) => { if (ctx.from?.id !== AUTHORIZED_USER_ID) return; await next(); });

// --- عرض الرصيد مع الربح/الخسارة الدائمة --- async function showBalance(ctx) { await ctx.reply("⏳ لحظات... جارٍ تحديث بيانات المحفظة."); const { assets, totalUsd } = await getPortfolioData(); if (!assets) return ctx.reply("❌ حدث خطأ.");

let baseCapital = loadBaseCapital();
if (baseCapital === null) {
    baseCapital = totalUsd;
    saveBaseCapital(baseCapital);
}
const profitLossPercent = ((totalUsd - baseCapital) / baseCapital) * 100;

let msg = `*📊 ملخص المحفظة 📊*\n\n`;
msg += `*💰 القيمة الحالية:* *$${totalUsd.toFixed(2)}*\n`;
msg += `*💼 رأس المال الأساسي:* *$${baseCapital.toFixed(2)}*\n`;
msg += `*💹 نسبة الربح/الخسارة:* *${profitLossPercent.toFixed(2)}%*\n`;
msg += `------------------------------------\n`;

assets.forEach(a => {
    msg += `*💎 ${a.asset}*\n`;
    if (a.asset !== 'USDT') msg += `   *السعر الحالي:* $${a.price.toFixed(4)}\n`;
    msg += `   *القيمة:* $${a.usdValue.toFixed(2)}  *(${a.percentage.toFixed(2)}%)*\n`;
    msg += `   *الكمية:* ${a.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n\n`;
});

msg += `_آخر تحديث: ${new Date().toLocaleTimeString("ar-EG", { hour: '2-digit', minute: '2-digit', hour12: true })}_`;
ctx.reply(msg, { parse_mode: "Markdown" });

}

// --- الأوامر --- const menu = new InlineKeyboard() .text("💰 عرض الرصيد", "show_balance");

const welcomeMessage = *أهلاً بك في بوت OKX المطور* 🤖\n\nاختر الأمر للبدء:;

bot.command("start", ctx => ctx.reply(welcomeMessage, { reply_markup: menu, parse_mode: "Markdown" })); bot.command("balance", showBalance);

bot.on("callback_query:data", async ctx => { const d = ctx.callbackQuery.data; await ctx.answerCallbackQuery(); if (d === "show_balance") await showBalance(ctx); });

bot.catch((err) => console.error("--- UNCAUGHT ERROR ---", err.error));

// --- التشغيل --- app.use(webhookCallback(bot, "express")); app.listen(PORT, async () => { console.log(Server listening on port ${PORT}); const domain = process.env.RAILWAY_STATIC_URL; if (domain) { const webhookUrl = https://${domain}/${bot.token}; try { await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true }); console.log(Webhook successfully set to: ${webhookUrl}); } catch (e) { console.error("!!! Failed to set webhook:", e); } } else { console.error("!!! RAILWAY_STATIC_URL is not set."); } });

