// ✅ OKX Bot with Auto Trade Monitoring, PnL, Clean Buttons (Final) const express = require("express"); const { Bot, InlineKeyboard, webhookCallback } = require("grammy"); const fetch = require("node-fetch"); const crypto = require("crypto"); require("dotenv").config();

const requiredEnv = ["TELEGRAM_BOT_TOKEN", "OKX_API_KEY", "OKX_API_SECRET_KEY", "OKX_API_PASSPHRASE", "AUTHORIZED_USER_ID", "RAILWAY_STATIC_URL"]; for (const envVar of requiredEnv) { if (!process.env[envVar]) console.error(!!! متغير البيئة ${envVar} غير موجود.); }

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN); const API_BASE_URL = "https://www.okx.com"; const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID); const PORT = process.env.PORT || 3000;

const app = express(); app.use(express.json());

let isMonitoring = false; let monitoringInterval = null; let previousPortfolioState = { assets: [] };

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

async function showBalance(ctx) { await ctx.reply("⏳ جارٍ تحديث بيانات المحفظة..."); const { assets, totalUsd } = await getPortfolioData(); if (!assets) return ctx.reply("❌ حدث خطأ أثناء جلب البيانات.");

let msg = *📊 ملخص المحفظة 📊*\n\n; msg += 💰 *القيمة الحالية:* $${totalUsd.toFixed(2)}\n; msg += ------------------------------------\n;

assets.forEach(a => { msg += 💎 *${a.asset}*\n; if (a.asset !== 'USDT') msg +=   السعر: $${a.price.toFixed(4)}\n; msg +=   القيمة: $${a.usdValue.toFixed(2)} (${a.percentage.toFixed(2)}%)\n; msg +=   الكمية: ${a.amount.toFixed(6)}\n\n; });

await ctx.reply(msg, { parse_mode: "Markdown" }); }

function checkTrades(currentAssets, previousAssets) { const notifications = []; const prevAssetsMap = new Map(previousAssets.map(a => [a.asset, a]));

for (const currentAsset of currentAssets) { const prevAsset = prevAssetsMap.get(currentAsset.asset); if (!prevAsset) { notifications.push(🟢 *شراء جديد:* ${currentAsset.amount.toFixed(4)} ${currentAsset.asset}); } else { const amountChange = currentAsset.amount - prevAsset.amount; if (Math.abs(amountChange) * currentAsset.price > 1) { const action = amountChange > 0 ? '🔵 شراء إضافي' : '🟠 بيع جزئي'; notifications.push(${action}: ${Math.abs(amountChange).toFixed(4)} ${currentAsset.asset}); } prevAssetsMap.delete(currentAsset.asset); } } for (const soldAsset of prevAssetsMap.values()) { notifications.push(🔴 *بيع كامل:* ${soldAsset.amount.toFixed(4)} ${soldAsset.asset}); } return notifications.length > 0 ? notifications.join("\n") : null; }

async function startMonitoring(ctx) { if (isMonitoring) return ctx.reply("⚠️ المراقبة مفعلة بالفعل."); isMonitoring = true; ctx.reply("✅ تم تشغيل المراقبة التلقائية للصفقات.");

previousPortfolioState = await getPortfolioData();

monitoringInterval = setInterval(async () => { const currentPortfolio = await getPortfolioData(); if (!currentPortfolio.assets) return; const tradeNotifications = checkTrades(currentPortfolio.assets, previousPortfolioState.assets); if (tradeNotifications) { await bot.api.sendMessage(AUTHORIZED_USER_ID, 🔄 *حركة الصفقات* 🔄\n\n${tradeNotifications}, { parse_mode: "Markdown" }); } previousPortfolioState = currentPortfolio; }, 60000); }

async function stopMonitoring(ctx) { if (!isMonitoring) return ctx.reply("ℹ️ المراقبة متوقفة حالياً."); clearInterval(monitoringInterval); isMonitoring = false; ctx.reply("🛑 تم إيقاف المراقبة."); }

const menu = new InlineKeyboard() .text("💰 عرض المحفظة", "show_balance").row() .text("👁️ بدء المراقبة", "start_monitoring") .text("🛑 إيقاف المراقبة", "stop_monitoring");

bot.command("start", ctx => ctx.reply("🤖 مرحبا بك في بوت OKX\nاختر ما تحتاج: ", { reply_markup: menu, parse_mode: "Markdown" })); bot.command("balance", showBalance); bot.command("monitor", startMonitoring); bot.command("stopmonitor", stopMonitoring);

bot.on("callback_query:data", async ctx => { const d = ctx.callbackQuery.data; await ctx.answerCallbackQuery(); if (d === "show_balance") await showBalance(ctx); if (d === "start_monitoring") await startMonitoring(ctx); if (d === "stop_monitoring") await stopMonitoring(ctx); });

bot.catch(err => console.error("--- BOT ERROR ---", err));

app.use(webhookCallback(bot, "express")); app.listen(PORT, async () => { console.log(Server running on ${PORT}); const domain = process.env.RAILWAY_STATIC_URL; if (domain) { try { await bot.api.setWebhook(https://${domain}/${bot.token}); console.log("✅ Webhook set successfully."); } catch (e) { console.error("!!! Failed to set webhook:", e); } } });

