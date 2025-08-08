// =================================================================
// OKX Advanced Analytics Bot - v79 (Full Features & All Fixes)
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

// =================================================================
// SECTION 1: DATABASE AND HELPER FUNCTIONS
// =================================================================

const getCollection = (collectionName) => getDB().collection(collectionName);

async function getConfig(id, defaultValue = {}) {
    try {
        const doc = await getCollection("configs").findOne({ _id: id });
        return doc ? doc.data : defaultValue;
    } catch (e) {
        console.error(`Error in getConfig for id: ${id}`, e);
        return defaultValue;
    }
}

async function saveConfig(id, data) {
    try {
        await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true });
    } catch (e) {
        console.error(`Error in saveConfig for id: ${id}`, e);
    }
}

async function saveClosedTrade(tradeData) {
    try {
        await getCollection("tradeHistory").insertOne(tradeData);
    } catch (e) {
        console.error("Error in saveClosedTrade:", e);
    }
}

async function getHistoricalPerformance(asset) {
    try {
        const history = await getCollection("tradeHistory").find({ asset: asset }).toArray();
        if (history.length === 0) {
            return { realizedPnl: 0, tradeCount: 0, winningTrades: 0, losingTrades: 0, avgDuration: 0 };
        }
        
        const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0);
        const winningTrades = history.filter(trade => trade.pnl > 0).length;
        const losingTrades = history.filter(trade => trade.pnl <= 0).length;
        const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0);
        const avgDuration = history.length > 0 ? totalDuration / history.length : 0;

        return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration };
    } catch (e) {
        console.error(`Error fetching historical performance for ${asset}:`, e);
        return null;
    }
}

const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadSettings = async () => await getConfig("settings", { dailySummary: true, autoPostToChannel: false, debugMode: false });
const saveSettings = (settings) => saveConfig("settings", settings);
const loadPositions = async () => await getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);
const loadHistory = async () => await getConfig("dailyHistory", []);
const saveHistory = (history) => saveConfig("dailyHistory", history);
const loadHourlyHistory = async () => await getConfig("hourlyHistory", []);
const saveHourlyHistory = (history) => saveConfig("hourlyHistory", history);
const loadBalanceState = async () => await getConfig("balanceState", {});
const saveBalanceState = (state) => saveConfig("balanceState", state);
const loadAlerts = async () => await getConfig("priceAlerts", []);
const saveAlerts = (alerts) => saveConfig("priceAlerts", alerts);
const loadAlertSettings = async () => await getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);
const loadPriceTracker = async () => await getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);

function formatNumber(num, decimals = 2) {
    const number = parseFloat(num);
    if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals);
    return number.toFixed(decimals);
}

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
    const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body);
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64");
    return {
        "OK-ACCESS-KEY": process.env.OKX_API_KEY,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
        "Content-Type": "application/json",
    };
}

// =================================================================
// SECTION 2: API AND DATA PROCESSING FUNCTIONS
// =================================================================

async function getMarketPrices() {
    try {
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        if (tickersJson.code !== '0') {
            console.error("Failed to fetch market prices (OKX Error):", tickersJson.msg);
            return null;
        }
        const prices = {};
        tickersJson.data.forEach(t => {
            if (t.instId.endsWith('-USDT')) {
                const lastPrice = parseFloat(t.last);
                const openPrice = parseFloat(t.open24h);
                let change24h = 0;
                if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice;
                prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h, volCcy24h: parseFloat(t.volCcy24h) };
            }
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
        if (json.code !== '0') return { error: `فشل جلب المحفظة: ${json.msg}` };
        
        let assets = [], total = 0;
        json.data[0]?.details?.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 };
                const value = amount * priceData.price;
                total += value;
                if (value >= 1) {
                    assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h });
                }
            }
        });
        
        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (e) {
        console.error(e);
        return { error: "خطأ في الاتصال بالمنصة." };
    }
}

async function getBalanceForComparison() {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== '0') return null;
        const balanceMap = {};
        json.data[0]?.details?.forEach(asset => {
            balanceMap[asset.ccy] = parseFloat(asset.eq);
        });
        return balanceMap;
    } catch (error) {
        console.error("Exception in getBalanceForComparison:", error);
        return null;
    }
}

