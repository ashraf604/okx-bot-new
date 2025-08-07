// =================================================================
// OKX Advanced Analytics Bot - index.js (Full Version v60)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// --- Configuration ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID, 10);
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const API_BASE_URL = "https://www.okx.com";

// --- State ---
let waitingState = null;

// ========== Database Helpers ==========
const getCollection = (name) => getDB().collection("configs");
async function getConfig(id, defaultValue = {}) {
  const doc = await getCollection("configs").findOne({ _id: id });
  return doc ? doc.data : defaultValue;
}
async function saveConfig(id, data) {
  await getCollection("configs").updateOne({ _id: id }, { $set: { data } }, { upsert: true });
}

// Simple getters/setters
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (value) => saveConfig("capital", { value });

const loadSettings = () => getConfig("settings", { dailySummary: true, autoPostToChannel: false, debugMode: false });
const saveSettings = (settings) => saveConfig("settings", settings);

const loadPositions = () => getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);

const loadBalanceState = () => getConfig("balanceState", {});
const saveBalanceState = (state) => saveConfig("balanceState", state);

const loadAlerts = () => getConfig("priceAlerts", []);
const saveAlerts = (alerts) => saveConfig("priceAlerts", alerts);

const loadAlertSettings = () => getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (s) => saveConfig("alertSettings", s);

const loadPriceTracker = () => getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (t) => saveConfig("priceTracker", t);

// ========== Debug Helper ==========
async function sendDebugMessage(message) {
  const settings = await loadSettings();
  if (settings.debugMode) {
    try {
      await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" });
    } catch {}
  }
}

// ========== OKX API Helper ==========
function getHeaders(method, path, body = "") {
  const timestamp = new Date().toISOString();
  const prehash = timestamp + method.toUpperCase() + path + (typeof body === "object" ? JSON.stringify(body) : body);
  const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64");
  return {
    "OK-ACCESS-KEY": process.env.OKX_API_KEY,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
    "Content-Type": "application/json",
  };
}

// ========== Market Price Fetch ==========
async function getMarketPrices() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
    const json = await res.json();
    if (json.code !== "0") return null;
    return json.data.reduce((acc, t) => {
      const last = parseFloat(t.last), open = parseFloat(t.open24h);
      acc[t.instId] = { price: last, change24h: open > 0 ? (last - open) / open : 0 };
      return acc;
    }, {});
  } catch { return null; }
}

// ========== Portfolio Fetch ==========
async function getPortfolio(prices) {
  try {
    const path = "/api/v5/account/balance";
    const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
    const json = await res.json();
    if (json.code !== "0") return { error: json.msg };

    let total = 0, assets = [];
    json.data[0].details.forEach(a => {
      const amt = parseFloat(a.eq);
      if (amt > 0) {
        const instId = `${a.ccy}-USDT`, pd = prices[instId] || { price: a.ccy === "USDT" ? 1 : 0, change24h: 0 };
        const val = amt * pd.price;
        total += val;
        if (val >= 1) assets.push({ asset: a.ccy, amount: amt, price: pd.price, value: val, change24h: pd.change24h });
      }
    });
    assets.sort((a, b) => b.value - a.value);
    return { assets, total };
  } catch { return { error: "Connection error" }; }
}

// ========== Balance Comparison ==========
async function getBalanceForComparison() {
  try {
    const path = "/api/v5/account/balance";
    const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
    const json = await res.json();
    if (json.code !== "0") return null;
    return json.data[0].details.reduce((m, a) => { m[a.ccy] = parseFloat(a.eq); return m; }, {});
  } catch { return null; }
}

