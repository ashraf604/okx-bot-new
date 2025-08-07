// =================================================================
// OKX Advanced Analytics Bot - v62 (FINAL - SPAM BUG FIXED)
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
const getCollection = (collectionName) => getDB().collection(collectionName);

async function getConfig(id, defaultValue = {}) {
    const doc = await getCollection("configs").findOne({ _id: id });
    return doc ? doc.data : defaultValue;
}

async function saveConfig(id, data) {
    await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true });
}

async function saveClosedTrade(tradeData) {
    await getCollection("tradeHistory").insertOne(tradeData);
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
            const lastPrice = parseFloat(t.last);
            const openPrice = parseFloat(t.open24h);
            let change24h = 0;
            if (openPrice > 0) {
                change24h = (lastPrice - openPrice) / openPrice;
            }
            prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h: change24h };
        });
        return prices;
    } catch (error) {
        console.error("Exception in getMarketPrices (Invalid Response):", error.message);
        return null;
    }
}

async function getPortfolio(prices) {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== '0') return { error: `فشل جلب المحفظة من OKX: ${json.msg}` };
        
        let assets = [], total = 0;
        json.data[0]?.details?.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 };
                const price = priceData.price;
                const value = amount * price;
                total += value;
                if (value >= 1) {
                    assets.push({ asset: asset.ccy, price: price, value: value, amount: amount, change24h: priceData.change24h });
                }
            }
        });
        
        const filteredAssets = assets.filter(a => a.value >= 1);
        filteredAssets.sort((a, b) => b.value - a.value);
        return { assets: filteredAssets, total };
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
        if (json.code !== '0') {
            console.error("Error fetching balance for comparison:", json.msg);
            return null;
        }
        const balanceMap = {};
        json.data[0]?.details?.forEach(asset => {
            const totalBalance = parseFloat(asset.eq);
            if (totalBalance > -1e-9) {
                balanceMap[asset.ccy] = totalBalance;
            }
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
        const candleRes = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId.toUpperCase()}&bar=1D&limit=7`);
        const candleJson = await candleRes.json();
        let weeklyData = { high: 0, low: 0 };
        if (candleJson.code === '0' && candleJson.data.length > 0) {
            const highs = candleJson.data.map(c => parseFloat(c[2]));
            const lows = candleJson.data.map(c => parseFloat(c[3]));
            weeklyData.high = Math.max(...highs);
            weeklyData.low = Math.min(...lows);
        }
        return {
            price: parseFloat(tickerData.last),
            high24h: parseFloat(tickerData.high24h),
            low24h: parseFloat(tickerData.low24h),
            vol24h: parseFloat(tickerData.volCcy24h),
            open24h: parseFloat(tickerData.open24h),
            weeklyHigh: weeklyData.high,
            weeklyLow: weeklyData.low
        };
    } catch (e) {
        console.error(e);
        return { error: "خطأ في الاتصال بالمنصة." };
    }
}

async function getHistoricalHighLow(instId, startDate, endDate) {
    try {
        const startMs = new Date(startDate).getTime();
        const endMs = new Date(endDate).getTime();
        const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&after=${startMs}&limit=100`);
        const json = await res.json();
        if (json.code !== '0' || !json.data || json.data.length === 0) {
            console.error(`Could not fetch history for ${instId}:`, json.msg);
            return { high: 0 };
        }
        const relevantCandles = json.data.filter(c => parseInt(c[0]) <= endMs);
        if (relevantCandles.length === 0) return { high: 0 };

        const highs = relevantCandles.map(c => parseFloat(c[2]));
        return { high: Math.max(...highs) };
    } catch (e) {
        console.error(`Exception in getHistoricalHighLow for ${instId}:`, e);
        return { high: 0 };
    }
}

function calculatePerformanceStats(history) {
    if (history.length < 2) return null;
    const values = history.map(h => h.total);
    const startValue = values[0];
    const endValue = values[values.length - 1];
    const pnl = endValue - startValue;
    const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0;
    const maxValue = Math.max(...values);
    const minValue = Math.min(...values);
    const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length;
    return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue };
}

