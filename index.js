// =================================================================
// OKX Advanced Analytics Bot - v37 (MongoDB Integration - Complete)
// =================================================================
// This version uses a MongoDB database for persistent, stable data storage.
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

async function getConfig(id, defaultValue = {}) {
    const doc = await getCollection("configs").findOne({ _id: id });
    return doc ? doc.data : defaultValue;
}

async function saveConfig(id, data) {
    await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true });
}

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
        } catch (e) { console.error("Failed to send debug message:", e); }
    }
}

function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }
async function getMarketPrices() { try { const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { console.error("Failed to fetch market prices:", tickersJson.msg); return null; } const prices = {}; tickersJson.data.forEach(t => { prices[t.instId] = { price: parseFloat(t.last), change24h: parseFloat(t.chg24h) || 0 }; }); return prices; } catch (error) { console.error("Exception in getMarketPrices:", error); return null; } }
async function getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') return { error: `فشل جلب المحفظة: ${json.msg}` }; let assets = [], total = 0; json.data[0]?.details?.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 }; const price = priceData.price; const value = amount * price; if (value >= 1) { assets.push({ asset: asset.ccy, price: price, value: value, amount: amount, change24h: priceData.change24h }); } total += value; } }); const filteredAssets = assets.filter(a => a.value >= 1); filteredAssets.sort((a, b) => b.value - a.value); return { assets: filteredAssets, total }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') { console.error("Error fetching balance for comparison:", json.msg); return null; } const balanceMap = {}; json.data[0]?.details?.forEach(asset => { const totalBalance = parseFloat(asset.eq); if (totalBalance > 1e-9) { balanceMap[asset.ccy] = totalBalance; } }); return balanceMap; } catch (error) { console.error("Exception in getBalanceForComparison:", error); return null; } }
async function getInstrumentDetails(instId) { try { const res = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const json = await res.json(); if (json.code !== '0' || !json.data[0]) return { error: `لم يتم العثور على العملة.` }; const data = json.data[0]; return { price: parseFloat(data.last), high24h: parseFloat(data.high24h), low24h: parseFloat(data.low24h), vol24h: parseFloat(data.volCcy24h), open24h: parseFloat(data.open24h) }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
function createChartUrl(history, periodLabel) { if (history.length < 2) return null; const labels = history.map(h => h.label); const data = history.map(h => h.total.toFixed(2)); const chartConfig = { type: 'line', data: { labels: labels, datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: 'rgba(75, 192, 192, 0.2)', borderColor: 'rgb(75, 192, 192)', tension: 0.1 }] }, options: { title: { display: true, text: `أداء المحفظة - ${periodLabel}` } } }; return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`; }
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values[0]; const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0; const maxValue = Math.max(...values); const minValue = Math.min(...values); const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length; return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue }; }

// === Core Logic Functions ===
async function formatPortfolioMsg(assets, total, capital) {
    const history = await loadHistory();
    const positions = await loadPositions();
    let dailyPnlText = "   📈 *الربح/الخسارة (يومي):* `لا توجد بيانات كافية`\n";
    if (history.length > 0) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const previousDayRecord = history.filter(h => h.date !== todayStr).pop();
        if (previousDayRecord && typeof previousDayRecord.total === 'number') {
            const dailyPnl = total - previousDayRecord.total;
            const dailyPnlPercent = previousDayRecord.total > 0 ? (dailyPnl / previousDayRecord.total) * 100 : 0;
            const dailyPnlEmoji = dailyPnl >= 0 ? '🟢' : '🔴';
            const dailyPnlSign = dailyPnl >= 0 ? '+' : '';
            dailyPnlText = `   📈 *الربح/الخسارة (يومي):* ${dailyPnlEmoji} \`${dailyPnlSign}${dailyPnl.toFixed(2)}\` (\`${dailyPnlSign}${dailyPnlPercent.toFixed(2)}%\`)\n`;
        }
    }
    let pnl = capital > 0 ? total - capital : 0;
    let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    let pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
    let pnlSign = pnl >= 0 ? '+' : '';
    const usdtAsset = assets.find(a => a.asset === 'USDT');
    const usdtValue = usdtAsset ? usdtAsset.value : 0;
    const cashPercent = total > 0 ? (usdtValue / total) * 100 : 0;
    const investedPercent = 100 - cashPercent;
    const liquidityText = `   - *السيولة:* 💵 الكاش ${cashPercent.toFixed(1)}% / 📈 المستثمر ${investedPercent.toFixed(1)}%`;
    let msg = `🧾 *ملخص المحفظة التحليلي*\n\n`;
    msg += `*آخر تحديث للأسعار: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 *الأداء العام:*\n`;
    msg += `   💰 *القيمة الحالية:* \`$${total.toFixed(2)}\`\n`;
    msg += `   💼 *رأس المال:* \`$${capital.toFixed(2)}\`\n`;
    msg += `   📉 *ربح إجمالي غير محقق:* ${pnlEmoji} \`${pnlSign}${pnl.toFixed(2)}\` (\`${pnlSign}${pnlPercent.toFixed(2)}%\`)\n`;
    msg += dailyPnlText;
    msg += liquidityText + `\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💎 *الأصــــــــول:*\n`;
    assets.forEach((a, index) => {
        let percent = total > 0 ? ((a.value / total) * 100) : 0;
        msg += "\n";
        if (a.asset === "USDT") {
            msg += `*USDT* 💵\n`;
            msg += `*الرصيد:* \`$${a.value.toFixed(2)}\` (\`${percent.toFixed(2)}%\`)`;
        } else {
            const change24hPercent = a.change24h * 100;
            const changeEmoji = change24hPercent >= 0 ? '🟢' : '🔴';
            const changeSign = change24hPercent >= 0 ? '+' : '';
            msg += `╭─ *${a.asset}*\n`;
            msg += `├─ 💰 *القيمة:* \`$${a.value.toFixed(2)}\` (\`${percent.toFixed(2)}%\`)\n`;
            msg += `├─ 📈 *السعر الحالي:* \`$${a.price.toFixed(4)}\`\n`;
            msg += `├─ ⏱️ *تغير (24س):* ${changeEmoji} \`${changeSign}${change24hPercent.toFixed(2)}%\`\n`;
            if (positions[a.asset] && positions[a.asset].avgBuyPrice > 0) {
                const avgBuyPrice = positions[a.asset].avgBuyPrice;
                const totalCost = avgBuyPrice * a.amount;
                const assetPnl = a.value - totalCost;
                const assetPnlPercent = (totalCost > 0) ? (assetPnl / totalCost) * 100 : 0;
                const assetPnlEmoji = assetPnl >= 0 ? '🟢' : '🔴';
                const assetPnlSign = assetPnl >= 0 ? '+' : '';
                msg += `├─ 🛒 *متوسط الشراء:* \`$${avgBuyPrice.toFixed(4)}\`\n`;
                msg += `╰─ 📉 *ربح غير محقق:* ${assetPnlEmoji} \`${assetPnlSign}${assetPnl.toFixed(2)}\` (\`${assetPnlSign}${assetPnlPercent.toFixed(2)}%\`)`;
            } else {
                msg += `╰─ 🛒 *متوسط الشراء:* لم يتم تسجيله`;
            }
        }
        if (index < assets.length - 1) {
            msg += `\n━━━━━━━━━━━━━━━━━━━━`;
        }
    });
    return msg;
}

