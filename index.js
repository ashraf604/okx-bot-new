// =================================================================
// OKX Advanced Analytics Bot - v42 (Professional Grade Analysis)
// =================================================================
// This version implements a mathematically accurate, robust model for
// position tracking and retrospective analysis, correctly handling
// partial sells and ensuring data integrity.
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

// === Database Functions (No changes) ===
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

// === Helper & API Functions ===
async function sendDebugMessage(message) { const settings = await loadSettings(); if (settings.debugMode) { try { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" }); } catch (e) { console.error("Failed to send debug message:", e); } } }
function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }
async function getMarketPrices() { try { const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { console.error("Failed to fetch market prices:", tickersJson.msg); return null; } const prices = {}; tickersJson.data.forEach(t => { const lastPrice = parseFloat(t.last); const openPrice = parseFloat(t.open24h); let change24h = 0; if (openPrice > 0) { change24h = (lastPrice - openPrice) / openPrice; } prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h: change24h }; }); return prices; } catch (error) { console.error("Exception in getMarketPrices:", error); return null; } }
async function getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') return { error: `فشل جلب المحفظة: ${json.msg}` }; let assets = [], total = 0; json.data[0]?.details?.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 }; const price = priceData.price; const value = amount * price; if (value >= 1) { assets.push({ asset: asset.ccy, price: price, value: value, amount: amount, change24h: priceData.change24h }); } total += value; } }); const filteredAssets = assets.filter(a => a.value >= 1); filteredAssets.sort((a, b) => b.value - a.value); return { assets: filteredAssets, total }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') { console.error("Error fetching balance for comparison:", json.msg); return null; } const balanceMap = {}; json.data[0]?.details?.forEach(asset => { const totalBalance = parseFloat(asset.eq); if (totalBalance > 1e-9) { balanceMap[asset.ccy] = totalBalance; } }); return balanceMap; } catch (error) { console.error("Exception in getBalanceForComparison:", error); return null; } }
// vvv --- التحسين الاحترافي 2: ضمان دقة النطاق الزمني --- vvv
async function getHistoricalHighLow(instId, startDate, endDate) {
    try {
        const startMs = new Date(startDate).getTime();
        const endMs = endDate.getTime();
        // Use `before` and `after` for a precise time range, increasing data reliability.
        const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&before=${startMs}&after=${endMs}`);
        const json = await res.json();
        
        if (json.code !== '0' || !json.data || json.data.length === 0) {
            console.error(`Could not fetch history for ${instId}:`, json.msg);
            return { high: 0 };
        }
        
        const highs = json.data.map(c => parseFloat(c[2])); // High price is at index 2
        return { high: Math.max(...highs) };
    } catch (e) {
        console.error(`Exception in getHistoricalHighLow for ${instId}:`, e);
        return { high: 0 };
    }
}
// ^^^ --- نهاية التحسين --- ^^^


// === Core Logic & Bot Handlers ===

// vvv --- التحسين الاحترافي 1: منطق دقيق لإدارة المراكز --- vvv
async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) {
    const positions = await loadPositions();
    const position = positions[asset];
    const tradeValue = Math.abs(amountChange) * price;
    let retrospectiveReport = null;

    if (amountChange > 0) { // --- حالة الشراء ---
        if (!position) { // فتح مركز جديد
            positions[asset] = {
                totalAmountBought: amountChange,
                totalCost: tradeValue,
                avgBuyPrice: price,
                openDate: new Date().toISOString(),
                // Initialize fields for tracking sales
                totalAmountSold: 0,
                realizedValue: 0,
            };
        } else { // تعزيز مركز حالي
            position.totalAmountBought += amountChange;
            position.totalCost += tradeValue;
            position.avgBuyPrice = position.totalCost / position.totalAmountBought;
        }
    } else if (amountChange < 0 && position) { // --- حالة البيع ---
        const amountSold = Math.abs(amountChange);

        // Update sales tracking
        position.realizedValue += tradeValue;
        position.totalAmountSold += amountSold;
        
        if (newTotalAmount < 0.0001) { // **إغلاق المركز بالكامل**
            await sendDebugMessage(`Position for ${asset} closed. Generating final report...`);

            // Final, accurate PnL calculation
            const finalPnl = position.realizedValue - position.totalCost;
            const finalPnlPercent = (position.totalCost > 0) ? (finalPnl / position.totalCost) * 100 : 0;
            const avgSellPrice = position.realizedValue / position.totalAmountSold;
            const pnlEmoji = finalPnl >= 0 ? '🟢' : '🔴';
            
            // Get peak price during the holding period
            const { high: peakPrice } = await getHistoricalHighLow(`${asset}-USDT`, position.openDate, new Date());
            
            let efficiencyText = "";
            if (peakPrice > position.avgBuyPrice) {
                // Maximum potential PnL if all was sold at the peak
                const maxPotentialPnl = (peakPrice - position.avgBuyPrice) * position.totalAmountBought;
                if (maxPotentialPnl > 0 && finalPnl > 0) {
                    const exitEfficiency = (finalPnl / maxPotentialPnl) * 100;
                    efficiencyText = `\n   - *كفاءة الخروج:* لقد حققت **${exitEfficiency.toFixed(1)}%** من أقصى ربح ممكن.`;
                }
            }

            retrospectiveReport = `✅ **تم إغلاق مركز ${asset}**\n\n` +
                `*النتيجة النهائية:* ${pnlEmoji} ربح \`${finalPnl >= 0 ? '+' : ''}${finalPnl.toFixed(2)}$\` (\`${finalPnl >= 0 ? '+' : ''}${finalPnlPercent.toFixed(2)}%\`)\n\n` +
                `**تحليل الأداء:**\n` +
                `   - *متوسط الشراء:* \`$${position.avgBuyPrice.toFixed(4)}\`\n` +
                `   - *متوسط البيع:* \`$${avgSellPrice.toFixed(4)}\`\n` +
                `   - *أعلى سعر خلال الاحتفاظ:* \`$${peakPrice.toFixed(4)}\`` +
                efficiencyText;
            
            delete positions[asset]; // Clean up the closed position
        } else { // **بيع جزئي (تخفيف)**
            // No action needed other than updating sales record, which is already done.
            await sendDebugMessage(`Partial sell for ${asset} recorded.`);
        }
    }

    await savePositions(positions);
    return retrospectiveReport;
}
// ^^^ --- نهاية المنطق الاحترافي --- ^^^

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
                const position = positions[a.asset];
                const avgBuyPrice = position.avgBuyPrice;
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
        
        const prices = await getMarketPrices();
        if (!prices) { await sendDebugMessage("فشل جلب الأسعار."); return; }

        const allAssets = new Set([...Object.keys(previousBalanceState), ...Object.keys(currentBalance)]);
        for (const asset of allAssets) {
            if (asset === 'USDT') continue;
            const prevAmount = previousBalanceState[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;

            if (Math.abs(difference) < 1e-9) continue;
            
            const priceData = prices[`${asset}-USDT`];
            if (!priceData || !priceData.price) {
                await sendDebugMessage(`لا يمكن العثور على سعر لـ ${asset}. سيتم تجاهل هذا التغيير.`);
                continue;
            }
            const price = priceData.price;
            
            const retrospectiveReport = await updatePositionAndAnalyze(asset, difference, price, currAmount);
            
            if (retrospectiveReport) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, retrospectiveReport, { parse_mode: "Markdown" });
            }
            
            await saveBalanceState(currentBalance);
            await sendDebugMessage(`State updated after processing trade for ${asset}. Halting cycle to prevent duplicates.`);
            return; // Process one trade at a time
        }
        
        await sendDebugMessage("لا توجد تغييرات.");
        await saveBalanceState(currentBalance);
    } catch (e) {
        console.error("CRITICAL ERROR in monitorBalanceChanges:", e);
        await sendDebugMessage(`Critical Error in Monitor: ${e.message}`);
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


// --- Main Execution Logic & Bot Commands ---
bot.command("start", (ctx) => ctx.reply("أهلاً بك في بوت التحليل المتقدم لمنصة OKX. الإصدار الاحترافي v42."));

// Add other commands here as needed, like /portfolio, /settings, etc.

// Start the bot
async function startBot() {
    await connectDB();
    console.log("Database connected!");

    if (process.env.NODE_ENV === "production") {
        app.use(express.json());
        app.use(webhookCallback(bot, "express"));
        app.listen(PORT, () => console.log(`Bot listening on port ${PORT}`));
    } else {
        bot.start();
        console.log("Bot started with polling.");
    }

    // Set interval timers for recurring tasks
    setInterval(monitorBalanceChanges, 60000); // Check every 60 seconds
    setInterval(checkPriceAlerts, 30000); // Check every 30 seconds
    // You could also add an interval for runDailyJobs
}

startBot();