function createChartUrl(history, periodLabel, pnl) {
    if (history.length < 2) return null;
    const chartColor = pnl >= 0 ? 'rgb(75, 192, 75)' : 'rgb(255, 99, 132)';
    const chartBgColor = pnl >= 0 ? 'rgba(75, 192, 75, 0.2)' : 'rgba(255, 99, 132, 0.2)';
    const labels = history.map(h => h.label);
    const data = history.map(h => h.total.toFixed(2));
    const chartConfig = {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'قيمة المحفظة ($)',
                data: data,
                fill: true,
                backgroundColor: chartBgColor,
                borderColor: chartColor,
                tension: 0.1
            }]
        },
        options: {
            title: { display: true, text: `أداء المحفظة - ${periodLabel}` }
        }
    };
    return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`;
}

// === Core Logic & Bot Handlers ===
async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) {
    if (!asset || price === undefined || price === null || isNaN(price)) {
        console.error(`Invalid data for updatePositionAndAnalyze: asset=${asset}, price=${price}`);
        return null;
    }
    const positions = await loadPositions();
    const position = positions[asset];
    const tradeValue = Math.abs(amountChange) * price;
    let retrospectiveReport = null;
    if (amountChange > 0) {
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
    } else if (amountChange < 0 && position) {
        const amountSold = Math.abs(amountChange);
        position.realizedValue += tradeValue;
        position.totalAmountSold += amountSold;
        if (newTotalAmount * price < 1) {
            await sendDebugMessage(`Position for ${asset} closed. Generating final report...`);
            const finalPnl = position.realizedValue - position.totalCost;
            const finalPnlPercent = (position.totalCost > 0) ? (finalPnl / position.totalCost) * 100 : 0;
            const avgSellPrice = position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0;
            
            try {
                const closeDate = new Date();
                const openDate = new Date(position.openDate);
                const durationMs = closeDate.getTime() - openDate.getTime();
                const durationDays = durationMs / (1000 * 60 * 60 * 24);

                const tradeRecord = {
                    asset: asset,
                    pnl: finalPnl,
                    pnlPercent: finalPnlPercent,
                    openDate: openDate,
                    closeDate: closeDate,
                    durationDays: durationDays,
                    avgBuyPrice: position.avgBuyPrice,
                    avgSellPrice: avgSellPrice,
                    totalAmountBought: position.totalAmountBought,
                    realizedValue: position.realizedValue
                };
                await saveClosedTrade(tradeRecord);
                await sendDebugMessage(`Saved closed trade for ${asset} to history.`);
            } catch(e) {
                console.error("Failed to save closed trade to history:", e);
                await sendDebugMessage(`⚠️ Failed to save closed trade for ${asset} to history.`);
            }

            const pnlEmoji = finalPnl >= 0 ? '🟢⬆️' : '🔴⬇️';
            const { high: peakPrice } = await getHistoricalHighLow(`${asset}-USDT`, position.openDate, new Date());
            
            retrospectiveReport = `✅ *تقرير إغلاق مركز: ${asset}*\n\n` +
                `*النتيجة النهائية للصفقة:* ${pnlEmoji} \`${finalPnl >= 0 ? '+' : ''}${(finalPnl || 0).toFixed(2)}\` (\`${finalPnl >= 0 ? '+' : ''}${(finalPnlPercent || 0).toFixed(2)}%\`)\n\n` +
                `**ملخص تحليل الأداء:**\n` +
                ` - *متوسط سعر الشراء:* \`$${(position.avgBuyPrice || 0).toFixed(4)}\`\n` +
                ` - *متوسط سعر البيع:* \`$${(avgSellPrice || 0).toFixed(4)}\`\n` +
                ` - *أعلى سعر خلال فترة التملك:* \`$${(peakPrice || 0).toFixed(4)}\``;
            
            delete positions[asset];
        } else {
            await sendDebugMessage(`Partial sell for ${asset} recorded.`);
        }
    }
    await savePositions(positions);
    return retrospectiveReport;
}