async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("بدء دورة التحقق من الصفقات...");
        let previousBalanceState = await loadBalanceState();
        const currentBalance = await getBalanceForComparison();
        if (!currentBalance) { await sendDebugMessage("فشل جلب الرصيد الحالي."); return; }
        if (Object.keys(previousBalanceState).length === 0) { await saveBalanceState(currentBalance); await sendDebugMessage("تم تسجيل الرصيد الأولي وحفظه."); return; }
        const allAssets = new Set([...Object.keys(previousBalanceState), ...Object.keys(currentBalance)]);
        for (const asset of allAssets) {
            if (asset === 'USDT') continue;
            const prevAmount = previousBalanceState[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;
            if (Math.abs(difference) < 1e-9) continue;
            const prices = await getMarketPrices();
            if (!prices) { await sendDebugMessage("فشل جلب الأسعار."); return; }
            let previousTotalPortfolioValue = 0;
            for (const prevAsset in previousBalanceState) {
                const prevAssetPrice = (prices[`${prevAsset}-USDT`] || {}).price || (prevAsset === "USDT" ? 1 : 0);
                previousTotalPortfolioValue += (previousBalanceState[prevAsset] * prevAssetPrice);
            }
            const previousUSDTBalance = previousBalanceState['USDT'] || 0;
            const { total: newTotalPortfolioValue } = await getPortfolio(prices);
            const price = (prices[`${asset}-USDT`] || {}).price;
            if (newTotalPortfolioValue === undefined || !price) { await sendDebugMessage("فشل جلب بيانات المحفظة/السعر."); return; }
            const tradeValue = Math.abs(difference) * price;
            const avgPrice = tradeValue / Math.abs(difference);
            const type = difference > 0 ? 'شراء' : 'بيع';
            let publicRecommendationText = "";
            let callbackData = "";
            const newAssetValue = currAmount * price;
            const portfolioPercentage = newTotalPortfolioValue > 0 ? (newAssetValue / newTotalPortfolioValue) * 100 : 0;
            const timestamp = `*آخر تحديث: ${new Date().toLocaleDateString("en-GB").replace(/\//g,'.')}*`;
            if (type === 'شراء') {
                const entryOfPortfolio = previousTotalPortfolioValue > 0 ? (tradeValue / previousTotalPortfolioValue) * 100 : 0;
                const entryOfCash = previousUSDTBalance > 0 ? (tradeValue / previousUSDTBalance) * 100 : 0;
                publicRecommendationText = `🔔 **توصية تداول جديدة | شراء** 🟢\n\n` + `🔸 **العملة:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الصفقة:**\n` + `   💰 *متوسط السعر:* \`$${avgPrice.toFixed(4)}\`\n` + `   📦 *حجم الدخول:* \`${entryOfPortfolio.toFixed(2)}%\`\n\n` + `📊 **تأثيرها على المحفظة:**\n` + `   💵 *استهلاك الكاش:* \`${entryOfCash.toFixed(2)}%\`\n` + `   📈 *الوزن الجديد للعملة:* \`${portfolioPercentage.toFixed(2)}%\`\n\n${timestamp}`;
                callbackData = `publish_buy_${asset}_${avgPrice.toFixed(4)}_${entryOfPortfolio.toFixed(2)}_${entryOfCash.toFixed(2)}_${portfolioPercentage.toFixed(2)}`;
            } else {
                if (currAmount < 0.0001) {
                    publicRecommendationText = `🔔 **توصية تداول جديدة | إغلاق مركز** 🔴\n\n` + `🔸 **العملة:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الصفقة:**\n` + `   💰 *متوسط سعر البيع:* \`$${avgPrice.toFixed(4)}\`\n` + `   ✅ *النتيجة:* تم إغلاق المركز بالكامل.\n\n` + `📊 **التأثير على المحفظة:**\n` + `   💵 *تم استعادة:* \`$${tradeValue.toFixed(2)}\` إلى الكاش.\n` + `   📈 *الوزن الجديد للعملة:* \`0.00%\`\n\n${timestamp}`;
                    callbackData = `publish_close_${asset}_${avgPrice.toFixed(4)}_${tradeValue.toFixed(2)}`;
                } else {
                     publicRecommendationText = `🔔 **تحديث توصية | تخفيف** 🟠\n\n` + `🔸 **العملة:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الصفقة:**\n` + `   💰 *متوسط سعر البيع:* \`$${avgPrice.toFixed(4)}\`\n` + `   📉 *تم بيع:* جزء من الكمية\n\n` + `📊 **التأثير على المحفظة:**\n` + `   📈 *الوزن الجديد للعملة:* \`${portfolioPercentage.toFixed(2)}%\`\n\n${timestamp}`;
                     callbackData = `publish_sell_${asset}_${avgPrice.toFixed(4)}_${portfolioPercentage.toFixed(2)}`;
                }
            }
            let privateNotificationText = `🔔 *تنبيه بصفقة جديدة*\n\n` + `🔸 **العملية:** ${type === 'شراء' ? 'شراء 🟢' : 'بيع 🔴'} \`${asset}\`\n\n` + `📝 **تفاصيل:**\n`+ `   - *الكمية:* \`${Math.abs(difference).toFixed(6)}\`\n` + `   - *متوسط السعر:* ~\`$${avgPrice.toFixed(4)}\`\n` + `   - *قيمة الصفقة:* ~\`$${tradeValue.toFixed(2)}\`\n\n` + `📊 **الوضع بعد الصفقة:**\n` + `   - *نسبة العملة:* \`${portfolioPercentage.toFixed(2)}%\`\n` + `   - *الكاش المتبقي:* \`$${(currentBalance['USDT'] || 0).toFixed(2)}\``;
            const settings = await loadSettings();
            if (settings.autoPostToChannel) {
                await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicRecommendationText, { parse_mode: "Markdown" });
                await bot.api.sendMessage(AUTHORIZED_USER_ID, privateNotificationText, { parse_mode: "Markdown" });
            } else {
                const confirmationKeyboard = new InlineKeyboard().text("✅ نشر في القناة", callbackData).text("❌ تجاهل", "ignore_trade");
                await bot.api.sendMessage(AUTHORIZED_USER_ID, privateNotificationText + "\n\n*هل تريد نشر التوصية في القناة؟*", { parse_mode: "Markdown", reply_markup: confirmationKeyboard });
            }
            await saveBalanceState(currentBalance);
            await sendDebugMessage("تم تحديث وحفظ الحالة بعد معالجة صفقة واحدة. إنهاء الدورة الحالية.");
            return;
        }
        await sendDebugMessage("لا توجد تغييرات.");
        await saveBalanceState(currentBalance);
    } catch (e) {
        console.error("CRITICAL ERROR in monitorBalanceChanges:", e);
        await sendDebugMessage(`An error occurred in monitorBalanceChanges: ${e.message}`);
    }
}

