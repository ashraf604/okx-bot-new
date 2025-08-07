// =================================================================
// OKX Advanced Analytics Bot - index.js (Complete Fixed v60)
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
    try {
        const doc = await getCollection("configs").findOne({ _id: id });
        return doc ? doc.data : defaultValue;
    } catch (error) {
        console.error(`Error getting config ${id}:`, error);
        return defaultValue;
    }
}

async function saveConfig(id, data) {
    try {
        await getCollection("configs").updateOne({ _id: id }, { $set: { data } }, { upsert: true });
    } catch (error) {
        console.error(`Error saving config ${id}:`, error);
    }
}

// Load/Save functions
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

const loadHistory = () => getConfig("dailyHistory", []);
const saveHistory = (history) => saveConfig("dailyHistory", history);

const loadHourlyHistory = () => getConfig("hourlyHistory", []);
const saveHourlyHistory = (history) => saveConfig("hourlyHistory", history);

// ========== Debug Helper ==========
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

// ========== Market Prices ==========
async function getMarketPrices() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        if (!res.ok) {
            console.error("HTTP error fetching market prices:", res.status);
            return null;
        }
        const json = await res.json();
        if (json.code !== "0") {
            console.error("OKX API error:", json.msg);
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
    } catch (error) {
        console.error("Exception in getMarketPrices:", error);
        return null;
    }
}

// ========== Portfolio ==========
async function getPortfolio(prices) {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        
        if (!res.ok) {
            console.error("HTTP error fetching portfolio:", res.status);
            return { error: "Connection error" };
        }

        const json = await res.json();
        if (json.code !== "0") {
            console.error("OKX portfolio error:", json.msg);
            return { error: json.msg };
        }

        if (!json.data || !json.data[0] || !json.data[0].details) {
            console.error("Invalid portfolio response structure");
            return { error: "Invalid response" };
        }

        let total = 0, assets = [];
        json.data[0].details.forEach(a => {
            const amt = parseFloat(a.eq);
            if (amt > 0) {
                const instId = `${a.ccy}-USDT`;
                const pd = prices[instId] || { price: a.ccy === "USDT" ? 1 : 0, change24h: 0 };
                const val = amt * pd.price;
                total += val;
                if (val >= 1) {
                    assets.push({ 
                        asset: a.ccy, 
                        amount: amt, 
                        price: pd.price, 
                        value: val, 
                        change24h: pd.change24h || 0 
                    });
                }
            }
        });
        
        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (error) {
        console.error("Exception in getPortfolio:", error);
        return { error: "Connection error" };
    }
}

// ========== Balance Comparison ==========
async function getBalanceForComparison() {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        
        if (!res.ok) {
            console.error("HTTP error fetching balance:", res.status);
            return null;
        }

        const json = await res.json();
        if (json.code !== "0") {
            console.error("OKX balance error:", json.msg);
            return null;
        }

        if (!json.data || !json.data[0] || !json.data[0].details) {
            console.error("Invalid balance response structure");
            return null;
        }

        const balanceMap = {};
        json.data[0].details.forEach(a => {
            const eq = parseFloat(a.eq);
            if (!isNaN(eq)) {
                balanceMap[a.ccy] = eq;
            }
        });
        return balanceMap;
    } catch (error) {
        console.error("Exception in getBalanceForComparison:", error);
        return null;
    }
}

// ========== Update & Analyze Position ==========
async function updatePositionAndAnalyze(asset, diff, price, newAmt) {
    if (!price || isNaN(price) || price <= 0) {
        console.error(`Invalid price for ${asset}: ${price}`);
        return null;
    }

    const positions = await loadPositions();
    const position = positions[asset];
    const tradeValue = Math.abs(diff) * price;
    let report = null;

    if (diff > 0) {
        // Buy
        if (!position) {
            positions[asset] = {
                totalAmountBought: diff,
                totalCost: tradeValue,
                avgBuyPrice: price,
                openDate: new Date().toISOString(),
                totalAmountSold: 0,
                realizedValue: 0,
            };
        } else {
            position.totalAmountBought += diff;
            position.totalCost += tradeValue;
            position.avgBuyPrice = position.totalCost / position.totalAmountBought;
        }
    } else if (diff < 0 && position) {
        // Sell
        const soldAmount = Math.abs(diff);
        position.realizedValue += tradeValue;
        position.totalAmountSold += soldAmount;
        
        if (newAmt * price < 1) {
            // Position closed
            const finalPnl = position.realizedValue - position.totalCost;
            const finalPnlPercent = position.totalCost > 0 ? (finalPnl / position.totalCost) * 100 : 0;
            const avgSellPrice = position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0;
            const pnlEmoji = finalPnl >= 0 ? "🟢⬆️" : "🔴⬇️";
            const pnlSign = finalPnl >= 0 ? "+" : "";

            report = `✅ **تقرير إغلاق مركز: ${asset}**\n\n` +
                `*النتيجة النهائية:* ${pnlEmoji} \`${pnlSign}${finalPnl.toFixed(2)}\` (\`${pnlSign}${finalPnlPercent.toFixed(2)}%\`)\n\n` +
                `**تفاصيل الأداء:**\n` +
                ` - *متوسط سعر الشراء:* \`$${position.avgBuyPrice.toFixed(4)}\`\n` +
                ` - *متوسط سعر البيع:* \`$${avgSellPrice.toFixed(4)}\`\n` +
                ` - *إجمالي المبلغ المستثمر:* \`$${position.totalCost.toFixed(2)}\`\n` +
                ` - *إجمالي المبلغ المحقق:* \`$${position.realizedValue.toFixed(2)}\``;

            delete positions[asset];
        }
    }

    await savePositions(positions);
    return report;
}

