// =================================================================
// OKX Advanced Analytics Bot - v57 (Comprehensive Trade Notifications)
// =================================================================
// This version introduces a completely redesigned, detailed private
// notification for every trade, fulfilling the user's core requirement.
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
async function getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') return { error: `فشل جلب المحفظة من OKX: ${json.msg}` }; let assets = [], total = 0; json.data[0]?.details?.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 }; const price = priceData.price; const value = amount * price; total += value; if (value >= 1) { assets.push({ asset: asset.ccy, price: price, value: value, amount: amount, change24h: priceData.change24h }); } } }); const filteredAssets = assets.filter(a => a.value >= 1); filteredAssets.sort((a, b) => b.value - a.value); return { assets: filteredAssets, total }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') { console.error("Error fetching balance for comparison:", json.msg); return null; } const balanceMap = {}; json.data[0]?.details?.forEach(asset => { const totalBalance = parseFloat(asset.eq); if (totalBalance > -1e-9) { balanceMap[asset.ccy] = totalBalance; } }); return balanceMap; } catch (error) { console.error("Exception in getBalanceForComparison:", error); return null; } }
async function getInstrumentDetails(instId) { try { const tickerRes = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const tickerJson = await tickerRes.json(); if (tickerJson.code !== '0' || !tickerJson.data[0]) return { error: `لم يتم العثور على العملة.` }; const tickerData = tickerJson.data[0]; const candleRes = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId.toUpperCase()}&bar=1D&limit=7`); const candleJson = await candleRes.json(); let weeklyData = { high: 0, low: 0 }; if (candleJson.code === '0' && candleJson.data.length > 0) { const highs = candleJson.data.map(c => parseFloat(c[2])); const lows = candleJson.data.map(c => parseFloat(c[3])); weeklyData.high = Math.max(...highs); weeklyData.low = Math.min(...lows); } return { price: parseFloat(tickerData.last), high24h: parseFloat(tickerData.high24h), low24h: parseFloat(tickerData.low24h), vol24h: parseFloat(tickerData.volCcy24h), open24h: parseFloat(tickerData.open24h), weeklyHigh: weeklyData.high, weeklyLow: weeklyData.low }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getHistoricalHighLow(instId, startDate, endDate) { try { const startMs = new Date(startDate).getTime(); const endMs = endDate.getTime(); const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&before=${startMs}&after=${endMs}`); const json = await res.json(); if (json.code !== '0' || !json.data || json.data.length === 0) { console.error(`Could not fetch history for ${instId}:`, json.msg); return { high: 0 }; } const highs = json.data.map(c => parseFloat(c[2])); return { high: Math.max(...highs) }; } catch (e) { console.error(`Exception in getHistoricalHighLow for ${instId}:`, e); return { high: 0 }; } }
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values[0]; const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0; const maxValue = Math.max(...values); const minValue = Math.min(...values); const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length; return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue }; }
function createChartUrl(history, periodLabel, pnl) { if (history.length < 2) return null; const chartColor = pnl >= 0 ? 'rgb(75, 192, 75)' : 'rgb(255, 99, 132)'; const chartBgColor = pnl >= 0 ? 'rgba(75, 192, 75, 0.2)' : 'rgba(255, 99, 132, 0.2)'; const labels = history.map(h => h.label); const data = history.map(h => h.total.toFixed(2)); const chartConfig = { type: 'line', data: { labels: labels, datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: chartBgColor, borderColor: chartColor, tension: 0.1 }] }, options: { title: { display: true, text: `أداء المحفظة - ${periodLabel}` } } }; return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`; }

// === Core Logic & Bot Handlers ===
async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) { const positions = await loadPositions(); const position = positions[asset]; const tradeValue = Math.abs(amountChange) * price; let retrospectiveReport = null; if (amountChange > 0) { if (!position) { positions[asset] = { totalAmountBought: amountChange, totalCost: tradeValue, avgBuyPrice: price, openDate: new Date().toISOString(), totalAmountSold: 0, realizedValue: 0, }; } else { position.totalAmountBought += amountChange; position.totalCost += tradeValue; position.avgBuyPrice = position.totalCost / position.totalAmountBought; } } else if (amountChange < 0 && position) { const amountSold = Math.abs(amountChange); position.realizedValue += tradeValue; position.totalAmountSold += amountSold; if (newTotalAmount * price < 1) { await sendDebugMessage(`Position for ${asset} closed. Generating final report...`); const finalPnl = position.realizedValue - position.totalCost; const finalPnlPercent = (position.totalCost > 0) ? (finalPnl / position.totalCost) * 100 : 0; const avgSellPrice = position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0; const pnlEmoji = finalPnl >= 0 ? '🟢⬆️' : '🔴⬇️'; const { high: peakPrice } = await getHistoricalHighLow(`${asset}-USDT`, position.openDate, new Date()); let efficiencyText = ""; if (peakPrice > position.avgBuyPrice) { const maxPotentialPnl = (peakPrice - position.avgBuyPrice) * position.totalAmountBought; if (maxPotentialPnl > 0 && finalPnl > 0) { const exitEfficiency = (finalPnl / maxPotentialPnl) * 100; efficiencyText = `\n   - *كفاءة الخروج:* لقد حققت **${(exitEfficiency || 0).toFixed(1)}%** من أقصى ربح ممكن.`; } } retrospectiveReport = `✅ **تقرير إغلاق مركز: ${asset}**\n\n` + `*النتيجة النهائية للصفقة:* ${pnlEmoji} \`${finalPnl >= 0 ? '+' : ''}${(finalPnl || 0).toFixed(2)}\` (\`${finalPnl >= 0 ? '+' : ''}${(finalPnlPercent || 0).toFixed(2)}%\`)\n\n` + `**ملخص تحليل الأداء:**\n` + `   - *متوسط سعر الشراء:* \`$${(position.avgBuyPrice || 0).toFixed(4)}\`\n` + `   - *متوسط سعر البيع:* \`$${(avgSellPrice || 0).toFixed(4)}\`\n` + `   - *أعلى سعر خلال فترة التملك:* \`$${(peakPrice || 0).toFixed(4)}\`` + efficiencyText; delete positions[asset]; } else { await sendDebugMessage(`Partial sell for ${asset} recorded.`); } } await savePositions(positions); return retrospectiveReport; }
async function formatPortfolioMsg(assets, total, capital) { const history = await loadHistory(); const positions = await loadPositions(); let dailyPnlText = "   ▫️ *الأداء اليومي (24س):* `لا توجد بيانات كافية`\n"; if (history.length > 0) { const todayStr = new Date().toISOString().slice(0, 10); const previousDayRecord = history.filter(h => h.date !== todayStr).pop(); if (previousDayRecord && typeof previousDayRecord.total === 'number') { const dailyPnl = total - previousDayRecord.total; const dailyPnlPercent = previousDayRecord.total > 0 ? (dailyPnl / previousDayRecord.total) * 100 : 0; const dailyPnlEmoji = dailyPnl >= 0 ? '🟢⬆️' : '🔴⬇️'; const dailyPnlSign = dailyPnl >= 0 ? '+' : ''; dailyPnlText = `   ▫️ *الأداء اليومي (24س):* ${dailyPnlEmoji} \`${dailyPnlSign}${(dailyPnl || 0).toFixed(2)}\` (\`${dailyPnlSign}${(dailyPnlPercent || 0).toFixed(2)}%\`)\n`; } } let pnl = capital > 0 ? total - capital : 0; let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0; let pnlEmoji = pnl >= 0 ? '🟢⬆️' : '🔴⬇️'; let pnlSign = pnl >= 0 ? '+' : ''; const usdtAsset = assets.find(a => a.asset === 'USDT'); const usdtValue = usdtAsset ? usdtAsset.value : 0; const cashPercent = total > 0 ? (usdtValue / total) * 100 : 0; const investedPercent = 100 - cashPercent; const liquidityText = `   ▫️ *توزيع السيولة:* 💵 نقدي ${(cashPercent || 0).toFixed(1)}% / 📈 مستثمر ${(investedPercent || 0).toFixed(1)}%`; let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n`; msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`; msg += `━━━━━━━━━━━━━━━━━━━\n`; msg += `📊 *نظرة عامة على الأداء:*\n`; msg += `   ▫️ *القيمة الإجمالية:* \`$${(total || 0).toFixed(2)}\`\n`; msg += `   ▫️ *رأس المال المسجل:* \`$${(capital || 0).toFixed(2)}\`\n`; msg += `   ▫️ *إجمالي الربح غير المحقق:* ${pnlEmoji} \`${pnlSign}${(pnl || 0).toFixed(2)}\` (\`${pnlSign}${(pnlPercent || 0).toFixed(2)}%\`)\n`; msg += dailyPnlText; msg += liquidityText + `\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n`; msg += `💎 *مكونات المحفظة:*\n`; assets.forEach((a, index) => { let percent = total > 0 ? ((a.value / total) * 100) : 0; msg += "\n"; if (a.asset === "USDT") { msg += `*USDT* (الرصيد النقدي) 💵\n`; msg += `*القيمة:* \`$${(a.value || 0).toFixed(2)}\` (*الوزن:* \`${(percent || 0).toFixed(2)}%\`)`; } else { const change24hPercent = (a.change24h || 0) * 100; const changeEmoji = change24hPercent >= 0 ? '🟢⬆️' : '🔴⬇️'; const changeSign = change24hPercent >= 0 ? '+' : ''; msg += `╭─ *${a.asset}/USDT*\n`; msg += `├─ *القيمة الحالية:* \`$${(a.value || 0).toFixed(2)}\` (*الوزن:* \`${(percent || 0).toFixed(2)}%\`)\n`; msg += `├─ *سعر السوق:* \`$${(a.price || 0).toFixed(4)}\`\n`; msg += `├─ *الأداء اليومي:* ${changeEmoji} \`${changeSign}${(change24hPercent || 0).toFixed(2)}%\`\n`; const position = positions[a.asset]; if (position && position.avgBuyPrice > 0) { const avgBuyPrice = position.avgBuyPrice; const totalCost = avgBuyPrice * a.amount; const assetPnl = a.value - totalCost; const assetPnlPercent = (totalCost > 0) ? (assetPnl / totalCost) * 100 : 0; const assetPnlEmoji = assetPnl >= 0 ? '🟢⬆️' : '🔴⬇️'; const assetPnlSign = assetPnl >= 0 ? '+' : ''; msg += `├─ *متوسط الشراء:* \`$${(avgBuyPrice || 0).toFixed(4)}\`\n`; msg += `╰─ *ربح/خسارة غير محقق:* ${assetPnlEmoji} \`${assetPnlSign}${(assetPnl || 0).toFixed(2)}\` (\`${assetPnlSign}${(assetPnlPercent || 0).toFixed(2)}%\`)`; } else { msg += `╰─ *متوسط الشراء:* \`غير مسجل\``; } } if (index < assets.length - 1) { msg += `\n━━━━━━━━━━━━━━━━━━━━`; } }); return msg; }

