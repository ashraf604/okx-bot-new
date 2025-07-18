// index.js - نسخة نهائية جاهزة للرفع على Railway // بوت متابعة محفظة OKX مع PnL تلقائي وإمكانية تغيير نسبة التنبيه من أوامر البوت

const express = require("express"); const { Bot, webhookCallback } = require("grammy"); const fetch = require("node-fetch"); const crypto = require("crypto"); const fs = require("fs"); require("dotenv").config();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN); const API_BASE_URL = "https://www.okx.com"; const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID); const PORT = process.env.PORT || 3000; const app = express(); app.use(express.json());

const CAPITAL_FILE = "./capital.json"; const ALERT_FILE = "./alert.json";

function loadCapital() { try { return fs.existsSync(CAPITAL_FILE) ? JSON.parse(fs.readFileSync(CAPITAL_FILE)).capital : null; } catch { return null; } } function saveCapital(capital) { try { fs.writeFileSync(CAPITAL_FILE, JSON.stringify({ capital })); } catch {} } function loadAlert() { try { return fs.existsSync(ALERT_FILE) ? JSON.parse(fs.readFileSync(ALERT_FILE)).alert : null; } catch { return null; } } function saveAlert(alert) { try { fs.writeFileSync(ALERT_FILE, JSON.stringify({ alert })); } catch {} }

function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const signString = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const signature = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(signString).digest("base64"); return { "Content-Type": "application/json", "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": signature, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "x-simulated-trading": "0" }; }

async function getMarketTickers() { try { const res = await fetch(${API_BASE_URL}/api/v5/market/tickers?instType=SPOT); const data = await res.json(); return data.code === "0" ? data.data : []; } catch { return []; } }

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
return { assets: portfolio, totalUsd };

} catch { return { assets: null, totalUsd: 0 }; } }

bot.use(async (ctx, next) => { if (ctx.from?.id !== AUTHORIZED_USER_ID) return; await next(); });

async function showBalance(ctx) { await ctx.reply("⏳ جارٍ تحديث بيانات المحفظة..."); const { assets, totalUsd } = await getPortfolioData(); if (!assets) return ctx.reply("❌ حدث خطأ.");

let initialCapital = loadCapital(); if (!initialCapital) { initialCapital = totalUsd; saveCapital(initialCapital); } const pnl = totalUsd - initialCapital; const pnlPercentage = initialCapital > 0 ? ((pnl / initialCapital) * 100).toFixed(2) : "0.00";

let msg = 📊 *ملخص المحفظة* 📊\n\n; msg += 💰 *القيمة الحالية:* $${totalUsd.toFixed(2)}\n; msg += 💼 *رأس المال الأساسي:* $${initialCapital.toFixed(2)}\n; msg += 📈 *PnL:* $${pnl.toFixed(2)} (${pnlPercentage}%)\n;

ctx.reply(msg, { parse_mode: "Markdown" });

const alert = loadAlert(); if (alert !== null) { if (pnlPercentage >= alert) { ctx.reply(📢 تم الوصول إلى نسبة الربح المستهدفة: ${alert}% ✅); saveAlert(null); } else if (pnlPercentage <= alert) { ctx.reply(📢 تم الوصول إلى نسبة الخسارة المحددة: ${alert}% ⚠️); saveAlert(null); } } }

bot.command("start", ctx => ctx.reply("🤖 تم تشغيل البوت بنجاح. استخدم /balance لعرض الرصيد مع PnL، /setalert لضبط التنبيه، و /alertstatus لعرض النسبة الحالية.")); bot.command("balance", showBalance);

bot.command("setalert", async ctx => { const parts = ctx.message.text.split(" "); if (parts.length !== 2) return ctx.reply("❌ الصيغة: /setalert 10 أو /setalert -5"); const value = parseFloat(parts[1]); if (isNaN(value)) return ctx.reply("❌ القيمة غير صالحة."); saveAlert(value); ctx.reply(✅ تم ضبط نسبة التنبيه على ${value}%. سيتم إخطارك تلقائيًا عند تحققها.); });

bot.command("alertstatus", ctx => { const alert = loadAlert(); if (alert === null) ctx.reply("ℹ️ لا توجد نسبة تنبيه محددة حالياً."); else ctx.reply(🔔 النسبة المحددة حالياً: ${alert}%); });

app.use(webhookCallback(bot, "express")); app.listen(PORT, async () => { console.log(🚀 البوت يعمل على المنفذ ${PORT}); const webhookUrl = https://${process.env.RAILWAY_STATIC_URL}/${bot.token}; try { await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true }); console.log(✅ تم تعيين Webhook: ${webhookUrl}); } catch (e) { console.error("⚠️ فشل تعيين Webhook:", e); } });