// ========== Monitor Balance Changes ==========
async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("بدء دورة التحقق من الصفقات...");
        
        const previousState = await loadBalanceState();
        const previousBalanceState = previousState.balances || {};
        const previousTotalPortfolioValue = previousState.totalValue || 0;

        const currentBalance = await getBalanceForComparison();
        if (!currentBalance) {
            await sendDebugMessage("فشل جلب الرصيد الحالي.");
            return;
        }

        const prices = await getMarketPrices();
        if (!prices) {
            await sendDebugMessage("فشل جلب أسعار السوق.");
            return;
        }

        const { total: newTotalPortfolioValue, assets: currentAssets, error } = await getPortfolio(prices);
        if (error) {
            await sendDebugMessage(`خطأ في جلب المحفظة: ${error}`);
            return;
        }

        if (Object.keys(previousBalanceState).length === 0) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            await sendDebugMessage("تم تسجيل الرصيد الأولي.");
            return;
        }

        const allAssets = new Set([...Object.keys(previousBalanceState), ...Object.keys(currentBalance)]);
        let tradesDetected = false;

        for (const asset of allAssets) {
            if (asset === "USDT") continue;

            const prevAmount = previousBalanceState[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;

            const priceData = prices[`${asset}-USDT`];
            if (!priceData || !priceData.price || isNaN(priceData.price)) {
                continue;
            }

            // Skip very small changes
            const tradeValue = Math.abs(difference) * priceData.price;
            if (tradeValue < 0.1) continue;

            tradesDetected = true;
            const price = priceData.price;

            // Generate position report if closing
            const retrospectiveReport = await updatePositionAndAnalyze(asset, difference, price, currAmount);
            if (retrospectiveReport) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, retrospectiveReport, { parse_mode: "Markdown" });
            }

            // Calculate portfolio impact
            const newAssetValue = currAmount * price;
            const portfolioPercentage = newTotalPortfolioValue > 0 ? (newAssetValue / newTotalPortfolioValue) * 100 : 0;
            const usdtAsset = currentAssets.find(a => a.asset === 'USDT') || { value: 0 };
            const newCashValue = usdtAsset.value;
            const newCashPercentage = newTotalPortfolioValue > 0 ? (newCashValue / newTotalPortfolioValue) * 100 : 0;
            const entryOfPortfolio = previousTotalPortfolioValue > 0 ? (tradeValue / previousTotalPortfolioValue) * 100 : 0;

            // Determine trade type
            let tradeType = "";
            if (difference > 0) {
                tradeType = "شراء 🟢⬆️";
            } else {
                tradeType = (currAmount * price < 1) ? "إغلاق مركز 🔴⬇️" : "بيع جزئي 🟠";
            }

            // Private detailed message (for user)
            const privateTradeAnalysisText = 
                `🔔 تحليل حركة تداول\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🔸 العملية: ${tradeType}\n` +
                `🔸 الأصل: ${asset}/USDT\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 تفاصيل الصفقة:\n` +
                ` ▫️ سعر التنفيذ: $${price.toFixed(4)}\n` +
                ` ▫️ الكمية: ${Math.abs(difference).toFixed(6)}\n` +
                ` ▫️ قيمة الصفقة: $${tradeValue.toFixed(2)}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 التأثير على المحفظة:\n` +
                ` ▫️ حجم الصفقة من المحفظة: ${entryOfPortfolio.toFixed(2)}%\n` +
                ` ▫️ الوزن الجديد للعملة: ${portfolioPercentage.toFixed(2)}%\n` +
                ` ▫️ الرصيد النقدي الجديد: $${newCashValue.toFixed(2)}\n` +
                ` ▫️ نسبة الكاش الجديدة: ${newCashPercentage.toFixed(2)}%\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;

            const settings = await loadSettings();
            
            if (settings.autoPostToChannel) {
                // Channel simplified message
                const channelText = 
                    `🔔 توصية جديدة: ${difference > 0 ? "شراء 🟢" : "بيع 🔴"}\n\n` +
                    `العملة: ${asset}/USDT\n` +
                    `متوسط سعر الدخول: ~ $${price.toFixed(4)}\n` +
                    `حجم الدخول: ${entryOfPortfolio.toFixed(2)}% من المحفظة\n` +
                    `تم استخدام: ${(100 - newCashPercentage).toFixed(2)}% من الكاش المتاح\n` +
                    `تمثل الآن: ${portfolioPercentage.toFixed(2)}% من المحفظة`;

                try {
                    // Send to channel first
                    await bot.api.sendMessage(TARGET_CHANNEL_ID, channelText, { parse_mode: "Markdown" });
                    // Send detailed to user
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, privateTradeAnalysisText, { parse_mode: "Markdown" });
                    // Success notification
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ تم نشر الصفقة تلقائيًا في القناة.", { parse_mode: "Markdown" });
                } catch (e) {
                    console.error("Failed to auto-post to channel:", e);
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, "❌ فشل النشر التلقائي في القناة. يرجى التحقق من صلاحيات البوت.", { parse_mode: "Markdown" });
                }
            } else {
                // Manual confirmation
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
            await sendDebugMessage("تم تحديث حالة الرصيد بعد معالجة الصفقات.");
        } else {
            await sendDebugMessage("لا توجد تغييرات في أرصدة العملات.");
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
        }
    } catch (e) {
        console.error("Critical error in monitorBalanceChanges:", e);
    }
}

// ========== Check Price Alerts ==========
async function checkPriceAlerts() {
    try {
        const alerts = await loadAlerts();
        if (alerts.length === 0) return;

        const prices = await getMarketPrices();
        if (!prices) return;

        const remainingAlerts = [];
        let alertsTriggered = false;

        for (const alert of alerts) {
            const currentPrice = prices[alert.instId]?.price;
            if (currentPrice === undefined) {
                remainingAlerts.push(alert);
                continue;
            }

            let triggered = false;
            if (alert.condition === '>' && currentPrice > alert.price) triggered = true;
            else if (alert.condition === '<' && currentPrice < alert.price) triggered = true;

            if (triggered) {
                const message = `🚨 *تنبيه سعر!* 🚨\n\n` +
                    `- *العملة:* \`${alert.instId}\`\n` +
                    `- *الشرط:* ${alert.condition} ${alert.price}\n` +
                    `- *السعر الحالي:* \`${currentPrice.toFixed(4)}\``;
                
                await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
                alertsTriggered = true;
            } else {
                remainingAlerts.push(alert);
            }
        }

        if (alertsTriggered) {
            await saveAlerts(remainingAlerts);
        }
    } catch (error) {
        console.error("Error in checkPriceAlerts:", error);
    }
}

