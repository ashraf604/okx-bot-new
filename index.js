// =================================================================
// OKX Advanced Analytics Bot - index.js (Final v62, Stable on Railway)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard } = require("grammy");
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
  try {
    const doc = await getCollection("configs").findOne({ _id: id });
    return doc ? doc.data : defaultValue;
  } catch {
    return defaultValue;
  }
}

async function saveConfig(id, data) {
  try {
    await getCollection("configs").updateOne({ _id: id }, { $set: { data } }, { upsert: true });
  } catch {}
}

const loadSettings = () => getConfig("settings", { autoPostToChannel: false, debugMode: false });
const saveSettings = (settings) => saveConfig("settings", settings);
const loadBalanceState = () => getConfig("balanceState", {});
const saveBalanceState = (state) => saveConfig("balanceState", state);
// (بقية دوال التحميل والحفظ كما هي)
const loadPositions = () => getConfig("positions", {});
const savePositions = (p) => saveConfig("positions", p);

// ========== OKX API & Helpers ==========
function getHeaders(method, path, body = "") {
  const timestamp = new Date().toISOString();
  const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body);
  const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64");
  return {
    "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
    "Content-Type": "application/json",
  };
}

async function getMarketPrices() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
    const json = await res.json();
    if (json.code !== "0") return null;
    return json.data.reduce((acc, t) => {
      acc[t.instId] = { price: parseFloat(t.last), change24h: parseFloat(t.open24h) > 0 ? (parseFloat(t.last) - parseFloat(t.open24h)) / parseFloat(t.open24h) : 0 };
      return acc;
    }, {});
  } catch { return null; }
}

async function getBalanceForComparison() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, { headers: getHeaders("GET", "/api/v5/account/balance") });
    const json = await res.json();
    if (json.code !== '0' || !json.data[0]?.details) return null;
    return json.data[0].details.reduce((map, asset) => {
      map[asset.ccy] = parseFloat(asset.eq);
      return map;
    }, {});
  } catch { return null; }
}

async function updatePositionAndAnalyze(asset, diff, price, newAmt) {
    if (!price || isNaN(price)) return null;
    const positions = await loadPositions();
    const p = positions[asset];
    const tradeValue = Math.abs(diff) * price;
    let report = null;

    if (diff > 0) { // Buy
        if (!p) {
            positions[asset] = { totalBought: diff, totalCost: tradeValue, avgBuy: price, openDate: new Date().toISOString(), realizedValue: 0, totalSold: 0 };
        } else {
            p.totalBought += diff;
            p.totalCost += tradeValue;
            p.avgBuy = p.totalCost / p.totalBought;
        }
    } else if (p) { // Sell
        p.realizedValue += tradeValue;
        p.totalSold += Math.abs(diff);
        if (newAmt * price < 1) { // Closing position
            const pnl = p.realizedValue - p.totalCost;
            const pnlPct = p.totalCost > 0 ? (pnl / p.totalCost) * 100 : 0;
            const sign = pnl >= 0 ? "+" : "";
            report =
                `🔔 **تقرير إغلاق صفقة**\n` +
                `*الأصل:* ${asset}/USDT ${pnl >= 0 ? "🟢" : "🔴"}\n` +
                `*صافي الربح/الخسارة:* \`${sign}${pnl.toFixed(2)}\` (\`${sign}${pnlPct.toFixed(2)}%\`)\n`;
            delete positions[asset];
        }
    }
    await savePositions(positions);
    return report;
}


