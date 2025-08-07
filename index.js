// =================================================================
// OKX Advanced Analytics Bot - index.js (Final v60 with Webhook)
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

// Parse JSON bodies for webhook
app.use(express.json());

// --- State ---
let waitingState = null;

// ========== Database Helpers ==========
const getCollection = (name) => getDB().collection("configs");
async function getConfig(id, defaultValue = {}) {
  const doc = await getCollection("configs").findOne({ _id: id });
  return doc ? doc.data : defaultValue;
}
async function saveConfig(id, data) {
  await getCollection("configs").updateOne(
    { _id: id },
    { $set: { data } },
    { upsert: true }
  );
}

// Simple getters/setters
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (value) => saveConfig("capital", { value });

const loadSettings = () =>
  getConfig("settings", {
    dailySummary: true,
    autoPostToChannel: false,
    debugMode: false,
  });
const saveSettings = (settings) => saveConfig("settings", settings);

const loadPositions = () => getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);

const loadBalanceState = () => getConfig("balanceState", {});
const saveBalanceState = (state) => saveConfig("balanceState", state);

const loadAlerts = () => getConfig("priceAlerts", []);
const saveAlerts = (alerts) => saveConfig("priceAlerts", alerts);

const loadAlertSettings = () =>
  getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (s) => saveConfig("alertSettings", s);

const loadPriceTracker = () =>
  getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (t) => saveConfig("priceTracker", t);

// ========== Debug Helper ==========
async function sendDebugMessage(message) {
  const settings = await loadSettings();
  if (settings.debugMode) {
    try {
      await bot.api.sendMessage(
        AUTHORIZED_USER_ID,
        `🐞 *Debug:* ${message}`,
        { parse_mode: "Markdown" }
      );
    } catch {}
  }
}

// ========== OKX API Helper ==========
function getHeaders(method, path, body = "") {
  const timestamp = new Date().toISOString();
  const prehash =
    timestamp +
    method.toUpperCase() +
    path +
    (typeof body === "object" ? JSON.stringify(body) : body);
  const sign = crypto
    .createHmac("sha256", process.env.OKX_API_SECRET_KEY)
    .update(prehash)
    .digest("base64");
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
    const res = await fetch(
      `${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`
    );
    const json = await res.json();
    if (json.code !== "0") return null;
    return json.data.reduce((acc, t) => {
      const last = parseFloat(t.last),
        open = parseFloat(t.open24h);
      acc[t.instId] = {
        price: last,
        change24h: open > 0 ? (last - open) / open : 0,
      };
      return acc;
    }, {});
  } catch {
    return null;
  }
}

// ========== Portfolio Fetch ==========
async function getPortfolio(prices) {
  try {
    const path = "/api/v5/account/balance";
    const res = await fetch(`${API_BASE_URL}${path}`, {
      headers: getHeaders("GET", path),
    });
    const json = await res.json();
    if (json.code !== "0") return { error: json.msg };

    let total = 0,
      assets = [];
    json.data[0].details.forEach((a) => {
      const amt = parseFloat(a.eq);
      if (amt > 0) {
        const instId = `${a.ccy}-USDT`,
          pd = prices[instId] || {
            price: a.ccy === "USDT" ? 1 : 0,
            change24h: 0,
          };
        const val = amt * pd.price;
        total += val;
        if (val >= 1)
          assets.push({
            asset: a.ccy,
            amount: amt,
            price: pd.price,
            value: val,
            change24h: pd.change24h,
          });
      }
    });
    assets.sort((a, b) => b.value - a.value);
    return { assets, total };
  } catch {
    return { error: "Connection error" };
  }
}

// ========== Balance Comparison ==========
async function getBalanceForComparison() {
  try {
    const path = "/api/v5/account/balance";
    const res = await fetch(`${API_BASE_URL}${path}`, {
      headers: getHeaders("GET", path),
    });
    const json = await res.json();
    if (json.code !== "0") return null;
    return json.data[0].details.reduce((m, a) => {
      m[a.ccy] = parseFloat(a.eq);
      return m;
    }, {});
  } catch {
    return null;
  }
}