// ========== Check Price Movements ==========
async function checkPriceMovements() {
    try {
        const alertSettings = await loadAlertSettings();
        const priceTracker = await loadPriceTracker();
        const prices = await getMarketPrices();
        if (!prices) return;

        const { assets, total: currentTotalValue, error } = await getPortfolio(prices);
        if (error || currentTotalValue === undefined) return;

        if (priceTracker.totalPortfolioValue === 0) {
            priceTracker.totalPortfolioValue = currentTotalValue;
            assets.forEach(a => {
                if (a.price) priceTracker.assets[a.asset] = a.price;
            });
            await savePriceTracker(priceTracker);
            return;
        }

        let trackerUpdated = false;
        const lastTotalValue = priceTracker.totalPortfolioValue;

        if (lastTotalValue > 0) {
            const changePercent = ((currentTotalValue - lastTotalValue) / lastTotalValue) * 100;
            if (Math.abs(changePercent) >= alertSettings.global) {
                const emoji = changePercent > 0 ? '🟢⬆️' : '🔴⬇️';
                const movementText = changePercent > 0 ? 'صعود' : 'هبوط';
                const message = `📊 *تنبيه حركة المحفظة الإجمالية!*\n\n` +
                    `*الحركة:* ${emoji} *${movementText}* بنسبة \`${changePercent.toFixed(2)}%\`\n` +
                    `*القيمة الحالية:* \`$${currentTotalValue.toFixed(2)}\``;
                
                await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
                priceTracker.totalPortfolioValue = currentTotalValue;
                trackerUpdated = true;
            }
        }

        for (const asset of assets) {
            if (asset.asset === 'USDT' || !asset.price) continue;
            
            const lastPrice = priceTracker.assets[asset.asset];
            if (lastPrice) {
                const currentPrice = asset.price;
                const changePercent = ((currentPrice - lastPrice) / lastPrice) * 100;
                const threshold = alertSettings.overrides[asset.asset] || alertSettings.global;
                
                if (Math.abs(changePercent) >= threshold) {
                    const emoji = changePercent > 0 ? '🟢⬆️' : '🔴⬇️';
                    const movementText = changePercent > 0 ? 'صعود' : 'هبوط';
                    const message = `📈 *تنبيه حركة سعر!*\n\n` +
                        `*الأصل:* \`${asset.asset}\`\n` +
                        `*الحركة:* ${emoji} *${movementText}* بنسبة \`${changePercent.toFixed(2)}%\`\n` +
                        `*السعر الحالي:* \`$${currentPrice.toFixed(4)}\``;
                    
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
                    priceTracker.assets[asset.asset] = currentPrice;
                    trackerUpdated = true;
                }
            } else {
                priceTracker.assets[asset.asset] = asset.price;
                trackerUpdated = true;
            }
        }

        if (trackerUpdated) {
            await savePriceTracker(priceTracker);
        }
    } catch (e) {
        console.error("Error in checkPriceMovements:", e);
    }
}

