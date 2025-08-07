// =================================================================
// OKX Advanced Analytics Bot - index.js (Full Version v59)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// --- Configurations ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID, 10);
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const API_BASE_URL = "https://www.okx.com";

// --- State ---
let waitingState = null;

// === Database Helpers ===
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

// === Debug Helper ===
async function sendDebugMessage(msg) {
  const s = await loadSettings();
  if (s.debugMode) {
    try {
      await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${msg}`, { parse_mode: "Markdown" });
    } catch {}
  }
}

// === OKX API Helper ===
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

// === Market Price Fetch ===
async function getMarketPrices() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
    const json = await res.json();
    if (json.code !== "0") {
      console.error("OKX Error:", json.msg);
      return null;
    }
    const prices = {};
    json.data.forEach(t => {
      const last = parseFloat(t.last);
      const open = parseFloat(t.open24h);
      const change24h = open > 0 ? (last - open) / open : 0;
      prices[t.instId] = { price: last, open24h: open, change24h };
    });
    return prices;
  } catch (e) {
    console.error("getMarketPrices error:", e);
    return null;
  }
}

// === Portfolio Fetch ===
async function getPortfolio(prices) {
  try {
    const path = "/api/v5/account/balance";
    const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
    const json = await res.json();
    if (json.code !== "0") return { error: `OKX Error: ${json.msg}` };

    let assets = [], total = 0;
    json.data?.details?.forEach(a => {
      const eq = parseFloat(a.eq);
      if (eq > 0) {
        const id = `${a.ccy}-USDT`;
        const pd = prices[id] || { price: a.ccy === "USDT" ? 1 : 0, change24h: 0 };
        const val = eq * pd.price;
        total += val;
        if (val >= 1) assets.push({ asset: a.ccy, amount: eq, price: pd.price, value: val, change24h: pd.change24h });
      }
    });
    assets.sort((a, b) => b.value - a.value);
    return { assets, total };
  } catch (e) {
    console.error("getPortfolio error:", e);
    return { error: "Connection error" };
  }
}

// === Balance Comparison ===
async function getBalanceForComparison() {
  try {
    const path = "/api/v5/account/balance";
    const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
    const json = await res.json();
    if (json.code !== "0") return null;
    const bal = {};
    json.data?.details?.forEach(a => {
      const eq = parseFloat(a.eq);
      if (eq >= 0) bal[a.ccy] = eq;
    });
    return bal;
  } catch (e) {
    console.error("getBalanceForComparison error:", e);
    return null;
  }
}

// === Update Positions & Analyze ===
async function updatePositionAndAnalyze(asset, diff, price, newAmt) {
  const positions = await loadPositions();
  const pos = positions[asset];
  const tv = Math.abs(diff) * price;
  let report = null;

  if (diff > 0) {
    // buy
    if (!pos) {
      positions[asset] = { totalBought: diff, totalCost: tv, avgBuy: price, open: new Date().toISOString(), sold: 0, realized: 0 };
    } else {
      pos.totalBought += diff;
      pos.totalCost += tv;
      pos.avgBuy = pos.totalCost / pos.totalBought;
    }
  } else if (diff < 0 && pos) {
    // sell
    const soldAmt = Math.abs(diff);
    pos.realized += tv;
    pos.sold += soldAmt;
    if (newAmt * price < 1) {
      // closing
      const pnl = pos.realized - pos.totalCost;
      const pnlPct = pos.totalCost ? (pnl / pos.totalCost) * 100 : 0;
      const emoji = pnl >= 0 ? "🟢⬆️" : "🔴⬇️";
      report =
        `✅ **Closed Position: ${asset}**\n\n` +
        `*Net PnL:* ${emoji} \`${pnl.toFixed(2)}\` (\`${pnlPct.toFixed(2)}%\`)\n` +
        ` - *Avg Buy:* \`${pos.avgBuy.toFixed(4)}\`\n` +
        ` - *Realized:* \`${pos.realized.toFixed(2)}\``;
      delete positions[asset];
    }
  }
  await savePositions(positions);
  return report;
}