async function getInstrumentDetails(instId) {
    try {
        const tickerRes = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`);
        const tickerJson = await tickerRes.json();
        if (tickerJson.code !== '0' || !tickerJson.data[0]) return { error: `لم يتم العثور على العملة.` };
        const tickerData = tickerJson.data[0];
        return {
            price: parseFloat(tickerData.last),
            high24h: parseFloat(tickerData.high24h),
            low24h: parseFloat(tickerData.low24h),
            vol24h: parseFloat(tickerData.volCcy24h),
        };
    } catch (e) {
        console.error(e);
        return { error: "خطأ في الاتصال بالمنصة." };
    }
}

async function getHistoricalCandles(instId, limit = 100) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&limit=${limit}`);
        const json = await res.json();
        if (json.code !== '0' || !json.data || json.data.length === 0) return [];
        return json.data.map(c => parseFloat(c[4])).reverse();
    } catch (e) {
        console.error(`Exception in getHistoricalCandles for ${instId}:`, e);
        return [];
    }
}

function calculateSMA(closes, period) {
    if (closes.length < period) return null;
    const sum = closes.slice(-period).reduce((acc, val) => acc + val, 0);
    return sum / period;
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        diff > 0 ? gains += diff : losses -= diff;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgLoss = (avgLoss * (period - 1) - diff) / period;
            avgGain = (avgGain * (period - 1)) / period;
        }
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

async function getTechnicalAnalysis(instId) {
    const closes = await getHistoricalCandles(instId, 51);
    if (closes.length < 51) return { error: "بيانات الشموع غير كافية." };
    return { rsi: calculateRSI(closes), sma20: calculateSMA(closes, 20), sma50: calculateSMA(closes, 50) };
}

// =================================================================
// SECTION 3: FORMATTING AND MESSAGE GENERATION FUNCTIONS
// =================================================================

async function formatAdvancedMarketAnalysis() {
    const prices = await getMarketPrices();
    if (!prices) return "❌ فشل جلب بيانات السوق.";

    const marketData = Object.entries(prices)
        .map(([instId, data]) => ({ instId, ...data }))
        .filter(d => d.volCcy24h > 10000 && d.change24h !== undefined);

    marketData.sort((a, b) => b.change24h - a.change24h);
    const topGainers = marketData.slice(0, 5);
    const topLosers = marketData.slice(-5).reverse();

    marketData.sort((a, b) => b.volCcy24h - a.volCcy24h);
    const highVolume = marketData.slice(0, 5);
    
    let msg = `🚀 *تحليل السوق المتقدم* | ${new Date().toLocaleDateString("ar-EG")}\n━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += "📈 *أكبر الرابحين (24س):*\n" + topGainers.map(c => `  - \`${c.instId}\`: \`+${formatNumber(c.change24h * 100)}%\``).join('\n') + "\n\n";
    msg += "📉 *أكبر الخاسرين (24س):*\n" + topLosers.map(c => `  - \`${c.instId}\`: \`${formatNumber(c.change24h * 100)}%\``).join('\n') + "\n\n";
    msg += "📊 *الأعلى في حجم التداول:*\n" + highVolume.map(c => `  - \`${c.instId}\`: \`${(c.volCcy24h / 1e6).toFixed(2)}M\` USDT`).join('\n') + "\n\n";
    msg += "💡 *توصية:* راقب الأصول ذات حجم التداول المرتفع، فهي غالبًا ما تقود اتجاه السوق.";
    return msg;
}

async function formatTop5Assets(assets) {
    if (!assets || assets.length === 0) return "ℹ️ لا توجد أصول في محفظتك لعرضها.";

    const topAssets = assets.filter(a => a.asset !== 'USDT').slice(0, 5);
    if (topAssets.length === 0) return "ℹ️ لا توجد أصول (غير USDT) في محفظتك لعرضها.";
    
    let msg = "🏆 *أفضل 5 أصول في محفظتك*\n━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    topAssets.forEach((asset, index) => {
        msg += `${medals[index] || '▪️'} *${asset.asset}*\n`;
        msg += `💰 *القيمة:* \`$${formatNumber(asset.value)}\`\n`;
        msg += `💵 *السعر:* \`$${formatNumber(asset.price, 4)}\`\n\n`;
    });
    msg += "━━━━━━━━━━━━━━━━━━━━━━━━━\n📊 *نصيحة:* ركز على الأصول ذات الأداء الجيد وادرس أسباب تفوقها.";
    return msg;
}