// ========== Hourly Jobs ==========
async function runHourlyJobs() {
    try {
        const prices = await getMarketPrices();
        if (!prices) return;

        const { total, error } = await getPortfolio(prices);
        if (error) return;

        const history = await loadHourlyHistory();
        const now = new Date();
        const hourLabel = now.toISOString().slice(0, 13);
        
        const existingIndex = history.findIndex(h => h.label === hourLabel);
        if (existingIndex > -1) {
            history[existingIndex].total = total;
        } else {
            history.push({ label: hourLabel, total });
        }

        if (history.length > 72) {
            history.splice(0, history.length - 72);
        }

        await saveHourlyHistory(history);
        await sendDebugMessage(`تم حفظ السجل الساعي: ${hourLabel} - $${total.toFixed(2)}`);
    } catch (e) {
        console.error("خطأ في المهام الساعية:", e);
    }
}

// ========== Daily Jobs ==========
async function runDailyJobs() {
    try {
        console.log("Running daily jobs...");
        const settings = await loadSettings();
        if (!settings.dailySummary) {
            console.log("Daily summary is disabled. Skipping.");
            return;
        }

        const prices = await getMarketPrices();
        if (!prices) {
            console.error("Daily Jobs: Failed to get prices from OKX.");
            return;
        }

        const { total, error } = await getPortfolio(prices);
        if (error) {
            console.error("Daily Jobs Error:", error);
            return;
        }

        const history = await loadHistory();
        const date = new Date().toISOString().slice(0, 10);
        const todayRecordIndex = history.findIndex(h => h.date === date);

        if (todayRecordIndex > -1) {
            history[todayRecordIndex].total = total;
        } else {
            history.push({ date, total });
        }

        if (history.length > 35) {
            history.shift();
        }

        await saveHistory(history);
        console.log(`[✅ Daily Summary Recorded]: ${date} - $${total.toFixed(2)}`);
    } catch (e) {
        console.error("CRITICAL ERROR in runDailyJobs:", e);
    }
}

// ========== Healthcheck ==========
app.get("/healthcheck", (req, res) => {
    res.status(200).send("OK");
});

// ========== Bot UI & Commands ==========

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();

async function sendSettingsMenu(ctx) {
    const settings = await loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital")
        .text("💼 عرض المراكز", "view_positions").row()
        .text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts")
        .text("🗑️ حذف تنبيه سعر", "delete_alert").row()
        .text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
        .text(`🚀 النشر التلقائي: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost")
        .text(`🐞 وضع Debug: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").row()
        .text("🔥 حذف جميع البيانات", "delete_all_data");

    const text = "⚙️ *الإعدادات الرئيسية*";
    try {
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
    } catch {
        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
    }
}

async function sendMovementAlertsMenu(ctx) {
    const alertSettings = await loadAlertSettings();
    const text = `🚨 *إدارة تنبيهات حركة الأسعار*\n\n` +
        `- *النسبة العامة:* \`${alertSettings.global}%\`\n` +
        `- *التخصيصات:* ${Object.keys(alertSettings.overrides).length ? 
            Object.keys(alertSettings.overrides).map(c => `${c}:${alertSettings.overrides[c]}%`).join(", ") : 
            "لا يوجد"}`;
    
    const keyboard = new InlineKeyboard()
        .text("📊 تعديل النسبة العامة", "set_global_alert").row()
        .text("💎 تخصيص عملة", "set_coin_alert").row()
        .text("📄 عرض الإعدادات", "view_movement_alerts").row()
        .text("🔙 رجوع", "back_to_settings");

    try {
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch {
        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    }
}

// ========== Bot Middleware ==========
bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        await next();
    } else {
        console.log(`محاولة وصول غير مصرح به من: ${ctx.from?.id || 'غير محدد'}`);
    }
});