async function monitorBalanceChanges() {
    try {
        const prevState = await loadBalanceState();
        const prevBal = prevState.balances || {};
        const prevVal = prevState.totalValue || 0;

        const currentBal = await getBalanceForComparison();
        if (!currentBal) return;

        const prices = await getMarketPrices();
        if (!prices) return;

        // Note: Using a simplified total value calculation here for trade detection logic.
        // A full portfolio calculation might be needed for more detailed reports.
        const currentTotalValue = Object.entries(currentBal).reduce((sum, [ccy, amt]) => {
            const price = prices[`${ccy}-USDT`] ? prices[`${ccy}-USDT`].price : (ccy === 'USDT' ? 1 : 0);
            return sum + (amt * price);
        }, 0);


        if (Object.keys(prevBal).length === 0) {
            await saveBalanceState({ balances: currentBal, totalValue: currentTotalValue });
            return;
        }

        let tradesDetected = false;
        for (const asset of new Set([...Object.keys(prevBal), ...Object.keys(currentBal)])) {
            if (asset === "USDT") continue;

            const diff = (currentBal[asset] || 0) - (prevBal[asset] || 0);
            const priceData = prices[`${asset}-USDT`];
            if (!priceData || !priceData.price) continue;

            const tradeValue = Math.abs(diff) * priceData.price;
            if (tradeValue < 0.1) continue;

            tradesDetected = true;
            const price = priceData.price;

            const positionReport = await updatePositionAndAnalyze(asset, diff, price, currentBal[asset] || 0);
            if (positionReport) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, positionReport, { parse_mode: "Markdown" });
            }

            const tradeType = diff > 0 ? "شراء 🟢⬆️" : (currentBal[asset] * price < 1 ? "إغلاق 🔴⬇️" : "بيع جزئي 🟠");
            const newAssetValue = (currentBal[asset] || 0) * price;
            const portPct = currentTotalValue > 0 ? (newAssetValue / currentTotalValue) * 100 : 0;
            const cashValue = currentBal['USDT'] || 0;
            const cashPct = currentTotalValue > 0 ? (cashValue / currentTotalValue) * 100 : 0;
            const entryPct = prevVal > 0 ? (tradeValue / prevVal) * 100 : 0;

            const privateText =
                `🔔 **تحليل حركة تداول**\n` +
                `*العملية:* ${tradeType}\n` +
                `*الأصل:* \`${asset}/USDT\`\n\n` +
                `*سعر التنفيذ:* \`$${price.toFixed(4)}\`\n` +
                `*الكمية:* \`${Math.abs(diff).toFixed(6)}\`\n` +
                `*قيمة الصفقة:* \`$${tradeValue.toFixed(2)}\`\n\n` +
                `*التأثير على المحفظة:*\n` +
                ` ▫️ حجم الصفقة: \`${entryPct.toFixed(2)}%\`\n` +
                ` ▫️ وزن العملة الجديد: \`${portPct.toFixed(2)}%\`\n` +
                ` ▫️ نسبة الكاش الجديدة: \`${cashPct.toFixed(2)}%\`\n`;

            const settings = await loadSettings();
            if (settings.autoPostToChannel) {
                const channelText =
                    `🔔 **توصية جديدة: ${diff > 0 ? "شراء 🟢" : "بيع 🔴"}**\n\n` +
                    `*العملة:* \`${asset}/USDT\`\n` +
                    `*سعر الدخول المقترح:* ~\`$${price.toFixed(4)}\`\n` +
                    `*حجم الدخول من المحفظة:* \`${entryPct.toFixed(2)}%\``;
                try {
                    await bot.api.sendMessage(TARGET_CHANNEL_ID, channelText, { parse_mode: "Markdown" });
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, privateText, { parse_mode: "Markdown" });
                } catch (e) {
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, "❌ فشل النشر التلقائي للقناة.");
                }
            } else {
                const kb = new InlineKeyboard().text("✅ نشر في القناة", "publish_trade").text("❌ تجاهل", "ignore_trade");
                await bot.api.sendMessage(AUTHORIZED_USER_ID, `*تم اكتشاف صفقة جديدة، هل تود نشرها؟*\n\n${privateText}`, { parse_mode: "Markdown", reply_markup: kb });
            }
        }

        if (tradesDetected) {
            await saveBalanceState({ balances: currentBal, totalValue: currentTotalValue });
        }
    } catch (e) {
        console.error("Error in monitorBalanceChanges:", e);
    }
}


// ========== Express Server & Bot Start ==========

// **الحل هنا**: تعريف معالج فحص الصحة قبل أي middleware خاص بالبوت
app.use(express.json());
app.get("/healthcheck", (req, res) => {
    res.status(200).send("OK");
});


// تطبيق Middleware التحقق من هوية المستخدم على جميع الطلبات الأخرى
bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        await next();
    } else {
        // لا تفعل شيئًا للطلبات غير المصرح بها لتجنب أي مشاكل
    }
});

// (هنا بقية أوامر البوت مثل /start, /settings ومعالجات callback_query)
bot.command("start", (ctx) => {
    ctx.reply("🤖 بوت OKX التحليلي v62 يعمل الآن!");
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data === "publish_trade") {
        const textToPublish = ctx.callbackQuery.message.text.replace("*تم اكتشاف صفقة جديدة، هل تود نشرها؟*\n\n", "");
        try {
            await bot.api.sendMessage(TARGET_CHANNEL_ID, textToPublish, { parse_mode: "Markdown" });
            await ctx.editMessageText("✅ تم النشر بنجاح.");
        } catch {
            await ctx.editMessageText("❌ فشل النشر.");
        }
    } else if (data === "ignore_trade") {
        await ctx.editMessageText("❌ تم تجاهل الصفقة.");
    }
});


async function startBot() {
    console.log("▶️ بدء تشغيل البوت...");
    try {
        await connectDB();
        console.log("✅ تم الاتصال بقاعدة البيانات بنجاح.");

        // جدولة المهام
        setInterval(monitorBalanceChanges, 60000); // 60 ثانية
        console.log("✅ تم جدولة مهمة تتبع الصفقات.");

        // بدء البوت بوضعية Polling
        await bot.start();
        console.log("🤖 البوت بدأ ويعمل في وضعية Polling.");

        // بدء الخادم للرد على فحص الصحة
        app.listen(PORT, () => {
            console.log(`🌐 الخادم يستمع على المنفذ ${PORT} وجاهز لفحص الصحة.`);
        });

    } catch (e) {
        console.error("❌ فشل حاد في بدء تشغيل البوت:", e);
        process.exit(1); // إنهاء العملية في حالة الفشل الحاد
    }
}

// تشغيل البوت
startBot();

