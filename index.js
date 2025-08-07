// =================================================================
// OKX Advanced Analytics Bot - index.js (v59 + Auto-Post Fix)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// --- Bot Setup ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID, 10);
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const API_BASE_URL = "https://www.okx.com";

let waitingState = null;

// Database helpers
const getCollection = (name) => getDB().collection("configs");
async function getConfig(id, def = {}) {
  const doc = await getCollection("configs").findOne({ _id: id });
  return doc ? doc.data : def;
}
async function saveConfig(id, data) {
  await getCollection("configs").updateOne({ _id: id }, { $set: { data } }, { upsert: true });
}
const loadSettings = () => getConfig("settings", { autoPostToChannel: false, debugMode: false });
const saveSettings = (s) => saveConfig("settings", s);
const loadBalance = () => getConfig("balanceState", {});
const saveBalance = (s) => saveConfig("balanceState", s);
const loadPositions = () => getConfig("positions", {});
const savePositions = (p) => saveConfig("positions", p);

// OKX API helpers
function getHeaders(method, path, body = "") {
  const ts = new Date().toISOString();
  const prehash = ts + method + path + (typeof body === "object" ? JSON.stringify(body) : body);
  const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64");
  return {
    "OK-ACCESS-KEY": process.env.OKX_API_KEY,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": ts,
    "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
    "Content-Type": "application/json",
  };
}

async function getMarketPrices() {
  const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
  const json = await res.json();
  if (json.code !== "0") return null;
  return json.data.reduce((acc, t) => {
    acc[t.instId] = parseFloat(t.last);
    return acc;
  }, {});
}

async function getBalanceForComparison() {
  const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, { headers: getHeaders("GET", "/api/v5/account/balance") });
  const json = await res.json();
  if (json.code !== "0") return null;
  return json.data[0].details.reduce((m, a) => {
    m[a.ccy] = parseFloat(a.eq);
    return m;
  }, {});
}

async function updatePositionAndAnalyze(asset, diff, price, newAmt) {
  const positions = await loadPositions();
  const p = positions[asset];
  const tv = Math.abs(diff) * price;
  let rpt = null;
  if (diff > 0) {
    if (!p) positions[asset] = { totalBought: diff, totalCost: tv, avgBuy: price, openDate: new Date().toISOString(), realized: 0, sold: 0 };
    else { p.totalBought += diff; p.totalCost += tv; p.avgBuy = p.totalCost / p.totalBought; }
  } else if (p) {
    p.realized += tv; p.sold += Math.abs(diff);
    if (newAmt * price < 1) {
      const pnl = p.realized - p.totalCost;
      const pct = p.totalCost ? (pnl / p.totalCost) * 100 : 0;
      rpt = `✅ **تقرير إغلاق ${asset}**\nPnL: ${pnl.toFixed(2)} (${pct.toFixed(2)}%)`;
      delete positions[asset];
    }
  }
  await savePositions(positions);
  return rpt;
}

async function monitorBalanceChanges() {
  const prev = await loadBalance();
  const prevBal = prev.balances || {};
  const prevVal = prev.totalValue || 0;
  const bal = await getBalanceForComparison();
  if (!bal) return;
  const prices = await getMarketPrices();
  if (!prices) return;
  const totalValue = Object.entries(bal).reduce((s, [ccy, amt]) => s + amt * (prices[`${ccy}-USDT`] || 0), 0);
  if (!Object.keys(prevBal).length) { await saveBalance({ balances: bal, totalValue }); return; }
  for (const asset of Object.keys(bal)) {
    if (asset === "USDT") continue;
    const diff = bal[asset] - (prevBal[asset] || 0);
    const price = prices[`${asset}-USDT`];
    if (!price || Math.abs(diff * price) < 0.1) continue;
    const rpt = await updatePositionAndAnalyze(asset, diff, price, bal[asset]);
    if (rpt) await bot.api.sendMessage(AUTHORIZED_USER_ID, rpt, { parse_mode: "Markdown" });
    const tv = diff * price;
    const entry = prevVal ? (Math.abs(tv) / prevVal) * 100 : 0;
    const newPct = totalValue ? ((bal[asset] * price) / totalValue) * 100 : 0;
    const cashPct = totalValue ? ((bal.USDT || 0) / totalValue) * 100 : 0;
    const type = diff > 0 ? "شراء 🟢⬆️" : (bal[asset] * price < 1 ? "إغلاق 🔴⬇️" : "بيع جزئي 🟠");
    const detail = 
      `🔔 تحليل تداول\n🔸 ${type} ${asset}/USDT\n▫️ سعر: $${price}\n▫️ قيمة: $${Math.abs(tv).toFixed(2)}\n` +
      `📊 دخول: ${entry.toFixed(2)}%  جديد: ${newPct.toFixed(2)}%  كاش: ${cashPct.toFixed(2)}%`;
    const settings = await loadSettings();
    if (settings.autoPostToChannel) {
      await bot.api.sendMessage(TARGET_CHANNEL_ID, `🔔 توصية: ${type} ${asset}/USDT @$${price}`, { parse_mode: "Markdown" });
      await bot.api.sendMessage(AUTHORIZED_USER_ID, detail);
    } else {
      const kb = new InlineKeyboard().text("✅ نشر", "publish_trade").text("❌ تجاهل", "ignore_trade");
      await bot.api.sendMessage(AUTHORIZED_USER_ID, detail, { reply_markup: kb });
    }
  }
  await saveBalance({ balances: bal, totalValue });
}

// Healthcheck
app.use(express.json());
app.get("/healthcheck", (req, res) => res.send("OK"));

// Bot handlers
bot.use(async (ctx, next) => { if (ctx.from?.id === AUTHORIZED_USER_ID) await next(); });

const mainKeyboard = new Keyboard()
  .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
  .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
  .text("🧮 حاسبة الربح والخسارة").row()
  .text("⚙️ الإعدادات").resized();

bot.command("start", ctx => ctx.reply("🤖 OKX Bot v67 يعمل!", { reply_markup: mainKeyboard }));

bot.on("message:text", async ctx => {
  const text = ctx.message.text;
  if (text === "📊 عرض المحفظة") {
    await ctx.reply("⏳ حساب...");
    await monitorBalanceChanges();
  } else if (text === "⚙️ الإعدادات") {
    const s = await loadSettings();
    const kb = new InlineKeyboard()
      .text(`🚀 نشر تلقائي: ${s.autoPostToChannel?'✅':'❌'}`, "toggle_autopost")
      .row()
      .text(`🐞 Debug: ${s.debugMode?'✅':'❌'}`, "toggle_debug");
    await ctx.reply("⚙️ الإعدادات:", { reply_markup: kb });
  }
  // Add other menu cases...
});

bot.on("callback_query:data", async ctx => {
  const d = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  if (d === "publish_trade") {
    const text = ctx.callbackQuery.message.text;
    await bot.api.sendMessage(TARGET_CHANNEL_ID, text);
    await ctx.editMessageText("✅ تم النشر");
  } else if (d === "ignore_trade") {
    await ctx.editMessageText("❌ تم التجاهل");
  } else if (d === "toggle_autopost") {
    const s = await loadSettings();
    s.autoPostToChannel = !s.autoPostToChannel;
    await saveSettings(s);
    ctx.editMessageReplyMarkup(new InlineKeyboard().text(`🚀 نشر تلقائي: ${s.autoPostToChannel?'✅':'❌'}`, "toggle_autopost"));
  }
});

async function start() {
  await connectDB();
  setInterval(monitorBalanceChanges, 60000);
  await bot.start();
  app.listen(PORT);
}

start();