// ========== Bot Commands ==========
bot.command("start", async (ctx) => {
    await ctx.reply(
        `🤖 *بوت OKX التحليلي المتقدم*\n*الإصدار: v60 (Fixed & Complete)*\n\nأهلاً بك! أنا هنا لمساعدتك في تتبع وتحليل محفظتك الاستثمارية.`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard }
    );
});

bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));

bot.command("pnl", async (ctx) => {
    const args = ctx.match.trim().split(/\s+/);
    if (args.length !== 3 || args[0] === '') {
        return await ctx.reply(
            `❌ *صيغة غير صحيحة*\n\n` +
            `*استخدم:* \`/pnl <سعر_الشراء> <سعر_البيع> <الكمية>\`\n\n` +
            `*مثال:* \`/pnl 50000 60000 0.5\``,
            { parse_mode: "Markdown" }
        );
    }

    const [buyPrice, sellPrice, quantity] = args.map(parseFloat);
    if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) {
        return await ctx.reply("❌ تأكد من أن جميع القيم أرقام موجبة.");
    }

    const totalInvestment = buyPrice * quantity;
    const totalSaleValue = sellPrice * quantity;
    const profitOrLoss = totalSaleValue - totalInvestment;
    const pnlPercentage = (profitOrLoss / totalInvestment) * 100;
    const resultStatus = profitOrLoss >= 0 ? "ربح ✅" : "خسارة 🔻";
    const pnlSign = profitOrLoss >= 0 ? '+' : '';

    const responseMessage = 
        `🧮 *نتيجة حساب الربح والخسارة*\n\n` +
        `📝 **المدخلات:**\n` +
        ` - *سعر الشراء:* \`$${buyPrice.toLocaleString()}\`\n` +
        ` - *سعر البيع:* \`$${sellPrice.toLocaleString()}\`\n` +
        ` - *الكمية:* \`${quantity.toLocaleString()}\`\n\n` +
        `📊 **النتائج:**\n` +
        ` - *تكلفة الشراء:* \`$${totalInvestment.toLocaleString()}\`\n` +
        ` - *قيمة البيع:* \`$${totalSaleValue.toLocaleString()}\`\n` +
        ` - *صافي الربح/الخسارة:* \`${pnlSign}$${Math.abs(profitOrLoss).toLocaleString()}\` (\`${pnlSign}${pnlPercentage.toFixed(2)}%\`)\n\n` +
        `**النتيجة: ${resultStatus}**`;

    await ctx.reply(responseMessage, { parse_mode: "Markdown" });
});

