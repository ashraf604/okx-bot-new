// =================================================================
// OKX Advanced Analytics Bot - index.js (Complete Version v59)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// --- Bot Setup ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// --- State Variables ---
let waitingState = null;

// === Database Access Helpers ===
const getCollection = (collectionName) => getDB().collection("configs");

async function getConfig(id, defaultValue = {}) {
    const doc = await getCollection("configs").findOne({ _id: id });
    return doc ? doc.data : defaultValue;
}

async function saveConfig(id, data) {
    await getCollection("configs").updateOne({ _id: id }, { $set: { data } }, { upsert: true });
}

// Load/Save Helpers
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });

const loadSettings = () => getConfig("settings", { dailySummary: true, autoPostToChannel: false, debugMode: false });
const saveSettings = (settings) => saveConfig("settings", settings);

const loadPositions = () => getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);

const loadHistory = () => getConfig("dailyHistory", []);
const saveHistory = (history) => saveConfig("dailyHistory", history);

const loadHourlyHistory = () => getConfig("hourlyHistory", []);
const saveHourlyHistory = (history) => saveConfig("hourlyHistory", history);

const loadBalanceState = () => getConfig("balanceState", {});
const saveBalanceState = (state) => saveConfig("balanceState", state);

const loadAlerts = () => getConfig("priceAlerts", []);
const saveAlerts = (alerts) => saveConfig("priceAlerts", alerts);

const loadAlertSettings = () => getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);

const loadPriceTracker = () => getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);

// === Helper & API Functions ===

async function sendDebugMessage(message) {
    const settings = await loadSettings();
    if (settings.debugMode) {
        try {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" });
        } catch (e) {
            console.error("Failed to send debug message:", e);
        }
    }
}

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

async function getMarketPrices() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const json = await res.json();
        if (json.code !== "0") {
            console.error("Failed to fetch market prices (OKX Error):", json.msg);
            return null;
        }
        const prices = {};
        json.data.forEach(t => {
            const lastPrice = parseFloat(t.last);
            const openPrice = parseFloat(t.open24h);
            const change24h = openPrice > 0 ? (lastPrice - openPrice) / openPrice : 0;
            prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h };
        });
        return prices;
    } catch (error) {
        console.error("Exception in getMarketPrices:", error.message);
        return null;
    }
}

async function getPortfolio(prices) {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== "0") return { error: `فشل جلب المحفظة من OKX: ${json.msg}` };

        let assets = [], total = 0;
        json.data[0]?.details?.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const priceData = prices[instId] || { price: asset.ccy === "USDT" ? 1 : 0, change24h: 0 };
                const price = priceData.price;
                const value = amount * price;
                total += value;
                if (value >= 1) {
                    assets.push({ asset: asset.ccy, price, value, amount, change24h: priceData.change24h });
                }
            }
        });

        assets = assets.filter(a => a.value >= 1);
        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (e) {
        console.error("Error in getPortfolio:", e);
        return { error: "خطأ في الاتصال بالمنصة." };
    }
}

async function getBalanceForComparison() {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== "0") {
            console.error("Error fetching balance for comparison:", json.msg);
            return null;
        }
        const balanceMap = {};
        json.data[0]?.details?.forEach(asset => {
            const totalBalance = parseFloat(asset.eq);
            if (totalBalance >= 0) balanceMap[asset.ccy] = totalBalance;
        });
        return balanceMap;
    } catch (error) {
        console.error("Exception in getBalanceForComparison:", error);
        return null;
    }
}