// vvv --- The overhauled trade monitoring logic --- vvv
async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("بدء دورة التحقق من الصفقات...");
        let previousState = await loadBalanceState();
        let previousBalanceState = previousState.balances || {};
        let previousTotalPortfolioValue = previousState.totalValue || 0;
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
            if (Math.abs(difference * (prices[`${asset}-USDT`]?.price || 0)) < 0.1) continue;
            tradesDetected = true;
            const priceData = prices[`${asset}-USDT`];
            if (!priceData || !priceData.price) { await sendDebugMessage(`لا يمكن العثور على سعر لـ ${asset}.`); continue; }
            const price = priceData.price;
            
            const retrospectiveReport = await updatePositionAndAnalyze(asset, difference, price, currAmount);
            if (retrospectiveReport) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, retrospectiveReport, { parse_mode: "Markdown" });
            }

            const tradeValue = Math.abs(difference) * price;
            const type = difference > 0 ? 'شراء' : 'بيع';
            let publicRecommendationText = "";
            let callbackData = "";
            const newAssetValue = currAmount * price;
            const portfolioPercentage = newTotalPortfolioValue > 0 ? (newAssetValue / newTotalPortfolioValue) * 100 : 0;
            const timestamp = `*بتاريخ: ${new Date().toLocaleDateString("en-GB").replace(/\//g,'.')}*`;
            const tradeEmoji = type === 'شراء' ? '🟢⬆️' : '🔴⬇️';
            
            if (type === 'شراء') {
                const previousUSDTBalance = previousBalanceState['USDT'] || 0;
                const entryOfCash = previousUSDTBalance > 0 ? (tradeValue / previousUSDTBalance) * 100 : 0;
                const oldTotalPortfolioValue = previousState.totalValue || newTotalPortfolioValue;
                const entryOfPortfolio = oldTotalPortfolioValue > 0 ? (tradeValue / oldTotalPortfolioValue) * 100 : 0;

                publicRecommendationText = `🔔 **توصية: شراء** ${tradeEmoji}\n\n` + `🔸 **الأصل:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الدخول:**\n` + `   ▫️ *متوسط سعر الشراء:* \`$${(price || 0).toFixed(4)}\`\n` + `   ▫️ *حجم الدخول من المحفظة:* \`${(entryOfPortfolio || 0).toFixed(2)}%\`\n\n` + `📊 **التأثير على المحفظة:**\n` + `   ▫️ *نسبة استهلاك الكاش:* \`${(entryOfCash || 0).toFixed(2)}%\`\n` + `   ▫️ *الوزن الجديد للعملة:* \`${(portfolioPercentage || 0).toFixed(2)}%\`\n\n${timestamp}`;
                callbackData = `publish_buy_${asset}_${(price || 0).toFixed(4)}_${(entryOfPortfolio || 0).toFixed(2)}_${(entryOfCash || 0).toFixed(2)}_${(portfolioPercentage || 0).toFixed(2)}`;
            } else {
                if (currAmount * price < 1) { // Full close
                    publicRecommendationText = `🔔 **توصية: إغلاق مركز** ${tradeEmoji}\n\n` + `🔸 **الأصل:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الخروج:**\n` + `   ▫️ *متوسط سعر البيع:* \`$${(price || 0).toFixed(4)}\`\n` + `   ▫️ *النتيجة:* تم إغلاق المركز بالكامل وتسييل قيمته.\n\n` + `📊 **التأثير على المحفظة:**\n` + `   ▫️ *القيمة المستعادة للكاش:* \`$${(tradeValue || 0).toFixed(2)}\`\n` + `   ▫️ *الوزن الجديد للعملة:* \`0.00%\`\n\n${timestamp}`;
                    callbackData = `publish_close_${asset}_${(price || 0).toFixed(4)}_${(tradeValue || 0).toFixed(2)}`;
                } else { // Partial sell
                     publicRecommendationText = `🔔 **توصية: تخفيف / جني ربح جزئي** 🟠\n\n` + `🔸 **الأصل:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل التخفيف:**\n` + `   ▫️ *متوسط سعر البيع:* \`$${(price || 0).toFixed(4)}\`\n` + `   ▫️ *النتيجة:* تم بيع جزء من الكمية.\n\n` + `📊 **التأثير على المحفظة:**\n` + `   ▫️ *الوزن الجديد للعملة:* \`${(portfolioPercentage || 0).toFixed(2)}%\`\n\n${timestamp}`;
                     callbackData = `publish_sell_${asset}_${(price || 0).toFixed(4)}_${(portfolioPercentage || 0).toFixed(2)}`;
                }
            }
            
            const settings = await loadSettings();
            if (settings.autoPostToChannel && publicRecommendationText) {
                await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicRecommendationText, { parse_mode: "Markdown" });
            } else if (publicRecommendationText) {
                const confirmationKeyboard = new InlineKeyboard().text("✅ تأكيد ونشر في القناة", callbackData).text("❌ تجاهل الصفقة", "ignore_trade");
                await bot.api.sendMessage(AUTHORIZED_USER_ID, `*تم اكتشاف صفقة جديدة، هل تود نشر التوصية التالية في القناة؟*\n\n${publicRecommendationText}`, { parse_mode: "Markdown", reply_markup: confirmationKeyboard });
            }
        }
        
        if (tradesDetected) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            await sendDebugMessage(`State updated after processing all detected trades.`);
        } else {
            await sendDebugMessage("لا توجد تغييرات في أرصدة العملات.");
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
        }
    } catch (e) {
        console.error("CRITICAL ERROR in monitorBalanceChanges:", e);
    }
}
// ^^^ End of overhauled logic ^^^