async function formatPortfolioMsg(assets, total, capital) {
    const positions = await loadPositions();
    let dailyPnlText = " ▫️ *الأداء اليومي (24س):* `جاري الحساب...`\n";
    let totalValue24hAgo = 0;
    assets.forEach(asset => {
        if (asset.asset === 'USDT') {
            totalValue24hAgo += asset.value;
        } else if (asset.change24h !== undefined && asset.price > 0) {
            const price24hAgo = asset.price / (1 + asset.change24h);
            const value24hAgo = asset.amount * price24hAgo;
            totalValue24hAgo += value24hAgo;
        } else {
            totalValue24hAgo += asset.value;
        }
    });
    if (totalValue24hAgo > 0) {
        const dailyPnl = total - totalValue24hAgo;
        const dailyPnlPercent = (dailyPnl / totalValue24hAgo) * 100;
        const dailyPnlEmoji = dailyPnl >= 0 ? '🟢⬆️' : '🔴⬇️';
        const dailyPnlSign = dailyPnl >= 0 ? '+' : '';
        dailyPnlText = ` ▫️ *الأداء اليومي (24س):* ${dailyPnlEmoji} \`${dailyPnlSign}${(dailyPnl || 0).toFixed(2)}\` (\`${dailyPnlSign}${(dailyPnlPercent || 0).toFixed(2)}%\`)\n`;
    } else {
        dailyPnlText = " ▫️ *الأداء اليومي (24س):* `لا توجد بيانات كافية`\n";
    }
    let pnl = capital > 0 ? total - capital : 0;
    let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    let pnlEmoji = pnl >= 0 ? '🟢⬆️' : '🔴⬇️';
    let pnlSign = pnl >= 0 ? '+' : '';
    const usdtAsset = assets.find(a => a.asset === 'USDT');
    const usdtValue = usdtAsset ? usdtAsset.value : 0;
    const cashPercent = total > 0 ? (usdtValue / total) * 100 : 0;
    const investedPercent = 100 - cashPercent;
    const liquidityText = ` ▫️ *توزيع السيولة:* 💵 نقدي ${(cashPercent || 0).toFixed(1)}% / 📈 مستثمر ${(investedPercent || 0).toFixed(1)}%`;
    let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n`;
    msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 *نظرة عامة على الأداء:*\n`;
    msg += ` ▫️ *القيمة الإجمالية:* \`$${(total || 0).toFixed(2)}\`\n`;
    msg += ` ▫️ *رأس المال المسجل:* \`$${(capital || 0).toFixed(2)}\`\n`;
    msg += ` ▫️ *إجمالي الربح غير المحقق:* ${pnlEmoji} \`${pnlSign}${(pnl || 0).toFixed(2)}\` (\`${pnlSign}${(pnlPercent || 0).toFixed(2)}%\`)\n`;
    msg += dailyPnlText;
    msg += liquidityText + `\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💎 *مكونات المحفظة:*\n`;
    assets.forEach((a, index) => {
        let percent = total > 0 ? ((a.value / total) * 100) : 0;
        msg += "\n";
        if (a.asset === "USDT") {
            msg += `*USDT* (الرصيد النقدي) 💵\n`;
            msg += `*القيمة:* \`$${(a.value || 0).toFixed(2)}\` (*الوزن:* \`${(percent || 0).toFixed(2)}%\`)`;
        } else {
            const change24hPercent = (a.change24h || 0) * 100;
            const changeEmoji = change24hPercent >= 0 ? '🟢⬆️' : '🔴⬇️';
            const changeSign = change24hPercent >= 0 ? '+' : '';
            msg += `╭─ *${a.asset}/USDT*\n`;
            msg += `├─ *القيمة الحالية:* \`$${(a.value || 0).toFixed(2)}\` (*الوزن:* \`${(percent || 0).toFixed(2)}%\`)\n`;
            msg += `├─ *سعر السوق:* \`$${(a.price || 0).toFixed(4)}\`\n`;
            msg += `├─ *الأداء اليومي:* ${changeEmoji} \`${changeSign}${(change24hPercent || 0).toFixed(2)}%\`\n`;
            const position = positions[a.asset];
            if (position && position.avgBuyPrice > 0) {
                const avgBuyPrice = position.avgBuyPrice;
                const totalCost = avgBuyPrice * a.amount;
                const assetPnl = a.value - totalCost;
                const assetPnlPercent = (totalCost > 0) ? (assetPnl / totalCost) * 100 : 0;
                const assetPnlEmoji = assetPnl >= 0 ? '🟢⬆️' : '🔴⬇️';
                const assetPnlSign = assetPnl >= 0 ? '+' : '';
                msg += `├─ *متوسط الشراء:* \`$${(avgBuyPrice || 0).toFixed(4)}\`\n`;
                msg += `╰─ *ربح/خسارة غير محقق:* ${assetPnlEmoji} \`${assetPnlSign}${(assetPnl || 0).toFixed(2)}\` (\`${assetPnlSign}${(assetPnlPercent || 0).toFixed(2)}%\`)`;
            } else {
                msg += `╰─ *متوسط الشراء:* \`غير مسجل\``;
            }
        }
        if (index < assets.length - 1) {
            msg += `\n━━━━━━━━━━━━━━━━━━━━`;
        }
    });
    return msg;
}