// ========== Bot Callbacks ==========
bot.on("callback_query:data", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        const data = ctx.callbackQuery.data;
        if (!ctx.callbackQuery.message) return;

        if (data.startsWith("publish_")) {
            let finalRecommendation = ctx.callbackQuery.message.text.replace("*تم اكتشاف صفقة جديدة، هل تود نشرها؟*\n\n", "");
            try {
                await bot.api.sendMessage(TARGET_CHANNEL_ID, finalRecommendation, { parse_mode: "Markdown" });
                await ctx.editMessageText("✅ تم نشر الصفقة في القناة بنجاح.", { reply_markup: undefined });
            } catch (e) {
                console.error("Failed to post to channel:", e);
                await ctx.editMessageText("❌ فشل النشر في القناة.", { reply_markup: undefined });
            }
            return;
        }

        if (data === "ignore_trade") {
            await ctx.editMessageText("❌ تم تجاهل الصفقة.", { reply_markup: undefined });
            return;
        }

        switch (data) {
            case "view_positions":
                const positions = await loadPositions();
                if (Object.keys(positions).length === 0) {
                    await ctx.editMessageText("ℹ️ لا توجد مراكز مفتوحة حاليًا.", 
                        { reply_markup: new InlineKeyboard().text("🔙 رجوع", "back_to_settings") });
                } else {
                    let msg = "📄 *المراكز المفتوحة:*\n\n";
                    for (const [symbol, pos] of Object.entries(positions)) {
                        msg += `╭─ *${symbol}*\n`;
                        msg += `├─ *متوسط الشراء:* \`$${pos.avgBuyPrice?.toFixed(4) || 'N/A'}\`\n`;
                        msg += `├─ *الكمية:* \`${pos.totalAmountBought?.toFixed(6) || 'N/A'}\`\n`;
                        msg += `╰─ *تاريخ الفتح:* \`${new Date(pos.openDate).toLocaleDateString('ar-EG')}\`\n\n`;
                    }
                    await ctx.editMessageText(msg, { 
                        parse_mode: "Markdown", 
                        reply_markup: new InlineKeyboard().text("🔙 رجوع", "back_to_settings") 
                    });
                }
                break;

            case "back_to_settings":
                await sendSettingsMenu(ctx);
                break;

            case "manage_movement_alerts":
                await sendMovementAlertsMenu(ctx);
                break;

            case "set_global_alert":
                waitingState = 'set_global_alert_state';
                await ctx.editMessageText("✍️ يرجى إرسال النسبة المئوية العامة (مثال: 5 لـ 5%).");
                break;

            case "set_coin_alert":
                waitingState = 'set_coin_alert_state';
                await ctx.editMessageText("✍️ يرجى إرسال رمز العملة والنسبة.\n*مثال:* `BTC 2.5`");
                break;

            case "view_movement_alerts":
                const alertSettings = await loadAlertSettings();
                let msg_alerts = `🚨 *إعدادات تنبيهات الحركة:*\n\n` +
                    `*النسبة العامة:* \`${alertSettings.global}%\`\n` +
                    `--------------------\n*النسب المخصصة:*\n`;
                
                if (Object.keys(alertSettings.overrides).length === 0) {
                    msg_alerts += "لا توجد نسب مخصصة.";
                } else {
                    for (const [coin, percentage] of Object.entries(alertSettings.overrides)) {
                        msg_alerts += `- *${coin}:* \`${percentage}%\`\n`;
                    }
                }
                
                await ctx.editMessageText(msg_alerts, { 
                    parse_mode: "Markdown", 
                    reply_markup: new InlineKeyboard().text("🔙 رجوع", "manage_movement_alerts") 
                });
                break;

            case "set_capital":
                waitingState = 'set_capital';
                await ctx.editMessageText("💰 يرجى إرسال المبلغ الجديد لرأس المال.", { reply_markup: undefined });
                break;

            case "delete_alert":
                const alerts = await loadAlerts();
                if (alerts.length === 0) {
                    await ctx.editMessageText("ℹ️ لا توجد تنبيهات سعر مسجلة.", 
                        { reply_markup: new InlineKeyboard().text("🔙 رجوع", "back_to_settings") });
                } else {
                    let msg = "🗑️ *قائمة تنبيهات السعر:*\n\n";
                    alerts.forEach((alert, index) => {
                        msg += `*${index + 1}.* \`${alert.instId}\` ${alert.condition === '>' ? 'أعلى من' : 'أقل من'} \`${alert.price}\`\n`;
                    });
                    msg += "\n*يرجى إرسال رقم التنبيه للحذف.*";
                    waitingState = 'delete_alert_number';
                    await ctx.editMessageText(msg, { parse_mode: "Markdown" });
                }
                break;

            case "toggle_summary":
            case "toggle_autopost":
            case "toggle_debug":
                let settings = await loadSettings();
                if (data === 'toggle_summary') settings.dailySummary = !settings.dailySummary;
                else if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel;
                else if (data === 'toggle_debug') settings.debugMode = !settings.debugMode;
                await saveSettings(settings);
                await sendSettingsMenu(ctx);
                break;

            case "delete_all_data":
                waitingState = 'confirm_delete_all';
                await ctx.editMessageText(
                    "⚠️ *تحذير: هذا الإجراء لا يمكن التراجع عنه!*\n\n" +
                    "سيتم حذف جميع البيانات.\n\n*للمتابعة، أرسل:* `تأكيد الحذف`",
                    { parse_mode: "Markdown", reply_markup: undefined }
                );
                setTimeout(() => {
                    if (waitingState === 'confirm_delete_all') waitingState = null;
                }, 30000);
                break;
        }
    } catch (error) {
        console.error("Error in callback_query handler:", error);
    }
});