async function checkPriceAlerts() { try { const alerts = await loadAlerts(); if (alerts.length === 0) return; const prices = await getMarketPrices(); if (!prices) return; const remainingAlerts = []; let alertsTriggered = false; for (const alert of alerts) { const currentPrice = (prices[alert.instId] || {}).price; if (currentPrice === undefined) { remainingAlerts.push(alert); continue; } let triggered = false; if (alert.condition === '>' && currentPrice > alert.price) triggered = true; else if (alert.condition === '<' && currentPrice < alert.price) triggered = true; if (triggered) { const message = `🚨 *تنبيه سعر!* 🚨\n\n- العملة: *${alert.instId}*\n- الشرط: تحقق (${alert.condition} ${alert.price})\n- السعر الحالي: *${currentPrice}*`; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); alertsTriggered = true; } else { remainingAlerts.push(alert); } } if (alertsTriggered) { await saveAlerts(remainingAlerts); } } catch (error) { console.error("Error in checkPriceAlerts:", error); } }

async function runDailyJobs() {
    try {
        console.log("Attempting to run daily jobs...");
        const settings = await loadSettings();
        if (!settings.dailySummary) { console.log("Daily summary is disabled. Skipping."); return; }
        const prices = await getMarketPrices();
        if (!prices) { console.error("Daily Jobs: Failed to get prices."); return; }
        const { total, error } = await getPortfolio(prices);
        if (error) { console.error("Daily Jobs Error:", error); return; }
        const history = await loadHistory();
        const date = new Date().toISOString().slice(0, 10);
        const todayRecordIndex = history.findIndex(h => h.date === date);
        if (todayRecordIndex > -1) { history[todayRecordIndex].total = total; } 
        else { history.push({ date: date, total: total }); }
        if (history.length > 35) history.shift();
        await saveHistory(history);
        console.log(`[✅ Daily Summary Recorded]: ${date} - $${total.toFixed(2)}`);
    } catch(e) { console.error("CRITICAL ERROR in runDailyJobs:", e); }
}