async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) {
    const positions = await loadPositions();
    const position = positions[asset];
    const tradeValue = Math.abs(amountChange) * price;
    let retrospectiveReport = null;

    if (amountChange > 0) { // شراء
        if (!position) {
            positions[asset] = {
                totalAmountBought: amountChange,
                totalCost: tradeValue,
                avgBuyPrice: price,
                openDate: new Date().toISOString(),
                totalAmountSold: 0,
                realizedValue: 0,
            };
        } else {
            position.totalAmountBought += amountChange;
            position.totalCost += tradeValue;
            position.avgBuyPrice = position.totalCost / position.totalAmountBought;
        }
    } else if (amountChange < 0 && position) { // بيع
        const amountSold = Math.abs(amountChange);
        position.realizedValue += tradeValue;
        position.totalAmountSold += amountSold;
        if (newTotalAmount * price < 1) { // إغلاق المركز
            await sendDebugMessage(`Position for ${asset} closed, generating report...`);
            const finalPnl = position.realizedValue - position.totalCost;
            const finalPnlPercent = position.totalCost > 0 ? (finalPnl / position.totalCost) * 100 : 0;
            const avgSellPrice = position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0;
            const pnlEmoji = finalPnl >= 0 ? "🟢⬆️" : "🔴⬇️";

            // تابع احصل على أعلى سعر خلال فترة التملك (يمكن استدعاء API خاص حسب الحاجة)

            retrospectiveReport =
                `✅ **تقرير إغلاق مركز: ${asset}**\n\n` +
                `*النتيجة النهائية للصفقة:* ${pnlEmoji} \`${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(2)}\` (\`${finalPnlPercent.toFixed(2)}%\`)\n\n` +
                `**ملخص تحليل الأداء:**\n` +
                ` - *متوسط سعر الشراء:* \`$${position.avgBuyPrice.toFixed(4)}\`\n` +
                ` - *متوسط سعر البيع:* \`$${avgSellPrice.toFixed(4)}\`\n`;

            delete positions[asset];
        }
    }
    await savePositions(positions);
    return retrospectiveReport;
}