// ========== Update & Analyze Position ==========
async function updatePositionAndAnalyze(asset, diff, price, newAmt) {
  if (!price || isNaN(price)) return null;
  const pts = await loadPositions(), p = pts[asset];
  const tv = Math.abs(diff) * price;
  let report = null;

  if (diff > 0) {
    if (!p) pts[asset] = { totalBought: diff, totalCost: tv, avgBuy: price, open: new Date().toISOString(), realized: 0, sold: 0 };
    else { p.totalBought += diff; p.totalCost += tv; p.avgBuy = p.totalCost / p.totalBought; }
  } else if (p) {
    p.realized += tv; p.sold += Math.abs(diff);
    if (newAmt * price < 1) {
      const pnl = p.realized - p.totalCost;
      const pnlPct = p.totalCost ? (pnl / p.totalCost) * 100 : 0;
      const emoji = pnl >= 0 ? "🟢⬆️" : "🔴⬇️";
      report =
        `🔔 تحليل حركة تداول\n━━━━━━━━━━━━━━━━━━━━\n` +
        `🔸 العملية: إغلاق ${emoji}\n🔸 الأصل: ${asset}/USDT\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📝 تفاصيل الصفقة:\n ▫️ سعر التنفيذ: $${price.toFixed(4)}\n ▫️ كمية: ${p.sold.toFixed(6)}\n ▫️ قيمة: $${p.realized.toFixed(2)}\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 الأداء النهائي:\n ▫️ PnL: ${pnl>=0?"+":"-"+Math.abs(pnl).toFixed(2)} (${pnlPct.toFixed(2)}%)\n━━━━━━━━━━━━━━━━━━━━\n`;
      delete pts[asset];
    }
  }
  await savePositions(pts);
  return report;
}

// ========== Monitor Trades & Notify ==========
async function monitorBalanceChanges() {
  try {
    const prev = await loadBalanceState(), prevBal = prev.balances || {}, prevVal = prev.totalValue || 0;
    const currBal = await getBalanceForComparison(); if (!currBal) return;
    const prices = await getMarketPrices(); if (!prices) return;
    const { assets, total } = await getPortfolio(prices); if (total === undefined) return;
    if (Object.keys(prevBal).length === 0) { await saveBalanceState({ balances: currBal, totalValue: total }); return; }

    let any = false;
    for (const a of new Set([...Object.keys(prevBal), ...Object.keys(currBal)])) {
      if (a === "USDT") continue;
      const diff = (currBal[a]||0) - (prevBal[a]||0);
      const pd = prices[`${a}-USDT`]; if (!pd||!pd.price) continue;
      if (Math.abs(diff*pd.price) < 0.1) continue;
      any = true;

      const price = pd.price;
      const rpt = await updatePositionAndAnalyze(a, diff, price, currBal[a]||0);
      if (rpt) await bot.api.sendMessage(AUTHORIZED_USER_ID, rpt, { parse_mode: "Markdown" });

      const tradeType = diff>0?"شراء 🟢⬆️":(currBal[a]*price<1?"إغلاق 🔴⬇️":"بيع جزئي 🟠");
      const tv = Math.abs(diff)*price;
      const newAssetVal = currBal[a]*price;
      const portPct = total?(newAssetVal/total)*100:0;
      const cashVal = assets.find(x=>x.asset==="USDT")?.value||0;
      const cashPct = total?(cashVal/total)*100:0;
      const entryPct = prevVal?(tv/prevVal)*100:0;

      const privateText =
        `🔔 تحليل حركة تداول\n━━━━━━━━━━━━━━━━━━━━\n`+
        `🔸 العملية: ${tradeType}\n🔸 الأصل: ${a}/USDT\n━━━━━━━━━━━━━━━━━━━━\n`+
        `📝 تفاصيل الصفقة:\n ▫️ سعر التنفيذ: $${price.toFixed(4)}\n ▫️ الكمية: ${Math.abs(diff).toFixed(6)}\n ▫️ قيمة الصفقة: $${tv.toFixed(2)}\n━━━━━━━━━━━━━━━━━━━━\n`+
        `📊 التأثير على المحفظة:\n ▫️ حجم الصفقة: ${entryPct.toFixed(2)}%\n ▫️ الوزن الجديد: ${portPct.toFixed(2)}%\n ▫️ الرصيد النقدي: $${cashVal.toFixed(2)}\n ▫️ نسبة الكاش: ${cashPct.toFixed(2)}%\n━━━━━━━━━━━━━━━━━━━━\n`+
        `*بتاريخ: ${new Date().toLocaleString("ar-EG",{timeZone:"Africa/Cairo"})}*`;

      const settings = await loadSettings();
      if (settings.autoPostToChannel) {
        const channelText =
          `🔔 توصية جديدة: ${diff>0?"شراء 🟢":"بيع 🔴"}\n\n`+
          `العملة: ${a}/USDT\n`+
          `متوسط سعر الدخول: ~ $${price.toFixed(4)}\n`+
          `حجم الدخول: ${entryPct.toFixed(2)}% من المحفظة\n`+
          `تم استخدام: ${cashPct.toFixed(2)}% من الكاش\n`+
          `تمثل الآن: ${portPct.toFixed(2)}% من المحفظة`;

        try {
          await bot.api.sendMessage(TARGET_CHANNEL_ID, channelText, { parse_mode: "Markdown" });
          await bot.api.sendMessage(AUTHORIZED_USER_ID, privateText, { parse_mode: "Markdown" });
        } catch (e) {
          console.error("Auto-post error:", e);
          await bot.api.sendMessage(AUTHORIZED_USER_ID, "❌ فشل النشر التلقائي في القناة.", { parse_mode: "Markdown" });
        }
      } else {
        const kb = new InlineKeyboard()
          .text("✅ نشر", "publish_trade")
          .text("❌ تجاهل", "ignore_trade");
        await bot.api.sendMessage(AUTHORIZED_USER_ID, privateText, { parse_mode: "Markdown", reply_markup: kb });
      }
    }

    if (any) await saveBalanceState({ balances: currBal, totalValue: total });
  } catch (e) {
    console.error("monitorBalanceChanges Error:", e);
  }
}