async function formatQuickStats(assets, total, capital) {
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const statusEmoji = pnl >= 0 ? '🟢' : '🔴';
    const statusText = pnl >= 0 ? 'ربح' : 'خسارة';

    let msg = "⚡ *إحصائيات سريعة*\n\n";
    msg += `💎 *إجمالي الأصول:* \`${assets.filter(a => a.asset !== 'USDT').length}\`\n`;
    msg += `💰 *القيمة الحالية:* \`$${formatNumber(total)}\`\n`;
    msg += `📈 *نسبة الربح/الخسارة:* \`${formatNumber(pnlPercent)}%\`\n`;
    msg += `🎯 *الحالة:* ${statusEmoji} ${statusText}\n\n`;
    msg += `⏰ *آخر تحديث:* ${new Date().toLocaleTimeString("ar-EG")}`;
    return msg;
}

async function formatPortfolioMsg(assets, total, capital) {
    const positions = await loadPositions();
    let dailyPnlText = " ▫️ *الأداء اليومي (24س):* `لا توجد بيانات كافية`\n";
    let totalValue24hAgo = 0;
    assets.forEach(asset => {
        if (asset.asset === 'USDT') totalValue24hAgo += asset.value;
        else if (asset.change24h !== undefined && asset.price > 0) totalValue24hAgo += asset.amount * (asset.price / (1 + asset.change24h));
        else totalValue24hAgo += asset.value;
    });

    if (totalValue24hAgo > 0) {
        const dailyPnl = total - totalValue24hAgo;
        const dailyPnlPercent = (dailyPnl / totalValue24hAgo) * 100;
        const sign = dailyPnl >= 0 ? '+' : '';
        dailyPnlText = ` ▫️ *الأداء اليومي (24س):* ${dailyPnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${sign}${formatNumber(dailyPnl)}\` (\`${sign}${formatNumber(dailyPnlPercent)}%\`)\n`;
    }

    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    const pnlSign = pnl >= 0 ? '+' : '';
    const usdtValue = (assets.find(a => a.asset === 'USDT') || { value: 0 }).value;
    const cashPercent = total > 0 ? (usdtValue / total) * 100 : 0;
    const liquidityText = ` ▫️ *السيولة:* 💵 نقدي ${formatNumber(cashPercent, 1)}% / 📈 مستثمر ${formatNumber(100 - cashPercent, 1)}%`;

    let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n`;
    msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n*نظرة عامة على الأداء:*\n`;
    msg += ` ▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`;
    msg += ` ▫️ *رأس المال:* \`$${formatNumber(capital)}\`\n`;
    msg += ` ▫️ *إجمالي الربح غير المحقق:* ${pnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n`;
    msg += dailyPnlText + liquidityText + `\n━━━━━━━━━━━━━━━━━━━━\n*مكونات المحفظة:*\n`;

    assets.forEach((a, index) => {
        const percent = total > 0 ? (a.value / total) * 100 : 0;
        msg += "\n";
        if (a.asset === "USDT") {
            msg += `*USDT* (الرصيد النقدي) 💵\n*القيمة:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)`;
        } else {
            const change24hPercent = (a.change24h || 0) * 100;
            const changeEmoji = change24hPercent >= 0 ? '🟢⬆️' : '🔴⬇️';
            const changeSign = change24hPercent >= 0 ? '+' : '';
            msg += `╭─ *${a.asset}/USDT*\n`;
            msg += `├─ *القيمة الحالية:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)\n`;
            msg += `├─ *سعر السوق:* \`$${formatNumber(a.price, 4)}\`\n`;
            msg += `├─ *الأداء اليومي:* ${changeEmoji} \`${changeSign}${formatNumber(change24hPercent)}%\`\n`;
            const position = positions[a.asset];
            if (position?.avgBuyPrice > 0) {
                const totalCost = position.avgBuyPrice * a.amount;
                const assetPnl = a.value - totalCost;
                const assetPnlPercent = totalCost > 0 ? (assetPnl / totalCost) * 100 : 0;
                msg += `├─ *متوسط الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\`\n`;
                msg += `╰─ *ربح/خسارة غير محقق:* ${assetPnl >= 0 ? '🟢' : '🔴'} \`${assetPnl >= 0 ? '+' : ''}${formatNumber(assetPnl)}\` (\`${assetPnl >= 0 ? '+' : ''}${formatNumber(assetPnlPercent)}%\`)`;
            } else {
                msg += `╰─ *متوسط الشراء:* \`غير مسجل\``;
            }
        }
        if (index < assets.length - 1) msg += `\n━━━━━━━━━━━━━━━━━━━━`;
    });
    return msg;
}