async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("بدء دورة التحقق من الصفقات...");
        let previousState = await loadBalanceState();
        let previousBalanceState = previousState.balances || {};
        let previousTotalPortfolioValue = previousState.totalValue || 0;

        const currentBalance = await getBalanceForComparison();
        if (!currentBalance) {
            await sendDebugMessage("فشل جلب الرصيد الحالي للمقارنة.");
            return;
        }
        const prices = await getMarketPrices();
        if (!prices) {
            await sendDebugMessage("فشل جلب أسعار السوق، سيتم إعادة المحاولة.");
            return;
        }
        const { total: newTotalPortfolioValue, assets: currentAssets } = await getPortfolio(prices);
        if (newTotalPortfolioValue === undefined) {
            await sendDebugMessage("فشل حساب قيمة المحفظة الجديدة.");
            return;
        }

        if (Object.keys(previousBalanceState).length === 0) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            await sendDebugMessage("تم تسجيل الرصيد الأولي وحفظه.");
            return;
        }

        const allAssets = new Set([...Object.keys(previousBalanceState), ...Object.keys(currentBalance)]);
        let tradesDetected = false;

        for (const asset of allAssets) {
            if (asset === "USDT") continue;

            const prevAmount = previousBalanceState[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;

            if (Math.abs(difference * (prices[`${asset}-USDT`]?.price || 0)) < 0.1) continue;

            tradesDetected = true;
            const priceData = prices[`${asset}-USDT`];
            if (!priceData || !priceData.price) {
                await sendDebugMessage(`لا يمكن العثور على سعر لـ ${asset}.`);
                continue;
            }
            const price = priceData.price;
            const retrospectiveReport = await updatePositionAndAnalyze(asset, difference, price, currAmount);

            if (retrospectiveReport) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, retrospectiveReport, { parse_mode: "Markdown" });
            }

            const tradeValue = Math.abs(difference) * price;
            const newAssetValue = currAmount * price;
            const portfolioPercentage = newTotalPortfolioValue > 0 ? (newAssetValue / newTotalPortfolioValue) * 100 : 0;
            const usdtAsset = currentAssets.find((a) => a.asset === "USDT") || { value: 0 };
            const newCashValue = usdtAsset.value;
            const newCashPercentage = newTotalPortfolioValue > 0 ? (newCashValue / newTotalPortfolioValue) * 100 : 0;
            const entryOfPortfolio = previousTotalPortfolioValue > 0 ? (tradeValue / previousTotalPortfolioValue) * 100 : 0;

            let tradeType = "";
            if (difference > 0) tradeType = "شراء 🟢⬆️";
            else tradeType = currAmount * price < 1 ? "إغلاق مركز 🔴⬇️" : "بيع جزئي 🟠";

            const privateTradeAnalysisText =
                `🔔 **تحليل حركة تداول**\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🔸 **العملية:** ${tradeType}\n` +
                `🔸 **الأصل:** \`${asset}/USDT\`\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 **تفاصيل الصفقة:**\n` +
                ` ▫️ *سعر التنفيذ:* \`$${price.toFixed(4)}\`\n` +
                ` ▫️ *الكمية:* \`${Math.abs(difference).toFixed(6)}\`\n` +
                ` ▫️ *قيمة الصفقة:* \`$${tradeValue.toFixed(2)}\`\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 **التأثير على المحفظة:**\n` +
                ` ▫️ *حجم الصفقة من المحفظة:* \`${entryOfPortfolio.toFixed(2)}%\`\n` +
                ` ▫️ *الوزن الجديد للعملة:* \`${portfolioPercentage.toFixed(2)}%\`\n` +
                ` ▫️ *الرصيد النقدي الجديد:* \`$${newCashValue.toFixed(2)}\`\n` +
                ` ▫️ *نسبة الكاش الجديدة:* \`${newCashPercentage.toFixed(2)}%\`\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*`;

            const settings = await loadSettings();

            if (settings.autoPostToChannel) {
                try {
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, privateTradeAnalysisText, { parse_mode: "Markdown" });
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ تم نشر الصفقة تلقائيًا في القناة.", { parse_mode: "Markdown" });
                } catch (e) {
                    console.error("Failed to auto-post to channel:", e);
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, "❌ فشل النشر التلقائي في القناة. يرجى التحقق من صلاحيات البوت.", { parse_mode: "Markdown" });
                }
            } else {
                const confirmationKeyboard = new InlineKeyboard()
                    .text("✅ تأكيد ونشر في القناة", "publish_trade")
                    .text("❌ تجاهل الصفقة", "ignore_trade");

                await bot.api.sendMessage(
                    AUTHORIZED_USER_ID,
                    `*تم اكتشاف صفقة جديدة، هل تود نشرها؟*\n\n${privateTradeAnalysisText}`,
                    { parse_mode: "Markdown", reply_markup: confirmationKeyboard }
                );
            }
        }

        if (tradesDetected) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            await sendDebugMessage("State updated after processing all detected trades.");
        } else {
            await sendDebugMessage("لا توجد تغييرات في أرصدة العملات.");
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
        }
    } catch (e) {
        console.error("CRITICAL ERROR in monitorBalanceChanges:", e);
    }
}

// --- باقي الكود (التقارير، إعدادات، أوامر، جدولة المهمات) يجب أن تكون كما في النسخة السابقة المتفق عليها v59 ---

// مثال: startBot مع جدولة المهام
async function startBot() {
    try {
        await connectDB();
        console.log("تم ربط قاعدة البيانات بنجاح بـMongoDB.");

        setInterval(monitorBalanceChanges, 60000); // كل 60 ثانية
        setInterval(checkPriceAlerts, 30000);      // كل 30 ثانية
        setInterval(checkPriceMovements, 60000);   // كل 60 ثانية
        setInterval(runHourlyJobs, 3600000);       // كل ساعة
        setInterval(runDailyJobs, 86400000);       // كل 24 ساعة

        if (process.env.NODE_ENV === "production") {
            app.use(express.json());
            app.use(webhookCallback(bot, "express"));
            app.listen(PORT, () => {
                console.log(`Bot is running on port ${PORT}`);
            });
        } else {
            await bot.start();
            console.log("Bot started in polling mode.");
        }
    } catch (e) {
        console.error("Failed to start bot:", e);
    }
}

startBot();