// =================================================================
// START: RE-WRITTEN FUNCTION (monitorBalanceChanges) - SPAM BUG FIX
// =================================================================
async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("بدء دورة التحقق من الصفقات...");
        let previousState = await loadBalanceState();
        let previousBalanceState = previousState.balances || {};
        
        const currentBalance = await getBalanceForComparison();
        if (!currentBalance) { return; }
        
        const prices = await getMarketPrices();
        if (!prices) { return; }
        
        const { assets: currentAssets, total: newTotalPortfolioValue } = await getPortfolio(prices);
        if (newTotalPortfolioValue === undefined) { return; }

        if (Object.keys(previousBalanceState).length === 0) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            await sendDebugMessage("تم تسجيل الرصيد الأولي وحفظه.");
            return;
        }

        const allAssets = new Set([...Object.keys(previousBalanceState), ...Object.keys(currentBalance)]);
        let stateNeedsUpdate = false;

        for (const asset of allAssets) {
            if (asset === 'USDT') continue;
            const prevAmount = previousBalanceState[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;

            const priceData = prices[`${asset}-USDT`];
            if (!priceData || !priceData.price || isNaN(priceData.price)) continue;
            
            if (Math.abs(difference * priceData.price) < 0.1) continue;

            stateNeedsUpdate = true;
            const price = priceData.price;
            
            const retrospectiveReport = await updatePositionAndAnalyze(asset, difference, price, currAmount);

            if (retrospectiveReport) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, retrospectiveReport, { parse_mode: "Markdown" });
                const settings = await loadSettings();
                if (settings.autoPostToChannel) {
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, retrospectiveReport, { parse_mode: "Markdown" });
                } else {
                    const confirmationKeyboard = new InlineKeyboard()
                        .text("✅ نشر تقرير الإغلاق", "publish_close_report")
                        .text("❌ تجاهل", "ignore_report");
                    const hiddenMarker = `\n<CLOSE_REPORT>${JSON.stringify(retrospectiveReport)}</CLOSE_REPORT>`;
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, `*هل تود نشر تقرير إغلاق المركز هذا في القناة؟*${hiddenMarker}`, { parse_mode: "Markdown", reply_markup: confirmationKeyboard });
                }
                continue; 
            }
            
            const updatedPositions = await loadPositions();
            const currentPosition = updatedPositions[asset];
            
            const tradeValue = Math.abs(difference) * price;
            const newAssetValue = currAmount * price;
            const portfolioPercentage = newTotalPortfolioValue > 0 ? (newAssetValue / newTotalPortfolioValue) * 100 : 0;
            const usdtAsset = currentAssets.find(a => a.asset === 'USDT') || { value: 0 };
            const newCashValue = usdtAsset.value;
            const newCashPercentage = newTotalPortfolioValue > 0 ? (newCashValue / newTotalPortfolioValue) * 100 : 0;
            const entryOfPortfolio = previousState.totalValue > 0 ? (tradeValue / previousState.totalValue) * 100 : 0;
            
            const tradeType = (difference > 0) ? "شراء 🟢⬆️" : "بيع جزئي 🟠";
            const recommendationType = (difference > 0) ? "شراء 🟢⬆️" : "بيع جزئي 🟠";
            
            const privateTradeAnalysisText = `🔔 **تحليل حركة تداول**\n` + `━━━━━━━━━━━━━━━━━━━━\n` + `🔸 **العملية:** ${tradeType}\n` + `🔸 **الأصل:** \`${asset}/USDT\`\n` + `━━━━━━━━━━━━━━━━━━━━\n` + `📝 **تفاصيل الصفقة:**\n` + ` ▫️ *سعر التنفيذ:* \`$${price.toFixed(4)}\`\n` + ` ▫️ *الكمية:* \`${Math.abs(difference).toFixed(5)}\`\n` + ` ▫️ *قيمة الصفقة:* \`$${tradeValue.toFixed(2)}\`\n` + `━━━━━━━━━━━━━━━━━━━━\n` + `📊 **التأثير على المحفظة:**\n` + ` ▫️ *حجم الصفقة من المحفظة:* \`${entryOfPortfolio.toFixed(2)}%\`\n` + ` ▫️ *الوزن الجديد للعملة:* \`${portfolioPercentage.toFixed(2)}%\`\n` + ` ▫️ *الرصيد النقدي الجديد:* \`$${newCashValue.toFixed(2)}\`\n` + ` ▫️ *نسبة الكاش الجديدة:* \`${newCashPercentage.toFixed(2)}%\`\n` + `━━━━━━━━━━━━━━━━━━━━\n` + `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*`;
            
            let publicChannelPostText;
            if (difference > 0) {
                const initialCash = previousBalanceState['USDT'] || 0;
                const cashConsumptionPercent = initialCash > 0 ? (tradeValue / initialCash) * 100 : 0;
                const averageBuyPrice = currentPosition ? currentPosition.avgBuyPrice : price; 
                publicChannelPostText = `🔔 **توصية: ${recommendationType}**\n\n` + `🔸 **الأصل:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الدخول:**\n` + `   ▫️ *متوسط سعر الشراء:* \`$${averageBuyPrice.toFixed(4)}\`\n` + `   ▫️ *حجم الدخول من المحفظة:* \`${entryOfPortfolio.toFixed(2)}%\`\n\n` + `📊 **التأثير على المحفظة:**\n` + `   ▫️ *نسبة استهلاك الكاش:* \`${cashConsumptionPercent.toFixed(2)}%\`\n` + `   ▫️ *الوزن الجديد للعملة:* \`${portfolioPercentage.toFixed(2)}%\`\n\n` + `*بتاريخ: ${new Date().toLocaleDateString("de-DE")}*`;
            } else {
                publicChannelPostText = `🔔 **توصية: ${recommendationType}**\n\n` + `🔸 **الأصل:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الخروج:**\n` + `   ▫️ *سعر البيع:* \`$${price.toFixed(4)}\`\n` + `   ▫️ *قيمة الصفقة:* \`$${tradeValue.toFixed(2)}\`\n\n` + `📊 **التأثير على المحفظة:**\n` + `   ▫️ *الوزن الجديد للعملة:* \`${portfolioPercentage.toFixed(2)}%\`\n` + `   ▫️ *نسبة الكاش الجديدة:* \`${newCashPercentage.toFixed(2)}%\`\n\n` + `*بتاريخ: ${new Date().toLocaleDateString("de-DE")}*`;
            }
            
            const settings = await loadSettings();
            if (settings.autoPostToChannel) {
                await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicChannelPostText, { parse_mode: "Markdown" });
                await bot.api.sendMessage(AUTHORIZED_USER_ID, privateTradeAnalysisText, { parse_mode: "Markdown" });
            } else {
                const hiddenMarker = `\n<CHANNEL_POST>${JSON.stringify(publicChannelPostText)}</CHANNEL_POST>`;
                const confirmationKeyboard = new InlineKeyboard().text("✅ تأكيد ونشر", "publish_trade").text("❌ تجاهل", "ignore_trade");
                await bot.api.sendMessage(AUTHORIZED_USER_ID, `*تم اكتشاف صفقة جديدة، هل تود نشرها؟*\n\n${privateTradeAnalysisText}${hiddenMarker}`, { parse_mode: "Markdown", reply_markup: confirmationKeyboard });
            }
        }

        if (stateNeedsUpdate) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            await sendDebugMessage(`State updated after processing all detected changes.`);
        } else {
            // If the balance values are the same but total value changed (price fluctuations), update the state too.
            if (previousState.totalValue !== newTotalPortfolioValue) {
                await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
                await sendDebugMessage(`State updated due to portfolio value change.`);
            } else {
                await sendDebugMessage("لا توجد تغييرات في الأرصدة أو القيمة.");
            }
        }
    } catch (e) {
        console.error("CRITICAL ERROR in monitorBalanceChanges:", e);
    }
}
// =================================================================
// END: RE-WRITTEN FUNCTION
// =================================================================

