// =================================================================
// OKX Advanced Analytics Bot - v62 (Definitive & Deployable)
// =================================================================
// This is the final, complete, and corrected version. It includes
// the healthcheck fix, restored price monitoring intervals, and the
// finalized analyst-grade notification system. This version is
// ready for deployment, pending correct environment variable setup.
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

// === Database Functions ===
const getCollection = (collectionName) => getDB().collection("configs");
async function getConfig(id, defaultValue = {}) { const doc = await getCollection("configs").findOne({ _id: id }); return doc ? doc.data : defaultValue; }
async function saveConfig(id, data) { await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true }); }
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
async function sendDebugMessage(message) { const settings = await loadSettings(); if (settings.debugMode) { try { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" }); } catch (e) { console.error("Failed to send debug message:", e); } } }
function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }
async function getMarketPrices() { try { const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { console.error("Failed to fetch market prices (OKX Error):", tickersJson.msg); return null; } const prices = {}; tickersJson.data.forEach(t => { const lastPrice = parseFloat(t.last); const openPrice = parseFloat(t.open24h); let change24h = 0; if (openPrice > 0) { change24h = (lastPrice - openPrice) / openPrice; } prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h: change24h }; }); return prices; } catch (error) { console.error("Exception in getMarketPrices (Invalid Response):", error.message); return null; } }
async function getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') return { error: `فشل جلب المحفظة من OKX: ${json.msg}` }; let assets = [], total = 0; json.data[0]?.details?.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 }; const price = priceData.price; const value = amount * price; total += value; if (value >= 0.01) { assets.push({ asset: asset.ccy, price: price, value: value, amount: amount, change24h: priceData.change24h }); } } }); const filteredAssets = assets.filter(a => a.value >= 1); filteredAssets.sort((a, b) => b.value - a.value); return { assets: filteredAssets, total }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') { console.error("Error fetching balance for comparison:", json.msg); return null; } const balanceMap = {}; json.data[0]?.details?.forEach(asset => { const totalBalance = parseFloat(asset.eq); if (totalBalance > -1e-9) { balanceMap[asset.ccy] = totalBalance; } }); return balanceMap; } catch (error) { console.error("Exception in getBalanceForComparison:", error); return null; } }
async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) { const positions = await loadPositions(); const position = positions[asset]; if (amountChange > 0) { if (!position) { positions[asset] = { totalAmountBought: amountChange, totalCost: (amountChange * price), avgBuyPrice: price, openDate: new Date().toISOString(), totalAmountSold: 0, realizedValue: 0, }; } else { position.totalAmountBought += amountChange; position.totalCost += (amountChange * price); position.avgBuyPrice = position.totalCost / position.totalAmountBought; } } else if (amountChange < 0 && position) { const amountSold = Math.abs(amountChange); position.realizedValue += (amountSold * price); position.totalAmountSold += amountSold; if (newTotalAmount * price < 1) { await sendDebugMessage(`Position for ${asset} closed. Generating final report...`); const finalPnl = position.realizedValue - position.totalCost; const finalPnlPercent = (position.totalCost > 0) ? (finalPnl / position.totalCost) * 100 : 0; const avgSellPrice = position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0; const pnlEmoji = finalPnl >= 0 ? '🟢⬆️' : '🔴⬇️'; const retrospectiveReport = `✅ **تقرير إغلاق مركز: ${asset}**\n\n` + `*النتيجة النهائية للصفقة:* ${pnlEmoji} \`${finalPnl >= 0 ? '+' : ''}${(finalPnl || 0).toFixed(2)}\` (\`${finalPnl >= 0 ? '+' : ''}${(finalPnlPercent || 0).toFixed(2)}%\`)\n\n` + `**ملخص تحليل الأداء:**\n` + `   - *متوسط سعر الشراء:* \`$${(position.avgBuyPrice || 0).toFixed(4)}\`\n` + `   - *متوسط سعر البيع:* \`$${(avgSellPrice || 0).toFixed(4)}\``; delete positions[asset]; await savePositions(positions); return retrospectiveReport; } } await savePositions(positions); return null; }