// =================================================================
// SECTION 4: BACKGROUND JOBS (CRON TASKS)
// =================================================================

async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) {
    if (!asset || price === undefined || price === null || isNaN(price)) return null;
    const positions = await loadPositions();
    const position = positions[asset];
    const tradeValue = Math.abs(amountChange) * price;
    let report = null;

    if (amountChange > 0) { // Buy
        if (!position) {
            positions[asset] = { totalAmountBought: amountChange, totalCost: tradeValue, avgBuyPrice: price, openDate: new Date().toISOString(), totalAmountSold: 0, realizedValue: 0 };
        } else {
            position.totalAmountBought += amountChange;
            position.totalCost += tradeValue;
            position.avgBuyPrice = position.totalCost / position.totalAmountBought;
        }
    } else if (amountChange < 0 && position) { // Sell
        position.realizedValue += tradeValue;
        position.totalAmountSold += Math.abs(amountChange);
        if (newTotalAmount * price < 1) { // Position Closed
            const finalPnl = position.realizedValue - position.totalCost;
            const finalPnlPercent = position.totalCost > 0 ? (finalPnl / position.totalCost) * 100 : 0;
            report = `✅ *تقرير إغلاق مركز: ${asset}*\n\n` + `*النتيجة النهائية للصفقة:* ${finalPnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${finalPnl >= 0 ? '+' : ''}${formatNumber(finalPnl)}\` (\`${finalPnl >= 0 ? '+' : ''}${formatNumber(finalPnlPercent)}%\`)`;
            
            const closeDate = new Date();
            const openDate = new Date(position.openDate);
            const durationDays = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24);
            const tradeRecord = { asset, pnl: finalPnl, pnlPercent: finalPnlPercent, openDate, closeDate, durationDays, avgBuyPrice: position.avgBuyPrice, avgSellPrice: position.realizedValue / position.totalAmountSold };
            await saveClosedTrade(tradeRecord);
            
            delete positions[asset];
        }
    }
    await savePositions(positions);
    return report;
}

async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("Checking balance changes...");
        const previousState = await loadBalanceState();
        const previousBalances = previousState.balances || {};
        const currentBalance = await getBalanceForComparison();
        if (!currentBalance) return;
        const prices = await getMarketPrices();
        if (!prices) return;
        
        const { total: newTotalValue } = await getPortfolio(prices);
        if (Object.keys(previousBalances).length === 0) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue });
            return;
        }

        const allAssets = new Set([...Object.keys(previousBalances), ...Object.keys(currentBalance)]);
        let stateNeedsUpdate = false;

        for (const asset of allAssets) {
            if (asset === 'USDT') continue;
            const prevAmount = previousBalances[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;
            const priceData = prices[`${asset}-USDT`];
            if (!priceData || !priceData.price || isNaN(priceData.price) || Math.abs(difference * priceData.price) < 1) continue;

            stateNeedsUpdate = true;
            const closeReport = await updatePositionAndAnalyze(asset, difference, priceData.price, currAmount);
            if (closeReport) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, closeReport, { parse_mode: "Markdown" });
            } else {
                const tradeType = difference > 0 ? "شراء 🟢" : "بيع جزئي 🟠";
                const tradeValue = Math.abs(difference) * priceData.price;
                const analysisText = `🔔 **رصد حركة تداول**\n\n` + `🔸 *العملية:* ${tradeType}\n` + `🔸 *الأصل:* \`${asset}/USDT\`\n` + `🔸 *قيمة الصفقة:* \`$${formatNumber(tradeValue)}\`\n` + `🔸 *سعر التنفيذ:* \`$${formatNumber(priceData.price, 4)}\``;
                await bot.api.sendMessage(AUTHORIZED_USER_ID, analysisText, { parse_mode: "Markdown" });
            }
        }

        if (stateNeedsUpdate) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue });
            await sendDebugMessage("State updated after balance change.");
        }
    } catch (e) {
        console.error("CRITICAL ERROR in monitorBalanceChanges:", e);
    }
}

