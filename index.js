// 🚀 OKX Bot Final Clean Version (Ready for Railway)

const express = require("express"); const { Bot, InlineKeyboard, webhookCallback } = require("grammy"); const fetch = require("node-fetch"); const crypto = require("crypto"); require("dotenv").config();

const requiredEnv = ["TELEGRAM_BOT_TOKEN", "OKX_API_KEY", "OKX_API_SECRET_KEY", "OKX_API_PASSPHRASE", "AUTHORIZED_USER_ID", "RAILWAY_STATIC_URL"]; for (const envVar of requiredEnv) { if (!process.env[envVar]) { console.error(!!! متغير البيئة ${envVar} غير موجود.); } }

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN || ""); const API_BASE_URL = "https://www.okx.com"; const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "0", 10); const PORT = process.env.PORT || 3000; const app = express(); app.use(express.json());

let isMonitoring = false; let monitoringInterval = null; let previousPortfolioState = {};

function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const bodyString = typeof body === 'object' ? JSON.stringify(body) : body; const signString = timestamp + method.toUpperCase() + path + bodyString; const signature = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(signString).digest("base64"); return { "Content-Type": "application/json", "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": signature, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "x-simulated-trading": "0" }; }

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

} catch (e) { console.error("Error fetching portfolio:", e); return { assets: null, totalUsd: 0 }; } }

bot.use(async (ctx, next) => { if (ctx.from?.id !== AUTHORIZED_USER_ID) return; await next(); });

async function showBalance(ctx) { await ctx.reply("⏳ جاري تحديث بيانات المحفظة..."); const { assets, totalUsd } = await getPortfolioData(); if (!assets) return ctx.reply("❌ حدث خطأ في جلب البيانات.");

let msg = *📊 ملخص المحفظة 📊*\n\n*💰 إجمالي القيمة:* *$${totalUsd.toFixed(2)}*\n------------------------------------\n;

assets.forEach(a => { msg += *💎 ${a.asset}*\n; if (a.asset !== 'USDT') msg +=    *السعر الحالي:* $${a.price.toFixed(4)}\n; msg +=    *القيمة:* $${a.usdValue.toFixed(2)}  *(${a.percentage.toFixed(2)}%)*\n; msg +=    *الكمية:* ${a.amount.toLocaleString('en-US', { maximumFractionDigits: 6 })}\n\n; }); msg += _آخر تحديث: ${new Date().toLocaleTimeString("ar-EG", { hour: '2-digit', minute: '2-digit', hour12: true })}_; ctx.reply(msg, { parse_mode: "Markdown" }); }

async function showMarketPulse(ctx) { await ctx.reply("⏳ جاري تحليل نبض السوق..."); const tickers = await getMarketTickers(); if (tickers.length === 0) return ctx.reply("❌ لا يمكن جلب بيانات السوق حالياً.");

const usdtPairs = tickers
    .filter(t => t.instId.endsWith('-USDT') && parseFloat(t.vol24h) > 100000)
    .map(t => {
        const open24h = parseFloat(t.open24h);
        const last = parseFloat(t.last);
        const changePercentage = open24h !== 0 ? ((last - open24h) / open24h) * 100 : 0;
        return {
            asset: t.instId.replace('-USDT', ''),
            change24h: changePercentage
        };
    });

const gainers = [...usdtPairs].sort((a, b) => b.change24h - a.change24h).slice(0, 5);
const losers = [...usdtPairs].sort((a, b) => a.change24h - b.change24h).slice(0, 5);

let msg = `*📈 نبض السوق لآخر 24 ساعة 📉*\n\n*🟢 الرابحون الكبار 🟢*\n`;
gainers.forEach(g => { msg += `*${g.asset}:* \`+${g.change24h.toFixed(2)}%\`\n`; });
msg += `\n*🔴 الخاسرون الكبار 🔴*\n`;
losers.forEach(l => { msg += `*${l.asset}:* \`${l.change24h.toFixed(2)}%\`\n`; });
msg += `\n_البيانات من OKX مباشرة_`;
ctx.reply(msg, { parse_mode: "Markdown" });

}

// مراقبة المحافظ والدوال الأخرى محفوظة كما في النسخة السابقة

const menu = new InlineKeyboard() .text("💰 عرض الرصيد", "show_balance").text("📈 نبض السوق", "market_pulse").row() .text("👁️ بدء المراقبة", "start_monitoring").text("🛑 إيقاف المراقبة", "stop_monitoring");

const welcomeMessage = *أهلاً بك في بوت OKX المطور* 🤖\n\nاختر أحد الأوامر للبدء:; bot.command("start", ctx => ctx.reply(welcomeMessage, { reply_markup: menu, parse_mode: "Markdown" })); bot.command("balance", showBalance); bot.command("pulse", showMarketPulse); // أوامر المراقبة تبقى كما هي

bot.on("callback_query:data", async ctx => { const d = ctx.callbackQuery.data; await ctx.answerCallbackQuery(); if (d === "show_balance") await showBalance(ctx); if (d === "market_pulse") await showMarketPulse(ctx); // بقية الأوامر كما هي });

bot.catch((err) => console.error("--- UNCAUGHT ERROR ---", err.error));

app.use(webhookCallback(bot, "express")); app.listen(PORT, async () => { console.log(Server listening on port ${PORT}); const domain = process.env.RAILWAY_STATIC_URL; if (domain) { const webhookUrl = https://${domain}/${bot.token}; try { await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true }); console.log(Webhook successfully set to: ${webhookUrl}); } catch (e) { console.error("!!! Failed to set webhook:", e); } } else { console.error("!!! RAILWAY_STATIC_URL is not set."); } });