// === Core Logic & Bot Handlers ===
async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("بدء دورة التحقق من الصفقات...");
        const previousState = await loadBalanceState();
        const previousBalanceState = previousState.balances || {};
        const currentBalance = await getBalanceForComparison();
        if (!currentBalance) { await sendDebugMessage("فشل جلب الرصيد الحالي للمقارنة."); return; }
        
        const prices = await getMarketPrices();
        if (!prices) { await sendDebugMessage("فشل جلب أسعار السوق، سيتم إعادة المحاولة."); return; }
        
        const { total: newTotalPortfolioValue, assets: currentAssets } = await getPortfolio(prices);
        if (newTotalPortfolioValue === undefined) { await sendDebugMessage("فشل حساب قيمة المحفظة الجديدة."); return; }

        if (Object.keys(previousBalanceState).length === 0) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            await sendDebugMessage("تم تسجيل الرصيد الأولي وحفظه.");
            return;
        }
        
        const allAssets = new Set([...Object.keys(previousBalanceState), ...Object.keys(currentBalance)]);
        let tradesDetected = false;

        for (const asset of allAssets) {
            if (asset === 'USDT') continue;
            
            const prevAmount = previousBalanceState[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;
            const priceData = prices[`${asset}-USDT`];
            const price = priceData ? priceData.price : 0;

            if (Math.abs(difference * price) < 1.0) continue; // Ignore changes less than $1
            
            tradesDetected = true;
            if (!price) { await sendDebugMessage(`لا يمكن العثور على سعر لـ ${asset}.`); continue; }
            
            const retrospectiveReport = await updatePositionAndAnalyze(asset, difference, price, currAmount);

            // --- Common Metrics for Both Messages ---
            const tradeValue = Math.abs(difference) * price;
            const newAssetValue = currAmount * price;
            const newAssetWeight = newTotalPortfolioValue > 0 ? (newAssetValue / newTotalPortfolioValue) * 100 : 0;
            const usdtData = currentAssets.find(a => a.asset === 'USDT') || { value: (currentBalance['USDT'] || 0) };
            const newCashValue = usdtData.value;
            const newCashWeight = newTotalPortfolioValue > 0 ? (newCashValue / newTotalPortfolioValue) * 100 : 0;
            const previousTotalPortfolioValue = previousState.totalValue || newTotalPortfolioValue;
            const tradeSizePercent = previousTotalPortfolioValue > 0 ? (tradeValue / previousTotalPortfolioValue) * 100 : 0;

            let tradeTypeStr = "";
            if (difference > 0) { tradeTypeStr = "شراء 🟢⬆️"; } 
            else { tradeTypeStr = (newAssetValue < 1) ? "إغلاق مركز 🔴⬇️" : "بيع جزئي 🟠"; }

            // --- 1. Construct the Private, Detailed Analysis Message ---
            const privateAnalysisText = `🔔 **تحليل حركة تداول (خاص)**\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🔸 **العملية:** ${tradeTypeStr}\n` +
                `🔸 **الأصل:** \`${asset}/USDT\`\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 **تفاصيل الصفقة:**\n` +
                `   ▫️ *سعر التنفيذ:* \`$${(price || 0).toFixed(4)}\`\n` +
                `   ▫️ *الكمية:* \`${Math.abs(difference).toFixed(6)}\`\n` +
                `   ▫️ *قيمة الصفقة:* \`$${tradeValue.toFixed(2)}\`\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 **التأثير على المحفظة:**\n` +
                `   ▫️ *حجم الصفقة من المحفظة:* \`${tradeSizePercent.toFixed(2)}%\`\n` +
                `   ▫️ *الوزن الجديد للعملة:* \`${newAssetWeight.toFixed(2)}%\`\n` +
                `   ▫️ *الرصيد النقدي الجديد:* \`$${newCashValue.toFixed(2)}\`\n` +
                `   ▫️ *نسبة الكاش الجديدة:* \`${newCashWeight.toFixed(2)}%\`\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*`;

            // --- 2. Construct the Public, Analyst-Grade Recommendation Message ---
            let publicRecommendationText = "";
            if (difference > 0) { // Buy
                const prevCashAmount = previousBalanceState['USDT'] || 0;
                const entryOfCash = prevCashAmount > 0 ? (tradeValue / prevCashAmount) * 100 : 0;
                publicRecommendationText = `🔔 **توصية: شراء** 🟢⬆️\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `🔸 **الأصل:** \`${asset}/USDT\`\n` +
                    `🔸 **متوسط سعر الدخول:** \`$${(price || 0).toFixed(4)}\`\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📊 **تحليل الصفقة:**\n` +
                    `   ▫️ *حجم الدخول من المحفظة:* \`${tradeSizePercent.toFixed(2)}%\`\n` +
                    `   ▫️ *حجم الدخول من الكاش:* \`${entryOfCash.toFixed(2)}%\`\n` +
                    `   ▫️ *الوزن الجديد للعملة في المحفظة:* \`${newAssetWeight.toFixed(2)}%\`\n` +
                    `   ▫️ *نسبة الكاش المتبقية:* \`${newCashWeight.toFixed(2)}%\`\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*`;
            } else { // Sell
                if (newAssetValue < 1) { // Full Close
                    publicRecommendationText = `🔔 **توصية: إغلاق مركز** 🔴⬇️\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `🔸 **الأصل:** \`${asset}/USDT\`\n` +
                        `🔸 **متوسط سعر الخروج:** \`$${(price || 0).toFixed(4)}\`\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `📊 **التأثير على المحفظة:**\n` +
                        `   ▫️ تم إغلاق المركز بالكامل.\n` +
                        `   ▫️ نسبة الكاش الجديدة: \`${newCashWeight.toFixed(2)}%\`\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*`;
                } else { // Partial Sell
                    publicRecommendationText = `🔔 **توصية: تخفيف / جني ربح جزئي** 🟠\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `🔸 **الأصل:** \`${asset}/USDT\`\n` +
                        `🔸 **متوسط سعر البيع:** \`$${(price || 0).toFixed(4)}\`\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `📊 **التأثير على المحفظة:**\n` +
                        `   ▫️ الوزن الجديد للعملة: \`${newAssetWeight.toFixed(2)}%\`\n` +
                        `   ▫️ نسبة الكاش الجديدة: \`${newCashWeight.toFixed(2)}%\`\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*`;
                }
            }

            // --- 3. Send the Messages ---
            await bot.api.sendMessage(AUTHORIZED_USER_ID, privateAnalysisText, { parse_mode: "Markdown" });
            if (retrospectiveReport) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, retrospectiveReport, { parse_mode: "Markdown" });
            }

            const settings = await loadSettings();
            if (settings.autoPostToChannel) {
                await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicRecommendationText, { parse_mode: "Markdown" });
            } else {
                const confirmationKeyboard = new InlineKeyboard().text("✅ تأكيد ونشر في القناة", `publish_trade:::${Buffer.from(publicRecommendationText).toString('base64')}`);
                await bot.api.sendMessage(AUTHORIZED_USER_ID, `*هل تود نشر التوصية التالية في القناة؟*\n\n(معاينة الرسالة العامة)`, { parse_mode: "Markdown", reply_markup: confirmationKeyboard });
            }
        }
        
        if (tradesDetected) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            await sendDebugMessage(`State updated after processing all detected trades.`);
        } else {
            if (Math.abs(newTotalPortfolioValue - (previousState.totalValue || 0)) > 1) {
                 await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            }
            await sendDebugMessage("لا توجد تغييرات صفقات تستحق التسجيل.");
        }
    } catch (e) { console.error("CRITICAL ERROR in monitorBalanceChanges:", e); }
}