// ========== Bot Messages ==========
bot.on("message:text", async (ctx) => {
    try {
        const text = ctx.message.text.trim();
        if (text.startsWith('/')) return;

        // Handle menu buttons
        switch (text) {
            case "📊 عرض المحفظة":
                await ctx.reply("⏳ جاري إعداد تقرير المحفظة...");
                const prices = await getMarketPrices();
                if (!prices) {
                    return await ctx.reply("❌ فشل في جلب أسعار السوق. يرجى المحاولة لاحقًا.");
                }
                const capital = await loadCapital();
                const { assets, total, error } = await getPortfolio(prices);
                if (error) {
                    return await ctx.reply(`❌ ${error}`);
                }
                
                let portfolioMsg = `🧾 *تقرير المحفظة*\n\n`;
                portfolioMsg += `*القيمة الإجمالية:* \`$${total.toFixed(2)}\`\n`;
                portfolioMsg += `*رأس المال:* \`$${capital.toFixed(2)}\`\n`;
                const pnl = capital > 0 ? total - capital : 0;
                const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
                const pnlEmoji = pnl >= 0 ? '🟢⬆️' : '🔴⬇️';
                const pnlSign = pnl >= 0 ? '+' : '';
                portfolioMsg += `*P&L الإجمالي:* ${pnlEmoji} \`${pnlSign}${pnl.toFixed(2)}\` (\`${pnlSign}${pnlPercent.toFixed(2)}%\`)\n\n`;
                
                portfolioMsg += `💎 *مكونات المحفظة:*\n`;
                assets.forEach((asset, index) => {
                    const percent = total > 0 ? ((asset.value / total) * 100) : 0;
                    portfolioMsg += `\n*${asset.asset}*\n`;
                    portfolioMsg += `├─ القيمة: \`$${asset.value.toFixed(2)}\` (\`${percent.toFixed(2)}%\`)\n`;
                    portfolioMsg += `├─ السعر: \`$${asset.price.toFixed(4)}\`\n`;
                    const change24hPercent = (asset.change24h || 0) * 100;
                    const changeEmoji = change24hPercent >= 0 ? '🟢' : '🔴';
                    portfolioMsg += `╰─ التغيير 24س: ${changeEmoji} \`${change24hPercent.toFixed(2)}%\``;
                });
                
                await ctx.reply(portfolioMsg, { parse_mode: "Markdown" });
                return;

            case "⚙️ الإعدادات":
                await sendSettingsMenu(ctx);
                return;

            case "ℹ️ معلومات عملة":
                waitingState = 'coin_info';
                await ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`).", { parse_mode: "Markdown" });
                return;

            case "🔔 ضبط تنبيه":
                waitingState = 'set_alert';
                await ctx.reply(
                    "✍️ *لضبط تنبيه سعر:*\n`<رمز العملة> <> <السعر>`\n\n*أمثلة:*\n`BTC-USDT > 70000`\n`ETH-USDT < 3500`",
                    { parse_mode: "Markdown" }
                );
                return;

            case "🧮 حاسبة الربح والخسارة":
                await ctx.reply(
                    "✍️ استخدم الأمر `/pnl` لحساب الربح/الخسارة:\n\n*مثال:*\n`/pnl 50000 60000 0.5`",
                    { parse_mode: "Markdown" }
                );
                return;
        }

        // Handle waiting states
        if (waitingState) {
            const state = waitingState;
            waitingState = null;

            switch (state) {
                case 'set_capital':
                    const amount = parseFloat(text);
                    if (!isNaN(amount) && amount >= 0) {
                        await saveCapital(amount);
                        await ctx.reply(`✅ *تم تحديث رأس المال*\n\n💰 **المبلغ الجديد:** \`$${amount.toFixed(2)}\``, { parse_mode: "Markdown" });
                    } else {
                        await ctx.reply("❌ مبلغ غير صالح. يرجى إرسال رقم فقط.");
                    }
                    return;

                case 'set_global_alert_state':
                    const percent = parseFloat(text);
                    if (isNaN(percent) || percent <= 0) {
                        return await ctx.reply("❌ النسبة يجب أن تكون رقمًا موجبًا.");
                    }
                    let alertSettingsGlobal = await loadAlertSettings();
                    alertSettingsGlobal.global = percent;
                    await saveAlertSettings(alertSettingsGlobal);
                    await ctx.reply(`✅ تم تحديث النسبة العامة إلى \`${percent}%\`.`);
                    return;

                case 'set_coin_alert_state':
                    const parts = text.split(/\s+/);
                    if (parts.length !== 2) {
                        return await ctx.reply("❌ صيغة غير صحيحة. استخدم: `SYMBOL PERCENTAGE`");
                    }
                    const [symbol, percentStr] = parts;
                    const coinPercent = parseFloat(percentStr);
                    if (isNaN(coinPercent) || coinPercent < 0) {
                        return await ctx.reply("❌ النسبة يجب أن تكون رقمًا صالحًا.");
                    }
                    let alertSettingsCoin = await loadAlertSettings();
                    if (coinPercent === 0) {
                        delete alertSettingsCoin.overrides[symbol.toUpperCase()];
                        await ctx.reply(`✅ تم حذف الإعداد المخصص لـ *${symbol.toUpperCase()}*`);
                    } else {
                        alertSettingsCoin.overrides[symbol.toUpperCase()] = coinPercent;
                        await ctx.reply(`✅ تم تحديث النسبة لـ *${symbol.toUpperCase()}* إلى \`${coinPercent}%\``);
                    }
                    await saveAlertSettings(alertSettingsCoin);
                    return;

                case 'coin_info':
                    const instId = text.toUpperCase();
                    await ctx.reply(`⏳ جاري البحث عن بيانات ${instId}...`);
                    
                    const prices = await getMarketPrices();
                    if (!prices || !prices[instId]) {
                        return await ctx.reply(`❌ لم يتم العثور على العملة ${instId}`);
                    }
                    
                    const priceData = prices[instId];
                    const change24hPercent = (priceData.change24h || 0) * 100;
                    const changeEmoji = change24hPercent >= 0 ? '🟢' : '🔴';
                    
                    let msg = `ℹ️ *معلومات ${instId}*\n\n`;
                    msg += `▫️ *السعر الحالي:* \`$${priceData.price.toFixed(4)}\`\n`;
                    msg += `▫️ *التغيير 24س:* ${changeEmoji} \`${change24hPercent.toFixed(2)}%\`\n`;
                    msg += `▫️ *سعر الافتتاح 24س:* \`$${priceData.open24h.toFixed(4)}\``;
                    
                    await ctx.reply(msg, { parse_mode: "Markdown" });
                    return;

                case 'set_alert':
                    const alertParts = text.trim().split(/\s+/);
                    if (alertParts.length !== 3) {
                        return await ctx.reply("❌ صيغة غير صحيحة. استخدم: `SYMBOL > PRICE`");
                    }
                    const [alertInstId, condition, priceStr] = alertParts;
                    if (condition !== '>' && condition !== '<') {
                        return await ctx.reply("❌ الشرط غير صالح. استخدم `>` أو `<` فقط.");
                    }
                    const alertPrice = parseFloat(priceStr);
                    if (isNaN(alertPrice) || alertPrice <= 0) {
                        return await ctx.reply("❌ السعر غير صالح.");
                    }
                    const alertsList = await loadAlerts();
                    alertsList.push({ instId: alertInstId.toUpperCase(), condition, price: alertPrice });
                    await saveAlerts(alertsList);
                    await ctx.reply(`✅ تم ضبط التنبيه:\n${alertInstId.toUpperCase()} ${condition === '>' ? 'أعلى من' : 'أقل من'} ${alertPrice}`);
                    return;

                case 'delete_alert_number':
                    const alertIndex = parseInt(text) - 1;
                    let currentAlerts = await loadAlerts();
                    if (isNaN(alertIndex) || alertIndex < 0 || alertIndex >= currentAlerts.length) {
                        return await ctx.reply("❌ رقم غير صالح.");
                    }
                    const removedAlert = currentAlerts.splice(alertIndex, 1)[0];
                    await saveAlerts(currentAlerts);
                    await ctx.reply(`✅ تم حذف التنبيه: \`${removedAlert.instId} ${removedAlert.condition} ${removedAlert.price}\``);
                    return;

                case 'confirm_delete_all':
                    if (text === 'تأكيد الحذف') {
                        await getCollection("configs").deleteMany({});
                        await ctx.reply("✅ تم حذف جميع البيانات بنجاح.");
                    } else {
                        await ctx.reply("❌ تم إلغاء عملية الحذف.");
                    }
                    return;
            }
        }
    } catch (error) {
        console.error("Error in message:text handler:", error);
    }
});