async function checkPriceAlerts() {
    // ... (This function is unchanged)
}

async function runDailyJobs() {
    // ... (This function is unchanged)
}

async function runHourlyJobs() {
    // ... (This function is unchanged)
}

async function checkPriceMovements() {
    // ... (This function is unchanged)
}

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();

async function sendSettingsMenu(ctx) {
    // ... (This function is unchanged)
}

async function sendMovementAlertsMenu(ctx) {
    // ... (This function is unchanged)
}

bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        await next();
    } else {
        console.log(`محاولة وصول غير مصرح به بواسطة معرف المستخدم: ${ctx.from?.id || 'غير محدد'}`);
    }
});

bot.command("start", async (ctx) => {
    await ctx.reply(`🤖 *بوت OKX التحليلي المتكامل*\n*الإصدار: v62 - SPAM BUG FIXED*\n\nأهلاً بك! أنا هنا لمساعدتك في تتبع وتحليل محفظتك الاستثمارية.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));

bot.command("pnl", async (ctx) => {
    // ... (This function is unchanged)
});

bot.on("callback_query:data", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        const data = ctx.callbackQuery.data;
        if (!ctx.callbackQuery.message) { console.log("Callback query has no message, skipping."); return; }

        if (data.startsWith("chart_")) {
            // ... (This part is unchanged)
        }

        if (data.startsWith("publish_")) {
            const originalText = ctx.callbackQuery.message.text;
            let messageForChannel;
            
            if (data === 'publish_close_report') {
                const markerStart = originalText.indexOf("<CLOSE_REPORT>");
                const markerEnd = originalText.indexOf("</CLOSE_REPORT>");
                if (markerStart !== -1 && markerEnd !== -1) {
                    try { messageForChannel = JSON.parse(originalText.substring(markerStart + 14, markerEnd)); } catch (e) { console.error("Could not parse CLOSE_REPORT JSON"); }
                }
            } else { // publish_trade
                const markerStart = originalText.indexOf("<CHANNEL_POST>");
                const markerEnd = originalText.indexOf("</CHANNEL_POST>");
                if (markerStart !== -1 && markerEnd !== -1) {
                    try { messageForChannel = JSON.parse(originalText.substring(markerStart + 14, markerEnd)); } catch (e) { console.error("Could not parse CHANNEL_POST JSON"); }
                }
            }
            
            if (!messageForChannel) {
                messageForChannel = "حدث خطأ في استخلاص نص النشر.";
            }

            try {
                await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, messageForChannel, { parse_mode: "Markdown" });
                await ctx.editMessageText("✅ تم النشر في القناة بنجاح.", { reply_markup: undefined });
            } catch (e) { 
                console.error("Failed to post to channel:", e); 
                await ctx.editMessageText("❌ فشل النشر في القناة.", { reply_markup: undefined }); 
            }
            return;
        }
        
        if (data === "ignore_trade" || data === "ignore_report") { 
            await ctx.editMessageText("❌ تم تجاهل الإشعار ولن يتم نشره.", { reply_markup: undefined }); 
            return; 
        }

        switch (data) {
            // ... (All cases are unchanged)
        }
    } catch (error) { console.error("Caught a critical error in callback_query handler:", error); }
});

bot.on("message:text", async (ctx) => {
    // ... (This entire function is unchanged)
});

app.get("/healthcheck", (req, res) => {
    res.status(200).send("OK");
});

async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected.");

        setInterval(monitorBalanceChanges, 60000);
        setInterval(checkPriceAlerts, 30000);
        setInterval(checkPriceMovements, 60000);
        setInterval(runHourlyJobs, 3600000);
        setInterval(runDailyJobs, 86400000);

        if (process.env.NODE_ENV === "production") {
            app.use(express.json());
            app.use(webhookCallback(bot, "express"));
            app.listen(PORT, () => console.log(`Server on port ${PORT}`));
        } else {
            await bot.start();
            console.log("Bot started with polling.");
        }
    } catch (e) {
        console.error("FATAL: Could not start the bot.", e);
    }
}

startBot();