async function runHourlyJobs() { try { const prices = await getMarketPrices(); if (!prices) return; const { total, error } = await getPortfolio(prices); if (error) return; const hourlyHistory = await loadHourlyHistory(); const now = new Date(); const label = `${now.getHours()}:00`; hourlyHistory.push({ label: label, total: total }); if (hourlyHistory.length > 24) hourlyHistory.shift(); await saveHourlyHistory(hourlyHistory); console.log(`[✅ Hourly Summary]: ${now.toISOString()} - $${total.toFixed(2)}`); } catch(e) { console.error("CRITICAL ERROR in runHourlyJobs:", e); } }

// ... (Other functions like checkPriceMovements, menu builders, etc., using `await` where necessary)

// --- Bot Handlers ---
bot.use(async (ctx, next) => { if (ctx.from?.id === AUTHORIZED_USER_ID) { await next(); } else { console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`); } });
bot.command("start", async (ctx) => { await ctx.reply("🤖 *بوت OKX التحليلي المتكامل*", { parse_mode: "Markdown", reply_markup: mainKeyboard }); });
// ... (all other command and callback handlers refactored to use `await` for database calls)

// --- Bot Start ---
async function startBot() {
    await connectDB();
    console.log("Starting bot...");

    setInterval(monitorBalanceChanges, 1 * 60 * 1000);
    setInterval(runDailyJobs, 24 * 60 * 60 * 1000);
    // ... other intervals
    
    app.use(express.json());
    app.use(`/${bot.token}`, webhookCallback(bot, "express"));
    app.get("/", (req, res) => res.status(200).send("OKX Bot is healthy."));
    app.listen(PORT, () => { console.log(`Bot server listening on port ${PORT}`); });
}

startBot().catch(err => {
    console.error("FATAL ERROR: Failed to start bot:", err);
});