async function checkPriceAlerts() { try { const alerts = await loadAlerts(); if (alerts.length === 0) return; const prices = await getMarketPrices(); if (!prices) return; const remainingAlerts = []; let alertsTriggered = false; for (const alert of alerts) { const currentPrice = (prices[alert.instId] || {}).price; if (currentPrice === undefined) { remainingAlerts.push(alert); continue; } let triggered = false; if (alert.condition === '>' && currentPrice > alert.price) triggered = true; else if (alert.condition === '<' && currentPrice < alert.price) triggered = true; if (triggered) { const message = `🚨 *تنبيه سعر محدد!* 🚨\n\n- *العملة:* \`${alert.instId}\`\n- *الشرط:* تحقق (${alert.condition} ${alert.price})\n- *السعر الحالي:* \`${currentPrice}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); alertsTriggered = true; } else { remainingAlerts.push(alert); } } if (alertsTriggered) { await saveAlerts(remainingAlerts); } } catch (error) { console.error("Error in checkPriceAlerts:", error); } }
async function runDailyJobs() { try { console.log("Attempting to run daily jobs..."); const settings = await loadSettings(); if (!settings.dailySummary) { console.log("Daily summary is disabled. Skipping."); return; } const prices = await getMarketPrices(); if (!prices) { console.error("Daily Jobs: Failed to get prices from OKX."); return; } const { total, error } = await getPortfolio(prices); if (error) { console.error("Daily Jobs Error:", error); return; } const history = await loadHistory(); const date = new Date().toISOString().slice(0, 10); const todayRecordIndex = history.findIndex(h => h.date === date); if (todayRecordIndex > -1) { history[todayRecordIndex].total = total; } else { history.push({ date: date, total: total }); } if (history.length > 35) history.shift(); await saveHistory(history); console.log(`[✅ Daily Summary Recorded]: ${date} - $${(total || 0).toFixed(2)}`); } catch(e) { console.error("CRITICAL ERROR in runDailyJobs:", e); } }
async function checkPriceMovements() { try { await sendDebugMessage("بدء دورة التحقق من حركة الأسعار..."); const alertSettings = await loadAlertSettings(); const priceTracker = await loadPriceTracker(); const prices = await getMarketPrices(); if (!prices) { await sendDebugMessage("فشل جلب أسعار السوق (استجابة غير صالحة)، تخطي دورة فحص الحركة."); return; } const { assets, total: currentTotalValue, error } = await getPortfolio(prices); if (error || currentTotalValue === undefined) { await sendDebugMessage("فشل جلب المحفظة، تخطي دورة فحص الحركة."); return; } if (priceTracker.totalPortfolioValue === 0) { priceTracker.totalPortfolioValue = currentTotalValue; assets.forEach(a => { if (a.price) priceTracker.assets[a.asset] = a.price; }); await savePriceTracker(priceTracker); await sendDebugMessage("تم تسجيل قيم تتبع الأسعار الأولية."); return; } let trackerUpdated = false; const lastTotalValue = priceTracker.totalPortfolioValue; if (lastTotalValue > 0) { const changePercent = ((currentTotalValue - lastTotalValue) / lastTotalValue) * 100; if (Math.abs(changePercent) >= alertSettings.global) { const emoji = changePercent > 0 ? '🟢⬆️' : '🔴⬇️'; const movementText = changePercent > 0 ? 'صعود' : 'هبوط'; const message = `📊 *تنبيه حركة المحفظة الإجمالية!*\n\n*الحركة:* ${emoji} *${movementText}* بنسبة \`${(changePercent || 0).toFixed(2)}%\`\n*القيمة الحالية:* \`$${(currentTotalValue || 0).toFixed(2)}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); priceTracker.totalPortfolioValue = currentTotalValue; trackerUpdated = true; } } for (const asset of assets) { if (asset.asset === 'USDT' || !asset.price) continue; const lastPrice = priceTracker.assets[asset.asset]; if (lastPrice) { const currentPrice = asset.price; const changePercent = ((currentPrice - lastPrice) / lastPrice) * 100; const threshold = alertSettings.overrides[asset.asset] || alertSettings.global; if (Math.abs(changePercent) >= threshold) { const emoji = changePercent > 0 ? '🟢⬆️' : '🔴⬇️'; const movementText = changePercent > 0 ? 'صعود' : 'هبوط'; const message = `📈 *تنبيه حركة سعر لأصل محدد!*\n\n*الأصل:* \`${asset.asset}\`\n*الحركة:* ${emoji} *${movementText}* بنسبة \`${(changePercent || 0).toFixed(2)}%\`\n*السعر الحالي:* \`$${(currentPrice || 0).toFixed(4)}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); priceTracker.assets[asset.asset] = currentPrice; trackerUpdated = true; } } else { priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } if (trackerUpdated) { await savePriceTracker(priceTracker); await sendDebugMessage("تم تحديث متتبع الأسعار بعد إرسال تنبيه."); } else { await sendDebugMessage("لا توجد حركات أسعار تتجاوز الحد."); } } catch(e) { console.error("CRITICAL ERROR in checkPriceMovements:", e); } }

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();
async function sendSettingsMenu(ctx) { const settings = await loadSettings(); const settingsKeyboard = new InlineKeyboard().text("💰 تعيين رأس المال", "set_capital").text("💼 عرض المراكز المفتوحة", "view_positions").row().text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts").text("🗑️ حذف تنبيه سعر", "delete_alert").row().text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row().text(`🚀 النشر التلقائي للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost").text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").row().text("🔥 حذف جميع بيانات البوت 🔥", "delete_all_data"); const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*"; try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); } catch { await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); } }
async function sendMovementAlertsMenu(ctx) { const alertSettings = await loadAlertSettings(); const text = `🚨 *إدارة تنبيهات حركة الأسعار*\n\nتستخدم هذه الإعدادات لمراقبة التغيرات المئوية في الأسعار وإعلامك.\n\n- *النسبة العامة الحالية:* سيتم تنبيهك لأي أصل يتحرك بنسبة \`${alertSettings.global}%\` أو أكثر.\n- يمكنك تعيين نسبة مختلفة لعملة معينة لتجاوز الإعداد العام.`; const keyboard = new InlineKeyboard().text("📊 تعديل النسبة العامة", "set_global_alert").row().text("💎 تعديل نسبة عملة محددة", "set_coin_alert").row().text("📄 عرض الإعدادات الحالية", "view_movement_alerts").row().text("🔙 العودة إلى الإعدادات", "back_to_settings"); try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }); } catch { await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard }); } }