// ========== Healthcheck ==========
app.get("/healthcheck", (req, res) => res.status(200).send("OK"));

// ========== Bot UI & Handlers ==========

const mainKeyboard = new Keyboard()
  .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
  .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
  .text("🧮 حاسبة الربح والخسارة").row()
  .text("⚙️ الإعدادات").resized();

async function sendSettingsMenu(ctx) {
  const s = await loadSettings();
  const kb = new InlineKeyboard()
    .text("💰 تعيين رأس المال", "set_capital").text("💼 عرض المراكز", "view_positions").row()
    .text("🚨 تنبيهات حركة", "manage_movement_alerts").text("🗑️ حذف تنبيه", "delete_alert").row()
    .text(`📰 الملخص اليومي: ${s.dailySummary?'✅':'❌'}`, "toggle_summary").row()
    .text(`🚀 نشر تلقائي: ${s.autoPostToChannel?'✅':'❌'}`, "toggle_autopost").text(`🐞 Debug: ${s.debugMode?'✅':'❌'}`, "toggle_debug").row()
    .text("🔥 حذف جميع البيانات", "delete_all_data");
  const txt = "⚙️ *الإعدادات الرئيسية*";
  try { await ctx.editMessageText(txt, { parse_mode:"Markdown", reply_markup:kb }); }
  catch { await ctx.reply(txt, { parse_mode:"Markdown", reply_markup:kb }); }
}

async function sendMovementAlertsMenu(ctx) {
  const a = await loadAlertSettings();
  const txt = `🚨 *تنبيهات حركة الأسعار*\n\n- النسبة العامة: \`${a.global}%\`\n- تخصيص عملة: ${Object.keys(a.overrides).map(c=>`${c}:${a.overrides[c]}%`).join(", ")||"لا يوجد"}`;
  const kb = new InlineKeyboard()
    .text("📊 تعديل عام", "set_global_alert").row()
    .text("💎 تخصيص عملة", "set_coin_alert").row()
    .text("🔙 رجوع", "back_to_settings");
  try { await ctx.editMessageText(txt, { parse_mode:"Markdown", reply_markup:kb }); }
  catch { await ctx.reply(txt, { parse_mode:"Markdown", reply_markup:kb }); }
}

bot.use(async (ctx, next) => {
  if (ctx.from?.id === AUTHORIZED_USER_ID) await next();
});