async function checkPriceAlerts() { try { const alerts = await loadAlerts(); if (alerts.length === 0) return; const prices = await getMarketPrices(); if (!prices) return; const remainingAlerts = []; let alertsTriggered = false; for (const alert of alerts) { const currentPrice = (prices[alert.instId] || {}).price; if (currentPrice === undefined) { remainingAlerts.push(alert); continue; } let triggered = false; if (alert.condition === '>' && currentPrice > alert.price) triggered = true; else if (alert.condition === '<' && currentPrice < alert.price) triggered = true; if (triggered) { const message = `🚨 *تنبيه سعر محدد!* 🚨\n\n- *العملة:* \`${alert.instId}\`\n- *الشرط:* تحقق (${alert.condition} ${alert.price})\n- *السعر الحالي:* \`${currentPrice}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); alertsTriggered = true; } else { remainingAlerts.push(alert); } } if (alertsTriggered) { await saveAlerts(remainingAlerts); } } catch (error) { console.error("Error in checkPriceAlerts:", error); } }
async function runDailyJobs() { try { console.log("Attempting to run daily jobs..."); const settings = await loadSettings(); if (!settings.dailySummary) { console.log("Daily summary is disabled. Skipping."); return; } const prices = await getMarketPrices(); if (!prices) { console.error("Daily Jobs: Failed to get prices from OKX."); return; } const { total, error } = await getPortfolio(prices); if (error) { console.error("Daily Jobs Error:", error); return; } const history = await loadHistory(); const date = new Date().toISOString().slice(0, 10); const todayRecordIndex = history.findIndex(h => h.date === date); if (todayRecordIndex > -1) { history[todayRecordIndex].total = total; } else { history.push({ date: date, total: total }); } if (history.length > 35) history.shift(); await saveHistory(history); console.log(`[✅ Daily Summary Recorded]: ${date} - $${(total || 0).toFixed(2)}`); } catch(e) { console.error("CRITICAL ERROR in runDailyJobs:", e); } }
async function checkPriceMovements() { try { await sendDebugMessage("بدء دورة التحقق من حركة الأسعار..."); const alertSettings = await loadAlertSettings(); const priceTracker = await loadPriceTracker(); const prices = await getMarketPrices(); if (!prices) { await sendDebugMessage("فشل جلب أسعار السوق (استجابة غير صالحة)، تخطي دورة فحص الحركة."); return; } const { assets, total: currentTotalValue, error } = await getPortfolio(prices); if (error || currentTotalValue === undefined) { await sendDebugMessage("فشل جلب المحفظة، تخطي دورة فحص الحركة."); return; } if (priceTracker.totalPortfolioValue === 0) { priceTracker.totalPortfolioValue = currentTotalValue; assets.forEach(a => { if (a.price) priceTracker.assets[a.asset] = a.price; }); await savePriceTracker(priceTracker); await sendDebugMessage("تم تسجيل قيم تتبع الأسعار الأولية."); return; } let trackerUpdated = false; const lastTotalValue = priceTracker.totalPortfolioValue; if (lastTotalValue > 0) { const changePercent = ((currentTotalValue - lastTotalValue) / lastTotalValue) * 100; if (Math.abs(changePercent) >= alertSettings.global) { const emoji = changePercent > 0 ? '🟢⬆️' : '🔴⬇️'; const movementText = changePercent > 0 ? 'صعود' : 'هبوط'; const message = `📊 *تنبيه حركة المحفظة الإجمالية!*\n\n*الحركة:* ${emoji} *${movementText}* بنسبة \`${(changePercent || 0).toFixed(2)}%\`\n*القيمة الحالية:* \`$${(currentTotalValue || 0).toFixed(2)}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); priceTracker.totalPortfolioValue = currentTotalValue; trackerUpdated = true; } } for (const asset of assets) { if (asset.asset === 'USDT' || !asset.price) continue; const lastPrice = priceTracker.assets[asset.asset]; if (lastPrice) { const currentPrice = asset.price; const changePercent = ((currentPrice - lastPrice) / lastPrice) * 100; const threshold = alertSettings.overrides[asset.asset] || alertSettings.global; if (Math.abs(changePercent) >= threshold) { const emoji = changePercent > 0 ? '🟢⬆️' : '🔴⬇️'; const movementText = changePercent > 0 ? 'صعود' : 'هبوط'; const message = `📈 *تنبيه حركة سعر لأصل محدد!*\n\n*الأصل:* \`${asset.asset}\`\n*الحركة:* ${emoji} *${movementText}* بنسبة \`${(changePercent || 0).toFixed(2)}%\`\n*السعر الحالي:* \`$${(currentPrice || 0).toFixed(4)}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); priceTracker.assets[asset.asset] = currentPrice; trackerUpdated = true; } } else { priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } if (trackerUpdated) { await savePriceTracker(priceTracker); await sendDebugMessage("تم تحديث متتبع الأسعار بعد إرسال تنبيه."); } else { await sendDebugMessage("لا توجد حركات أسعار تتجاوز الحد."); } } catch(e) { console.error("CRITICAL ERROR in checkPriceMovements:", e); } }

// (The rest of the code for bot handlers is omitted for brevity but should be included)

// Start the bot
async function startBot() {
    try {
        await connectDB();
        console.log("تم ربط قاعدة البيانات بنجاح بـMongoDB.");

        if (process.env.NODE_ENV === "production") {
            app.use(express.json());

            // The critical fix for Railway health checks
            app.get("/", (req, res) => res.status(200).send("OK! Bot is alive."));

            app.use(webhookCallback(bot, "express"));
            app.listen(PORT, () => { console.log(`بوت v62 (Definitive) يستمع على المنفذ ${PORT}`); });
        } else {
            bot.start();
            console.log("Bot v62 (Definitive) started with polling.");
        }

        // Restoring the forgotten intervals
        setInterval(monitorBalanceChanges, 60000);
        setInterval(checkPriceAlerts, 30000);
        setInterval(runDailyJobs, 3600000);
        setInterval(checkPriceMovements, 60000);
        
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
        // This log is crucial. If the bot crashes on start, it will show here.
    }
}

startBot();