// === Monitor Balance & Send Notifications ===
async function monitorBalanceChanges() {
  try {
    await sendDebugMessage("Checking for trades...");
    const prevState = await loadBalanceState();
    const prevBal = prevState.balances || {};
    const prevVal = prevState.totalValue || 0;

    const currBal = await getBalanceForComparison();
    if (!currBal) return;
    const prices = await getMarketPrices();
    if (!prices) return;
    const { assets, total } = await getPortfolio(prices);
    if (total === undefined) return;

    if (Object.keys(prevBal).length === 0) {
      await saveBalanceState({ balances: currBal, totalValue: total });
      return;
    }

    let trades = false;
    for (const a of new Set([...Object.keys(prevBal), ...Object.keys(currBal)])) {
      if (a === "USDT") continue;
      const diff = (currBal[a] || 0) - (prevBal[a] || 0);
      if (Math.abs(diff * (prices[`${a}-USDT`]?.price || 0)) < 0.1) continue;
      trades = true;
      const pr = prices[`${a}-USDT`]?.price;
      const rpt = await updatePositionAndAnalyze(a, diff, pr, currBal[a] || 0);
      if (rpt) await bot.api.sendMessage(AUTHORIZED_USER_ID, rpt, { parse_mode: "Markdown" });

      // Build notification text
      const tv = Math.abs(diff) * pr;
      const newAssetVal = (currBal[a] || 0) * pr;
      const portPct = total ? (newAssetVal / total) * 100 : 0;
      const cashAsset = assets.find(x => x.asset === "USDT") || { value: 0 };
      const cashPct = total ? (cashAsset.value / total) * 100 : 0;
      const portShare = prevVal ? (tv / prevVal) * 100 : 0;
      const typ = diff > 0 ? "شراء 🟢⬆️" : (currBal[a] * pr < 1 ? "إغلاق 🔴⬇️" : "بيع جزئي 🟠");

      const msgText =
        `🔔 **Trade Alert**\n` +
        `*${typ}* \`${a}/USDT\`\n` +
        `▫️ Price: \`${pr.toFixed(4)}\`\n` +
        `▫️ Amount: \`${Math.abs(diff).toFixed(6)}\`\n` +
        `▫️ Value: \`${tv.toFixed(2)}\`\n\n` +
        `📊 **Portfolio Impact**\n` +
        `▫️ ^ of portfolio: \`${portShare.toFixed(2)}%\`\n` +
        `▫️ Coin share: \`${portPct.toFixed(2)}%\`\n` +
        `▫️ Cash: \`${cashPct.toFixed(2)}%\``;

      const settings = await loadSettings();
      if (settings.autoPostToChannel) {
        try {
          await bot.api.sendMessage(TARGET_CHANNEL_ID, msgText, { parse_mode: "Markdown" });
          await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ Auto-posted to channel.", { parse_mode: "Markdown" });
        } catch (e) {
          console.error("Auto-post error:", e);
          await bot.api.sendMessage(AUTHORIZED_USER_ID, "❌ Auto-post failed.", { parse_mode: "Markdown" });
        }
      } else {
        const kb = new InlineKeyboard()
          .text("✅ Post to channel", "publish_trade")
          .text("❌ Ignore", "ignore_trade");
        await bot.api.sendMessage(AUTHORIZED_USER_ID, msgText, { parse_mode: "Markdown", reply_markup: kb });
      }
    }

    if (trades) {
      await saveBalanceState({ balances: currBal, totalValue: total });
    }
  } catch (e) {
    console.error("Error in monitorBalanceChanges:", e);
  }
}

// === Healthcheck (for hosting) ===
app.get("/healthcheck", (_, res) => res.status(200).send("OK"));

// === Bot Command Handlers & UI (truncated for brevity) ===
// - /start, /settings, /pnl
// - callback_query handler for publish_trade / ignore_trade
// - message:text handler for menu buttons

// ... (Add those handlers here, same as previous full version v59) ...

// === Start Bot & Server ===
async function startBot() {
  try {
    await connectDB();
    console.log("MongoDB connected.");

    // schedule polling and checks
    setInterval(monitorBalanceChanges, 60000);
    // add your other intervals: priceAlerts, priceMovements, hourlyJobs, dailyJobs

    if (process.env.NODE_ENV === "production") {
      app.use(express.json());
      app.use(webhookCallback(bot, "express"));
      app.listen(PORT, () => console.log(`Server on port ${PORT}`));
    } else {
      await bot.start();
      console.log("Bot polling started.");
    }
  } catch (e) {
    console.error("Startup error:", e);
  }
}

startBot();