// ========== Start Bot & Server ==========
async function startBot() {
    try {
        await connectDB();
        console.log("جميع المهام المجدولة تم تشغيلها بنجاح.");

        // Schedule Jobs
        setInterval(monitorBalanceChanges, 60000);    // Check trades every 60s
        setInterval(checkPriceAlerts, 30000);         // Check price alerts every 30s  
        setInterval(checkPriceMovements, 60000);      // Check price movements every 60s
        setInterval(runHourlyJobs, 3600000);          // Run hourly jobs every hour
        setInterval(runDailyJobs, 86400000);          // Run daily jobs every 24 hours

        console.log("جميع المهام المجدولة تم تشغيلها بنجاح.");

        // Always use polling instead of webhook
        await bot.start();
        console.log("بوت v60 (Fixed & Enhanced) يستمع على المنفذ", PORT);
        
        // Keep Express server running for healthcheck
        app.listen(PORT, () => {
            console.log(`Server (healthcheck) on port ${PORT}`);
        });

    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        process.exit(1);
    }
}

startBot();
// في نهاية الملف index.js
console.log("🚀 Initializing startBot...");
startBot();

async function startBot() {
    console.log("▶️ Entered startBot()");
    try {
        await connectDB();
        console.log("MongoDB connected.");
        // ... بقية جدول المهام
        await bot.start();  // polling دائم
        console.log("🤖 Bot polling started successfully.");
        app.listen(PORT, () => console.log(`🌐 Healthcheck server on port ${PORT}`));
    } catch (e) {
        console.error("❌ startBot failed:", e);
    }
}