async function checkPriceAlerts() {
    try {
        const alerts = await loadAlerts();
        if (alerts.length === 0) return;
        const prices = await getMarketPrices();
        if (!prices) return;
        const remainingAlerts = [];
        let triggered = false;
        for (const alert of alerts) {
            const currentPrice = prices[alert.instId]?.price;
            if (currentPrice === undefined) { remainingAlerts.push(alert); continue; }
            if ((alert.condition === '>' && currentPrice > alert.price) || (alert.condition === '<' && currentPrice < alert.price)) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, `🚨 *تنبيه سعر!* \`${alert.instId}\`\nالشرط: ${alert.condition} ${alert.price}\nالسعر الحالي: \`${currentPrice}\``, { parse_mode: "Markdown" });
                triggered = true;
            } else {
                remainingAlerts.push(alert);
            }
        }
        if (triggered) await saveAlerts(remainingAlerts);
    } catch (error) {
        console.error("Error in checkPriceAlerts:", error);
    }
}

async function runDailyJobs() {
    try {
        const settings = await loadSettings();
        if (!settings.dailySummary) return;
        const prices = await getMarketPrices();
        if (!prices) return;
        const { total } = await getPortfolio(prices);
        if (total === undefined) return;
        const history = await loadHistory();
        const date = new Date().toISOString().slice(0, 10);
        const todayIndex = history.findIndex(h => h.date === date);
        if (todayIndex > -1) history[todayIndex].total = total;
        else history.push({ date, total });
        if (history.length > 35) history.shift();
        await saveHistory(history);
        console.log(`[Daily Summary Recorded]: ${date} - $${formatNumber(total)}`);
    } catch (e) {
        console.error("CRITICAL ERROR in runDailyJobs:", e);
    }
}

async function runHourlyJobs() {
    try {
        const prices = await getMarketPrices();
        if (!prices) return;
        const { total } = await getPortfolio(prices);
        if (total === undefined) return;
        const history = await loadHourlyHistory();
        const hourLabel = new Date().toISOString().slice(0, 13);
        const existingIndex = history.findIndex(h => h.label === hourLabel);
        if (existingIndex > -1) history[existingIndex].total = total;
        else history.push({ label: hourLabel, total });
        if (history.length > 72) history.splice(0, history.length - 72);
        await saveHourlyHistory(history);
    } catch (e) {
        console.error("Error in hourly jobs:", e);
    }
}

// =================================================================
// SECTION 5: BOT SETUP, KEYBOARDS, AND HANDLERS
// =================================================================

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("🚀 تحليل السوق").text("🏆 أفضل 5 أصول").row()
    .text("⚡ إحصائيات سريعة").text("ℹ️ معلومات عملة").row()
    .text("🔔 ضبط تنبيه").text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();