bot.command("start", async (ctx) => {
  await ctx.reply(`🤖 *بوت OKX التحليلي*\n*الإصدار: v60*`, { parse_mode:"Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", sendSettingsMenu);

bot.command("pnl", async (ctx) => {
  const args = ctx.match.trim().split(/\s+/);
  if (args.length!==3) return ctx.reply("❌ صيغة: /pnl buy sell qty");
  const [b,s,q]=args.map(Number);
  if([b,s,q].some(x=>isNaN(x)||x<=0)) return ctx.reply("❌ أرقام موجبة فقط");
  const cost=b*q, rev=s*q, pnl=rev-cost, pct=(pnl/cost)*100;
  const sign=pnl>=0?"+":""; const emoji=pnl>=0?"ربح✅":"خسارة🔻";
  const msg=`💰 PnL\n- Buy cost: $${cost}\n- Sell rev: $${rev}\n- Net: ${sign}${pnl} (${sign}${pct.toFixed(2)}%)\n${emoji}`;
  await ctx.reply(msg);
});

bot.on("callback_query:data", async (ctx) => {
  const d = ctx.callbackQuery.data;
  await ctx.answerCallbackQuery();
  if(d==="publish_trade"){
    const txt=ctx.callbackQuery.message.text.replace("*تم اكتشاف صفقة جديدة، هل تود نشرها؟*\n\n","");
    await bot.api.sendMessage(TARGET_CHANNEL_ID, txt, { parse_mode:"Markdown" });
    await ctx.editMessageText("✅ تم النشر في القناة", { reply_markup:undefined });
  } else if(d==="ignore_trade"){
    await ctx.editMessageText("❌ تم التجاهل", { reply_markup:undefined });
  } else if(d==="view_positions"){ /* ... */ }
  else if(d==="back_to_settings") sendSettingsMenu(ctx);
  else if(d==="manage_movement_alerts") sendMovementAlertsMenu(ctx);
  else if(d==="set_global_alert"){ waitingState="set_global"; ctx.editMessageText("أرسل النسبة العامة"); }
  else if(d==="set_coin_alert"){ waitingState="set_coin"; ctx.editMessageText("أرسل رمز ونسبة"); }
  else if(d==="toggle_summary"||d==="toggle_autopost"||d==="toggle_debug"){
    const s = await loadSettings();
    if(d==="toggle_summary") s.dailySummary=!s.dailySummary;
    if(d==="toggle_autopost") s.autoPostToChannel=!s.autoPostToChannel;
    if(d==="toggle_debug") s.debugMode=!s.debugMode;
    await saveSettings(s); sendSettingsMenu(ctx);
  } else if(d==="delete_all_data"){ waitingState="confirm_delete"; ctx.editMessageText("أرسل تأكيد الحذف"); }
});

bot.on("message:text", async (ctx) => {
  const txt = ctx.message.text.trim();
  if(txt.startsWith("/")) return;
  if(waitingState){
    const st=waitingState; waitingState=null;
    if(st==="set_global"){ const p=Number(txt); if(!isNaN(p)&&p>0){ const s=await loadAlertSettings(); s.global=p; await saveAlertSettings(s); ctx.reply("✅ تم"); } else ctx.reply("❌ قيمة خاطئة");}
    else if(st==="set_coin"){
      const [sym,pr]=txt.split(/\s+/); const pp=Number(pr);
      if(sym&& !isNaN(pp)){
        const s=await loadAlertSettings();
        if(pp===0) delete s.overrides[sym.toUpperCase()];
        else s.overrides[sym.toUpperCase()]=pp;
        await saveAlertSettings(s); ctx.reply("✅ تم");
      } else ctx.reply("❌ صيغة خاطئة");
    }
    else if(st==="set_capital"){
      const v=Number(txt);
      if(!isNaN(v)&&v>=0){ await saveCapital(v); ctx.reply(`✅ رأس مال ${v}`); }
      else ctx.reply("❌ أرقام فقط");
    }
    else if(st==="confirm_delete"){
      if(txt==="تأكيد الحذف"){
        await getCollection("configs").deleteMany({});
        ctx.reply("✅ تم حذف كل البيانات");
      } else ctx.reply("❌ تم الإلغاء");
    }
  }
});

// ========== Start Server & Bot ==========
async function startBot(){
  try {
    await connectDB();
    console.log("MongoDB connected.");
    setInterval(monitorBalanceChanges, 60000);
    // (أضف باقٍ الجداول هنا)
    if(process.env.NODE_ENV==="production"){
      app.use(express.json());
      app.use(webhookCallback(bot,"express"));
      app.listen(PORT,()=>console.log(`Server on port ${PORT}`));
    } else {
      await bot.start();
      console.log("Bot polling started.");
    }
  } catch(e){
    console.error("Startup error:", e);
  }
}
startBot();