bot.use(async (ctx, next) => { if (ctx.from?.id === AUTHORIZED_USER_ID) { await next(); } else { console.log(`محاولة وصول غير مصرح به بواسطة معرف المستخدم: ${ctx.from?.id || 'غير محدد'}`); } });
bot.command("start", async (ctx) => { await ctx.reply(`🤖 *بوت OKX التحليلي المتكامل*\n*الإصدار: v56 - Critical Logic Overhaul*\n\nأهلاً بك! أنا هنا لمساعدتك في تتبع وتحليل محفظتك الاستثمارية.`, { parse_mode: "Markdown", reply_markup: mainKeyboard }); });
bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));
bot.command("pnl", async (ctx) => { const args = ctx.match.trim().split(/\s+/); if (args.length !== 3 || args[0] === '') { return await ctx.reply(`❌ *صيغة غير صحيحة*\n\n` + `*يرجى استخدام الصيغة الصحيحة للأمر.*\n\n` + `*مثال:*\n\`/pnl <سعر الشراء> <سعر البيع> <الكمية>\``, { parse_mode: "Markdown" }); } const [buyPrice, sellPrice, quantity] = args.map(parseFloat); if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) { return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم هي أرقام موجبة."); } const totalInvestment = buyPrice * quantity; const totalSaleValue = sellPrice * quantity; const profitOrLoss = totalSaleValue - totalInvestment; const pnlPercentage = (profitOrLoss / totalInvestment) * 100; const resultStatus = profitOrLoss >= 0 ? "ربح ✅" : "خسارة 🔻"; const pnlSign = profitOrLoss >= 0 ? '+' : ''; const responseMessage = `🧮 *نتيجة حساب الربح والخسارة*\n\n` + `📝 **المدخلات:**\n` + `   - *سعر الشراء:* \`$${buyPrice.toLocaleString()}\`\n` + `   - *سعر البيع:* \`$${sellPrice.toLocaleString()}\`\n` + `   - *الكمية:* \`${quantity.toLocaleString()}\`\n\n` + `📊 **النتائج:**\n` + `   - *إجمالي تك