async function sendSettingsMenu(ctx) {
    const settings = await loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital")
        .text("💼 عرض المراكز المفتوحة", "view_positions").row()
        .text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts")
        .text("🗑️ حذف تنبيه سعر", "delete_alert").row()
        .text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary")
        .text(`🚀 النشر للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost").row()
        .text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug")
        .text("🔥 حذف جميع البيانات 🔥", "delete_all_data");
    const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*";
    try {
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
    } catch {
        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
    }
}

async function sendMovementAlertsMenu(ctx) {
    const alertSettings = await loadAlertSettings();
    const text = `🚨 *إدارة تنبيهات حركة الأسعار*\n\n- *النسبة العامة الحالية:* \`${alertSettings.global}%\`.\n- يمكنك تعيين نسبة مختلفة لعملة معينة.`;
    const keyboard = new InlineKeyboard()
        .text("📊 تعديل النسبة العامة", "set_global_alert")
        .text("💎 تعديل نسبة عملة", "set_coin_alert").row()
        .text("🔙 العودة للإعدادات", "back_to_settings");
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
}

bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) await next();
    else console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`);
});

bot.command("start", (ctx) => ctx.reply("🤖 *أهلاً بك في بوت OKX التحليلي*.", { parse_mode: "Markdown", reply_markup: mainKeyboard }));
bot.command("settings", sendSettingsMenu);

bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;
    switch(data) {
        case "set_capital": waitingState = 'set_capital'; await ctx.editMessageText("💰 يرجى إرسال المبلغ الجديد لرأس المال (رقم فقط)."); break;
        case "back_to_settings": await sendSettingsMenu(ctx); break;
        case "manage_movement_alerts": await sendMovementAlertsMenu(ctx); break;
        case "set_global_alert": waitingState = 'set_global_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال النسبة العامة الجديدة (مثال: `5`)."); break;
        case "set_coin_alert": waitingState = 'set_coin_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال رمز العملة والنسبة.\n*مثال:*\n`BTC 2.5`"); break;
        case "view_positions":
            const positions = await loadPositions();
            if (Object.keys(positions).length === 0) { await ctx.editMessageText("ℹ️ لا توجد مراكز مفتوحة.", { reply_markup: new InlineKeyboard().text("🔙 العودة", "back_to_settings") }); break; }
            let msg = "📄 *قائمة المراكز المفتوحة:*\n";
            for (const symbol in positions) {
                const pos = positions[symbol];
                msg += `\n- *${symbol}:* متوسط الشراء \`$${formatNumber(pos.avgBuyPrice, 4)}\``;
            }
            await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة", "back_to_settings") });
            break;
        case "delete_alert":
            const alerts = await loadAlerts();
            if (alerts.length === 0) { await ctx.editMessageText("ℹ️ لا توجد تنبيهات مسجلة.", { reply_markup: new InlineKeyboard().text("🔙 العودة", "back_to_settings") }); break; }
            let alertMsg = "🗑️ *اختر التنبيه لحذفه:*\n\n";
            alerts.forEach((alert, i) => { alertMsg += `*${i + 1}.* \`${alert.instId} ${alert.condition} ${alert.price}\`\n`; });
            alertMsg += "\n*أرسل رقم التنبيه الذي تود حذفه.*";
            waitingState = 'delete_alert_number';
            await ctx.editMessageText(alertMsg, { parse_mode: "Markdown" });
            break;
        case "toggle_summary": case "toggle_autopost": case "toggle_debug": {
            const settings = await loadSettings();
            if (data === 'toggle_summary') settings.dailySummary = !settings.dailySummary;
            else if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel;
            else if (data === 'toggle_debug') settings.debugMode = !settings.debugMode;
            await saveSettings(settings);
            await sendSettingsMenu(ctx);
            break;
        }
        case "delete_all_data":
            waitingState = 'confirm_delete_all';
            await ctx.editMessageText("⚠️ *تحذير: هذا الإجراء لا يمكن التراجع عنه!* لحذف كل شيء، أرسل: `تأكيد الحذف`", { parse_mode: "Markdown" });
            break;
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        switch (state) {
            case 'set_capital':
                const amount = parseFloat(text);
                if (!isNaN(amount) && amount >= 0) {
                    await saveCapital(amount);
                    await ctx.reply(`✅ *تم تحديث رأس المال إلى:* \`$${formatNumber(amount)}\``, { parse_mode: "Markdown" });
                } else await ctx.reply("❌ مبلغ غير صالح.");
                return;
            case 'confirm_delete_all':
                if (text === 'تأكيد الحذف') {
                    await getCollection("configs").deleteMany({});
                    await ctx.reply("✅ تم حذف جميع بياناتك.");
                } else await ctx.reply("❌ تم إلغاء الحذف.");
                return;
            case 'coin_info':
                const instId = text.toUpperCase();
                const coinSymbol = instId.split('-')[0];
                const loadingMsg = await ctx.reply(`⏳ جاري تجهيز التقرير لـ ${instId}...`);

                const [details, prices, historicalPerf, techAnalysis] = await Promise.all([
                    getInstrumentDetails(instId), getMarketPrices(), getHistoricalPerformance(coinSymbol), getTechnicalAnalysis(instId)
                ]);

                if (details.error) return await ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, `❌ ${details.error}`);

                let msg = `ℹ️ *الملف التحليلي الكامل | ${instId}*\n\n*القسم الأول: بيانات السوق*\n`;
                msg += ` ▫️ *السعر الحالي:* \`$${formatNumber(details.price, 4)}\`\n`;
                msg += ` ▫️ *أعلى (24س):* \`$${formatNumber(details.high24h, 4)}\`\n`;
                msg += ` ▫️ *أدنى (24س):* \`$${formatNumber(details.low24h, 4)}\`\n\n`;

                msg += `*القسم الثاني: تحليل مركزك الحالي*\n`;
                const { assets: userAssets } = await getPortfolio(prices);
                const ownedAsset = userAssets.find(a => a.asset === coinSymbol);
                const positions = await loadPositions();
                const assetPosition = positions[coinSymbol];
                if (ownedAsset && assetPosition?.avgBuyPrice) {
                    const pnl = (details.price - assetPosition.avgBuyPrice) * ownedAsset.amount;
                    const pnlPercent = (assetPosition.avgBuyPrice > 0) ? (pnl / (assetPosition.avgBuyPrice * ownedAsset.amount)) * 100 : 0;
                    const durationDays = (new Date().getTime() - new Date(assetPosition.openDate).getTime()) / (1000 * 60 * 60 * 24);
                    msg += ` ▪️ *متوسط الشراء:* \`$${formatNumber(assetPosition.avgBuyPrice, 4)}\`\n`;
                    msg += ` ▪️ *الربح/الخسارة غير المحقق:* ${pnl >= 0 ? '🟢' : '🔴'} \`${formatNumber(pnl)}\` (\`${formatNumber(pnlPercent)}%\`)\n`;
                    msg += ` ▪️ *مدة فتح المركز:* \`${formatNumber(durationDays, 1)} يوم\`\n\n`;
                } else msg += ` ▪️ لا يوجد مركز مفتوح حالياً لهذه العملة.\n\n`;

                msg += `*القسم الثالث: تاريخ أدائك مع العملة*\n`;
                if (historicalPerf?.tradeCount > 0) {
                    msg += ` ▪️ *إجمالي الربح/الخسارة المحقق:* \`${historicalPerf.realizedPnl >= 0 ? '+' : ''}${formatNumber(historicalPerf.realizedPnl)}\`\n`;
                    msg += ` ▪️ *سجل الصفقات:* \`${historicalPerf.tradeCount}\` (${historicalPerf.winningTrades} رابحة / ${historicalPerf.losingTrades} خاسرة)\n\n`;
                } else msg += ` ▪️ لا يوجد تاريخ صفقات مغلقة لهذه العملة.\n\n`;

                msg += `*القسم الرابع: مؤشرات فنية بسيطة*\n`;
                if (techAnalysis.error) msg += ` ▪️ ${techAnalysis.error}\n`;
                else {
                    let rsiText = "محايد";
                    if (techAnalysis.rsi > 70) rsiText = "تشبع شرائي 🔴";
                    if (techAnalysis.rsi < 30) rsiText = "تشبع بيعي 🟢";
                    msg += ` ▪️ *RSI (14D):* \`${formatNumber(techAnalysis.rsi)}\` (${rsiText})\n`;
                    if(techAnalysis.sma20) msg += ` ▪️ *السعر* *${details.price > techAnalysis.sma20 ? 'فوق' : 'تحت'}* *SMA20* (\`$${formatNumber(techAnalysis.sma20, 4)}\`)\n`;
                    if(techAnalysis.sma50) msg += ` ▪️ *السعر* *${details.price > techAnalysis.sma50 ? 'فوق' : 'تحت'}* *SMA50* (\`$${formatNumber(techAnalysis.sma50, 4)}\`)`;
                }
                
                await ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, msg, { parse_mode: "Markdown" });
                return;
            
            case 'set_alert':
                const parts = text.trim().split(/\s+/);
                if (parts.length !== 3) return await ctx.reply("❌ صيغة غير صحيحة. مثال: `BTC > 50000`");
                const [symbol, cond, priceStr] = parts;
                if (cond !== '>' && cond !== '<') return await ctx.reply("❌ الشرط غير صالح. استخدم `>` أو `<`.");
                const price = parseFloat(priceStr);
                if (isNaN(price) || price <= 0) return await ctx.reply("❌ السعر غير صالح.");
                const allAlerts = await loadAlerts();
                allAlerts.push({ instId: symbol.toUpperCase(), condition: cond, price: price });
                await saveAlerts(allAlerts);
                await ctx.reply(`✅ تم ضبط التنبيه: ${symbol.toUpperCase()} ${cond} ${price}`, { parse_mode: "Markdown" });
                return;

            case 'delete_alert_number':
                let currentAlerts = await loadAlerts();
                const index = parseInt(text) - 1;
                if (isNaN(index) || index < 0 || index >= currentAlerts.length) return await ctx.reply("❌ رقم غير صالح.");
                currentAlerts.splice(index, 1);
                await saveAlerts(currentAlerts);
                await ctx.reply(`✅ تم حذف التنبيه.`);
                return;
        }
    }
    
    let portfolioData;
    const fetchPortfolioData = async () => {
        if (!portfolioData) {
            const prices = await getMarketPrices();
            if (!prices) return { error: "❌ فشل جلب أسعار السوق." };
            const capital = await loadCapital();
            portfolioData = await getPortfolio(prices);
            portfolioData.capital = capital;
        }
        return portfolioData;
    };

    switch (text) {
        case "📊 عرض المحفظة":
            await ctx.reply("⏳ جاري إعداد التقرير...");
            const { assets, total, capital, error } = await fetchPortfolioData();
            if (error) return await ctx.reply(error);
            const msgPortfolio = await formatPortfolioMsg(assets, total, capital);
            await ctx.reply(msgPortfolio, { parse_mode: "Markdown" });
            break;
        case "🚀 تحليل السوق":
            await ctx.reply("⏳ جاري تحليل السوق...");
            const marketMsg = await formatAdvancedMarketAnalysis();
            await ctx.reply(marketMsg, { parse_mode: "Markdown" });
            break;
        case "🏆 أفضل 5 أصول":
            await ctx.reply("⏳ جاري تحليل الأصول...");
            const { assets: topAssets, error: topAssetsError } = await fetchPortfolioData();
            if (topAssetsError) return await ctx.reply(topAssetsError);
            const topAssetsMsg = await formatTop5Assets(topAssets);
            await ctx.reply(topAssetsMsg, { parse_mode: "Markdown" });
            break;
        case "⚡ إحصائيات سريعة":
            await ctx.reply("⏳ جاري حساب الإحصائيات...");
            const { assets: quickAssets, total: quickTotal, capital: quickCapital, error: quickError } = await fetchPortfolioData();
            if (quickError) return await ctx.reply(quickError);
            const quickStatsMsg = await formatQuickStats(quickAssets, quickTotal, quickCapital);
            await ctx.reply(quickStatsMsg, { parse_mode: "Markdown" });
            break;
        case "ℹ️ معلومات عملة":
            waitingState = 'coin_info';
            await ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`).");
            break;
        case "⚙️ الإعدادات":
            await sendSettingsMenu(ctx);
            break;
        case "🔔 ضبط تنبيه":
            waitingState = 'set_alert';
            await ctx.reply("✍️ *لضبط تنبيه سعر، استخدم الصيغة:*\n`BTC > 50000`", { parse_mode: "Markdown" });
            break;
    }
});

// =================================================================
// SECTION 6: SERVER AND BOT INITIALIZATION
// =================================================================

app.get("/healthcheck", (req, res) => res.status(200).send("OK"));

async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected.");

        // Schedule background jobs
        setInterval(monitorBalanceChanges, 60_000);
        setInterval(checkPriceAlerts, 30_000);
        setInterval(runHourlyJobs, 3_600_000);
        setInterval(runDailyJobs, 86_400_000);

        if (process.env.NODE_ENV === "production") {
            app.use(express.json());
            app.use(webhookCallback(bot, "express"));
            app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));
        } else {
            await bot.start();
            console.log("Bot started with polling.");
        }
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
    }
}

// Start the bot after all functions are defined
startBot();