// ========== Update & Analyze Position ==========
async function updatePositionAndAnalyze(asset, diff, price, newAmt) {
  if (!price || isNaN(price)) return null;
  const pts = await loadPositions(),
    p = pts[asset];
  const tv = Math.abs(diff) * price;
  let report = null;

  if (diff > 0) {
    if (!p)
      pts[asset] = {
        totalBought: diff,
        totalCost: tv,
        avgBuy: price,
        open: new Date().toISOString(),
        realized: 0,
        sold: 0,
      };
    else {
      p.totalBought += diff;
      p.totalCost += tv;
      p.avgBuy = p.totalCost / p.totalBought;
    }
  } else if (p) {
    p.realized += tv;
    p.sold += Math.abs(diff);
    if (newAmt * price < 1) {
      const pnl = p.realized - p.totalCost;
      const pnlPct = p.totalCost ? (pnl / p.totalCost) * 100 : 0;
      const emoji = pnl >= 0 ? "🟢⬆️" : "🔴⬇️";
      report =
        `🔔 تحليل حركة تداول\n━━━━━━━━━━━━━━━━━━━━\n` +
        `🔸 العملية: إغلاق ${emoji}\n🔸 الأصل: ${asset}/USDT\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📝 تفاصيل الصفقة:\n ▫️ سعر التنفيذ: $${price.toFixed(
          4
        )}\n ▫️ كمية: ${p.sold.toFixed(6)}\n ▫️ قيمة: $${p.realized.toFixed(
          2
        )}\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 الأداء النهائي:\n ▫️ PnL: ${
          pnl >= 0 ? "+" : "-"
        }${Math.abs(pnl).toFixed(2)} (${pnlPct.toFixed(2)}%)\n━━━━━━━━━━━━━━━━━━━━\n`;
      delete pts[asset];
    }
  }

  await savePositions(pts);
  return report;
}

// ========== Monitor Trades & Notify ==========
async function monitorBalanceChanges() {
  try {
    const prev = await loadBalanceState(),
      prevBal = prev.balances || {},
      prevVal = prev.totalValue || 0;
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

    let any = false;
    for (const a of new Set([
      ...Object.keys(prevBal),
      ...Object.keys(currBal),
    ])) {
      if (a === "USDT") continue;
      const diff = (currBal[a] || 0) - (prevBal[a] || 0);
      const pd = prices[`${a}-USDT`];
      if (!pd || !pd.price) continue;
      if (Math.abs(diff * pd.price) < 0.1) continue;
      any = true;

      const price = pd.price;
      const rpt = await updatePositionAndAnalyze(
        a,
        diff,
        price,
        currBal[a] || 0
      );
      if (rpt)
        await bot.api.sendMessage(AUTHORIZED_USER_ID, rpt, {
          parse_mode: "Markdown",
        });

      const tradeType =
        diff > 0
          ? "شراء 🟢⬆️"
          : currBal[a] * price < 1
          ? "إغلاق 🔴⬇️"
          : "بيع جزئي 🟠";
      const tv = Math.abs(diff) * price;
      const newAssetVal = currBal[a] * price;
      const portPct = total ? (newAssetVal / total) * 100 : 0;
      const cashVal =
        assets.find((x) => x.asset === "USDT")?.value || 0;
      const cashPct = total ? (cashVal / total) * 100 : 0;
      const entryPct = prevVal ? (tv / prevVal) * 100 : 0;

      const privateText =
        `🔔 تحليل حركة تداول\n━━━━━━━━━━━━━━━━━━━━\n` +
        `🔸 العملية: ${tradeType}\n🔸 الأصل: ${a}/USDT\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📝 تفاصيل الصفقة:\n ▫️ سعر التنفيذ: $${price.toFixed(
          4
        )}\n ▫️ الكمية: ${Math.abs(diff).toFixed(6)}\n ▫️ قيمة الصفقة: $${tv.toFixed(
          2
        )}\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 التأثير على المحفظة:\n ▫️ حجم الصفقة: ${entryPct.toFixed(
          2
        )}%\n ▫️ الوزن الجديد: ${portPct.toFixed(
          2
        )}%\n ▫️ الرصيد النقدي: $${cashVal.toFixed(
          2
        )}\n ▫️ نسبة الكاش: ${cashPct.toFixed(2)}%\n━━━━━━━━━━━━━━━━━━━━\n` +
        `*بتاريخ: ${new Date().toLocaleString("ar-EG", {
          timeZone: "Africa/Cairo",
        })}*`;

      const settings = await loadSettings();
      if (settings.autoPostToChannel) {
        const channelText =
          `🔔 توصية جديدة: ${
            diff > 0 ? "شراء 🟢" : "بيع 🔴"
          }\n\n
