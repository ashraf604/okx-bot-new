// =================================================================
// OKX Advanced Analytics Bot - v77 (Features Added)
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
            return {
                realizedPnl: 0,
                tradeCount: 0,
                winningTrades: 0,
                losingTrades: 0,
                avgDuration: 0
            };
        }
        
        const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0);
        const winningTrades = history.filter(trade => trade.pnl > 0).length;
        const losingTrades = history.filter(trade => trade.pnl <= 0).length;
        const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0);
        const avgDuration = totalDuration / history.length;

        return {
            realizedPnl,
            tradeCount: history.length,
            winningTrades,
            losingTrades,
            avgDuration
        };
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

// === Helper & API Functions ===
function formatNumber(num, decimals = 2) {
    const number = parseFloat(num);
    if (isNaN(number) || !isFinite(number)) {
        return (0).toFixed(decimals);
    }
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
            if (t.instId.endsWith('-USDT')) { // Only process USDT pairs
                const lastPrice = parseFloat(t.last);
                const openPrice = parseFloat(t.open24h);
                let change24h = 0;
                if (openPrice > 0) {
                    change24h = (lastPrice - openPrice) / openPrice;
                }
                prices[t.instId] = { 
                    price: lastPrice, 
                    open24h: openPrice, 
                    change24h: change24h,
                    volCcy24h: parseFloat(t.volCcy24h) 
                };
            }
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

async function getHistoricalCandles(instId, limit = 100) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&limit=${limit}`);
        const json = await res.json();
        if (json.code !== '0' || !json.data || json.data.length === 0) {
            console.error(`Could not fetch candle history for ${instId}:`, json.msg);
            return [];
        }
        return json.data.map(c => parseFloat(c[4])).reverse();
    } catch (e) {
        console.error(`Exception in getHistoricalCandles for ${instId}:`, e);
        return [];
    }
}

function calculateSMA(closes, period) {
    if (closes.length < period) return null;
    const relevantCloses = closes.slice(-period);
    const sum = relevantCloses.reduce((acc, val) => acc + val, 0);
    return sum / period;
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) {
            gains += diff;
        } else {
            losses -= diff;
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

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
    if (closes.length < 51) {
        return { error: "بيانات الشموع غير كافية للتحليل الفني." };
    }

    const rsi = calculateRSI(closes);
    const sma20 = calculateSMA(closes, 20);
    const sma50 = calculateSMA(closes, 50);

    return {
        rsi: rsi,
        sma20: sma20,
        sma50: sma50,
    };
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

// === NEW FEATURE FUNCTIONS (formatAdvancedMarketAnalysis, formatTop5Assets, formatQuickStats) ===

async function formatAdvancedMarketAnalysis() {
    const prices = await getMarketPrices();
    if (!prices) {
        return "❌ فشل جلب بيانات السوق. يرجى المحاولة مرة أخرى.";
    }

    const marketData = Object.entries(prices).map(([instId, data]) => ({ instId, ...data }));
    
    // Filter out low-volume or invalid data
    const filteredData = marketData.filter(d => d.volCcy24h > 10000 && d.change24h !== undefined);

    // Sort for top gainers and losers
    filteredData.sort((a, b) => b.change24h - a.change24h);
    const topGainers = filteredData.slice(0, 5);
    const topLosers = filteredData.slice(-5).reverse();

    // Sort for high volume
    filteredData.sort((a, b) => b.volCcy24h - a.volCcy24h);
    const highVolume = filteredData.slice(0, 5);
    
    let msg = "🚀 *تحليل السوق المتقدم*\n";
    msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`;
    msg += "━━━━━━━━━━━━━━━━━━━\n\n";

    msg += "📈 *أكبر الرابحين (آخر 24 ساعة):*\n";
    topGainers.forEach(coin => {
        msg += `  - \`${coin.instId}\`: \`+${formatNumber(coin.change24h * 100)}%\`\n`;
    });
    msg += "\n";

    msg += "📉 *أكبر الخاسرين (آخر 24 ساعة):*\n";
    topLosers.forEach(coin => {
        msg += `  - \`${coin.instId}\`: \`${formatNumber(coin.change24h * 100)}%\`\n`;
    });
    msg += "\n";

    msg += "📊 *الأعلى في حجم التداول (USDT):*\n";
    highVolume.forEach(coin => {
        msg += `  - \`${coin.instId}\`: \`${(coin.volCcy24h / 1e6).toFixed(2)}M\`\n`;
    });
    msg += "\n";

    msg += "💡 *توصية ذكية:*\n";
    msg += "راقب الأصول ذات حجم التداول المرتفع، فهي غالبًا ما تقود اتجاه السوق.\n";
    
    return msg;
}

async function formatTop5Assets(assets) {
    if (!assets || assets.length === 0) {
        return "ℹ️ لا توجد أصول في محفظتك لعرضها.";
    }

    let msg = "🏆 *أفضل 5 أصول في محفظتك*\n";
    msg += "━━━━━━━━━━━━━━━━━━━━━━━━━\n\n";
    
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const topAssets = assets.filter(a => a.asset !== 'USDT').slice(0, 5);

    if (topAssets.length === 0) {
        return "ℹ️ لا توجد أصول (غير USDT) في محفظتك لعرضها.";
    }

    topAssets.forEach((asset, index) => {
        msg += `${medals[index] || '▪️'} *${asset.asset}*\n`;
        msg += `💰 *القيمة:* \`$${formatNumber(asset.value)}\`\n`;
        msg += `💵 *السعر:* \`$${formatNumber(asset.price, 4)}\`\n\n`;
    });
    
    msg += "━━━━━━━━━━━━━━━━━━━━━━━━━\n";
    msg += "📊 *نصائح:* ركز على الأصول ذات الأداء الجيد وادرس أسباب تفوقها.";
    
    return msg;
}

async function formatQuickStats(assets, total, capital) {
    const pnl = capital > 0 ? total - capital : 0;
    const pnlPercent = capital > 0 ? (pnl / total) * 100 : 0;
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

// === END OF NEW FEATURE FUNCTIONS ===

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
                `*النتيجة النهائية للصفقة:* ${pnlEmoji} \`${finalPnl >= 0 ? '+' : ''}${formatNumber(finalPnl)}\` (\`${finalPnl >= 0 ? '+' : ''}${formatNumber(finalPnlPercent)}%\`)\n\n` +
                `**ملخص تحليل الأداء:**\n` +
                ` - *متوسط سعر الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\`\n` +
                ` - *متوسط سعر البيع:* \`$${formatNumber(avgSellPrice, 4)}\`\n` +
                ` - *أعلى سعر خلال فترة التملك:* \`$${formatNumber(peakPrice, 4)}\``;
            
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
        dailyPnlText = ` ▫️ *الأداء اليومي (24س):* ${dailyPnlEmoji} \`${dailyPnlSign}${formatNumber(dailyPnl)}\` (\`${dailyPnlSign}${formatNumber(dailyPnlPercent)}%\`)\n`;
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
    const liquidityText = ` ▫️ *توزيع السيولة:* 💵 نقدي ${formatNumber(cashPercent, 1)}% / 📈 مستثمر ${formatNumber(investedPercent, 1)}%`;
    let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n`;
    msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📊 *نظرة عامة على الأداء:*\n`;
    msg += ` ▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`;
    msg += ` ▫️ *رأس المال المسجل:* \`$${formatNumber(capital)}\`\n`;
    msg += ` ▫️ *إجمالي الربح غير المحقق:* ${pnlEmoji} \`${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n`;
    msg += dailyPnlText;
    msg += liquidityText + `\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `💎 *مكونات المحفظة:*\n`;
    assets.forEach((a, index) => {
        let percent = total > 0 ? ((a.value / total) * 100) : 0;
        msg += "\n";
        if (a.asset === "USDT") {
            msg += `*USDT* (الرصيد النقدي) 💵\n`;
            msg += `*القيمة:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)`;
        } else {
            const change24hPercent = (a.change24h || 0) * 100;
            const changeEmoji = change24hPercent >= 0 ? '🟢⬆️' : '🔴⬇️';
            const changeSign = change24hPercent >= 0 ? '+' : '';
            msg += `╭─ *${a.asset}/USDT*\n`;
            msg += `├─ *القيمة الحالية:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)\n`;
            msg += `├─ *سعر السوق:* \`$${formatNumber(a.price, 4)}\`\n`;
            msg += `├─ *الأداء اليومي:* ${changeEmoji} \`${changeSign}${formatNumber(change24hPercent)}%\`\n`;
            const position = positions[a.asset];
            if (position && position.avgBuyPrice > 0) {
                const avgBuyPrice = position.avgBuyPrice;
                const totalCost = avgBuyPrice * a.amount;
                const assetPnl = a.value - totalCost;
                const assetPnlPercent = (totalCost > 0) ? (assetPnl / totalCost) * 100 : 0;
                const assetPnlEmoji = assetPnl >= 0 ? '🟢⬆️' : '🔴⬇️';
                const assetPnlSign = assetPnl >= 0 ? '+' : '';
                msg += `├─ *متوسط الشراء:* \`$${formatNumber(avgBuyPrice, 4)}\`\n`;
                msg += `╰─ *ربح/خسارة غير محقق:* ${assetPnlEmoji} \`${assetPnlSign}${formatNumber(assetPnl)}\` (\`${assetPnlSign}${formatNumber(assetPnlPercent)}%\`)`;
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

// ... (The rest of the functions like monitorBalanceChanges, checkPriceAlerts, etc. remain the same) ...
async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("بدء دورة التحقق من الصفقات...");
        const previousState = await loadBalanceState();
        const previousBalances = previousState.balances || {};
        
        const currentBalance = await getBalanceForComparison();
        if (!currentBalance) { return; }
        
        const prices = await getMarketPrices();
        if (!prices) { return; }
        
        const { assets: currentAssets, total: newTotalPortfolioValue } = await getPortfolio(prices);
        if (newTotalPortfolioValue === undefined) { return; }

        if (Object.keys(previousBalances).length === 0) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
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
            const portfolioPercentage = newTotalPortfolioValue > 0 ? (currAmount * price / newTotalPortfolioValue) * 100 : 0;
            const newCashValue = (currentAssets.find(a => a.asset === 'USDT') || { value: 0 }).value;
            const newCashPercentage = newTotalPortfolioValue > 0 ? (newCashValue / newTotalPortfolioValue) * 100 : 0;
            const entryOfPortfolio = previousState.totalValue > 0 ? (tradeValue / previousState.totalValue) * 100 : 0;
            
            const tradeType = (difference > 0) ? "شراء 🟢⬆️" : "بيع جزئي 🟠";
            const recommendationType = (difference > 0) ? "شراء 🟢⬆️" : "بيع جزئي 🟠";
            
            const privateTradeAnalysisText = `🔔 **تحليل حركة تداول**\n` + `━━━━━━━━━━━━━━━━━━━━\n` + `🔸 **العملية:** ${tradeType}\n` + `🔸 **الأصل:** \`${asset}/USDT\`\n` + `━━━━━━━━━━━━━━━━━━━━\n` + `📝 **تفاصيل الصفقة:**\n` + ` ▫️ *سعر التنفيذ:* \`$${formatNumber(price, 4)}\`\n` + ` ▫️ *الكمية:* \`${formatNumber(Math.abs(difference), 5)}\`\n` + ` ▫️ *قيمة الصفقة:* \`$${formatNumber(tradeValue)}\`\n` + `━━━━━━━━━━━━━━━━━━━━\n` + `📊 **التأثير على المحفظة:**\n` + ` ▫️ *حجم الصفقة من المحفظة:* \`${formatNumber(entryOfPortfolio)}%\`\n` + ` ▫️ *الوزن الجديد للعملة:* \`${formatNumber(portfolioPercentage)}%\`\n` + ` ▫️ *الرصيد النقدي الجديد:* \`$${formatNumber(newCashValue)}\`\n` + ` ▫️ *نسبة الكاش الجديدة:* \`${formatNumber(newCashPercentage)}%\`\n` + `━━━━━━━━━━━━━━━━━━━━\n` + `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*`;
            
            let publicChannelPostText;
            if (difference > 0) {
                const initialCash = previousBalances['USDT'] || 0;
                const cashConsumptionPercent = initialCash > 0 ? (tradeValue / initialCash) * 100 : 0;
                const averageBuyPrice = currentPosition ? currentPosition.avgBuyPrice : price; 
                publicChannelPostText = `🔔 **توصية: ${recommendationType}**\n\n` + `🔸 **الأصل:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الدخول:**\n` + `   ▫️ *متوسط سعر الشراء:* \`$${formatNumber(averageBuyPrice, 4)}\`\n` + `   ▫️ *حجم الدخول من المحفظة:* \`${formatNumber(entryOfPortfolio)}%\`\n\n` + `📊 **التأثير على المحفظة:**\n` + `   ▫️ *نسبة استهلاك الكاش:* \`${formatNumber(cashConsumptionPercent)}%\`\n` + `   ▫️ *الوزن الجديد للعملة:* \`${formatNumber(portfolioPercentage)}%\`\n\n` + `*بتاريخ: ${new Date().toLocaleDateString("de-DE")}*`;
            } else {
                publicChannelPostText = `🔔 **توصية: ${recommendationType}**\n\n` + `🔸 **الأصل:** \`${asset}/USDT\`\n\n` + `📝 **تفاصيل الخروج:**\n` + `   ▫️ *سعر البيع:* \`$${formatNumber(price, 4)}\`\n` + `   ▫️ *قيمة الصفقة:* \`$${formatNumber(tradeValue)}\`\n\n` + `📊 **التأثير على المحفظة:**\n` + `   ▫️ *الوزن الجديد للعملة:* \`${formatNumber(portfolioPercentage)}%\`\n` + `   ▫️ *نسبة الكاش الجديدة:* \`${formatNumber(newCashPercentage)}%\`\n\n` + `*بتاريخ: ${new Date().toLocaleDateString("de-DE")}*`;
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
            if (previousState.totalValue !== newTotalPortfolioValue) {
                await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
                await sendDebugMessage(`State updated due to portfolio value change.`);
            }
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
        let alertsTriggered = false;
        for (const alert of alerts) {
            const currentPrice = (prices[alert.instId] || {}).price;
            if (currentPrice === undefined) {
                remainingAlerts.push(alert);
                continue;
            }
            let triggered = false;
            if (alert.condition === '>' && currentPrice > alert.price) triggered = true;
            else if (alert.condition === '<' && currentPrice < alert.price) triggered = true;
            if (triggered) {
                const message = `🚨 *تنبيه سعر محدد!* 🚨\n\n- *العملة:* \`${alert.instId}\`\n- *الشرط:* تحقق (${alert.condition} ${alert.price})\n- *السعر الحالي:* \`${currentPrice}\``;
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

async function runDailyJobs() {
    try {
        console.log("Attempting to run daily jobs...");
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
            history.push({ date: date, total: total });
        }
        if (history.length > 35) history.shift();
        await saveHistory(history);
        console.log(`[✅ Daily Summary Recorded]: ${date} - $${formatNumber(total)}`);
    } catch (e) {
        console.error("CRITICAL ERROR in runDailyJobs:", e);
    }
}

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
            history.push({ label: hourLabel, total: total });
        }
        if (history.length > 72) {
            history.splice(0, history.length - 72);
        }
        await saveHourlyHistory(history);
        await sendDebugMessage(`تم حفظ السجل الساعي: ${hourLabel} - $${formatNumber(total)}`);
    } catch (e) {
        console.error("خطأ في المهام الساعية:", e);
    }
}

async function checkPriceMovements() {
    try {
        await sendDebugMessage("بدء دورة التحقق من حركة الأسعار...");
        const alertSettings = await loadAlertSettings();
        const priceTracker = await loadPriceTracker();
        const prices = await getMarketPrices();
        if (!prices) {
            await sendDebugMessage("فشل جلب أسعار السوق (استجابة غير صالحة)، تخطي دورة فحص الحركة.");
            return;
        }
        const { assets, total: currentTotalValue, error } = await getPortfolio(prices);
        if (error || currentTotalValue === undefined) {
            await sendDebugMessage("فشل جلب المحفظة، تخطي دورة فحص الحركة.");
            return;
        }
        if (priceTracker.totalPortfolioValue === 0) {
            priceTracker.totalPortfolioValue = currentTotalValue;
            assets.forEach(a => {
                if (a.price) priceTracker.assets[a.asset] = a.price;
            });
            await savePriceTracker(priceTracker);
            await sendDebugMessage("تم تسجيل قيم تتبع الأسعار الأولية.");
            return;
        }
        let trackerUpdated = false;
        const lastTotalValue = priceTracker.totalPortfolioValue;
        if (lastTotalValue > 0) {
            const changePercent = ((currentTotalValue - lastTotalValue) / lastTotalValue) * 100;
            if (Math.abs(changePercent) >= alertSettings.global) {
                const emoji = changePercent > 0 ? '🟢⬆️' : '🔴⬇️';
                const movementText = changePercent > 0 ? 'صعود' : 'هبوط';
                const message = `📊 *تنبيه حركة المحفظة الإجمالية!*\n\n*الحركة:* ${emoji} *${movementText}* بنسبة \`${formatNumber(changePercent)}%\`\n*القيمة الحالية:* \`$${formatNumber(currentTotalValue)}\``;
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
                    const message = `📈 *تنبيه حركة سعر لأصل محدد!*\n\n*الأصل:* \`${asset.asset}\`\n*الحركة:* ${emoji} *${movementText}* بنسبة \`${formatNumber(changePercent)}%\`\n*السعر الحالي:* \`$${formatNumber(currentPrice, 4)}\``;
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
            await sendDebugMessage("تم تحديث متتبع الأسعار بعد إرسال تنبيه.");
        } else {
            await sendDebugMessage("لا توجد حركات أسعار تتجاوز الحد.");
        }
    } catch (e) {
        console.error("CRITICAL ERROR in checkPriceMovements:", e);
    }
}


// === UPDATED Keyboard ===
const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("🚀 تحليل السوق").text("🏆 أفضل 5 أصول").row()
    .text("⚡ إحصائيات سريعة").text("ℹ️ معلومات عملة").row()
    .text("🔔 ضبط تنبيه").text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();

async function sendSettingsMenu(ctx) {
    try {
        const settings = await loadSettings();
        const settingsKeyboard = new InlineKeyboard()
            .text("💰 تعيين رأس المال", "set_capital")
            .text("💼 عرض المراكز المفتوحة", "view_positions").row()
            .text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts")
            .text("🗑️ حذف تنبيه سعر", "delete_alert").row()
            .text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
            .text(`🚀 النشر التلقائي للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost")
            .text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").row()
            .text("🔥 حذف جميع بيانات البوت 🔥", "delete_all_data");
        const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*";
        
        try {
            await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
        } catch {
            await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
        }
    } catch (e) {
        console.error("CRITICAL ERROR in sendSettingsMenu:", e);
        await ctx.reply(`❌ حدث خطأ فادح أثناء فتح قائمة الإعدادات.\n\nرسالة الخطأ: ${e.message}`);
    }
}

async function sendMovementAlertsMenu(ctx) {
    try {
        const alertSettings = await loadAlertSettings();
        const text = `🚨 *إدارة تنبيهات حركة الأسعار*\n\nتستخدم هذه الإعدادات لمراقبة التغيرات المئوية في الأسعار وإعلامك.\n\n- *النسبة العامة الحالية:* سيتم تنبيهك لأي أصل يتحرك بنسبة \`${alertSettings.global}%\` أو أكثر.\n- يمكنك تعيين نسبة مختلفة لعملة معينة لتجاوز الإعداد العام.`;
        const keyboard = new InlineKeyboard()
            .text("📊 تعديل النسبة العامة", "set_global_alert").row()
            .text("💎 تعديل نسبة عملة محددة", "set_coin_alert").row()
            .text("📄 عرض الإعدادات الحالية", "view_movement_alerts").row()
            .text("🔙 العودة إلى الإعدادات", "back_to_settings");
        
        try {
            await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
        } catch {
            await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
        }
    } catch (e) {
        console.error("CRITICAL ERROR in sendMovementAlertsMenu:", e);
        await ctx.reply(`❌ حدث خطأ فادح أثناء فتح قائمة تنبيهات الحركة.\n\nرسالة الخطأ: ${e.message}`);
    }
}

bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        await next();
    } else {
        console.log(`محاولة وصول غير مصرح به بواسطة معرف المستخدم: ${ctx.from?.id || 'غير محدد'}`);
    }
});

bot.command("start", async (ctx) => {
    await ctx.reply(`🤖 *بوت OKX التحليلي المتكامل*\n*الإصدار: v77 - FINAL*\n\nأهلاً بك! أنا هنا لمساعدتك في تتبع وتحليل محفظتك الاستثمارية.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));

bot.command("pnl", async (ctx) => {
    const args = ctx.match.trim().split(/\s+/);
    if (args.length !== 3 || args[0] === '') {
        return await ctx.reply(`❌ *صيغة غير صحيحة*\n\n` + `*يرجى استخدام الصيغة الصحيحة للأمر.*\n\n` + `*مثال:*\n\`/pnl <سعر الشراء> <سعر البيع> <الكمية>\``, { parse_mode: "Markdown" });
    }
    const [buyPrice, sellPrice, quantity] = args.map(parseFloat);
    if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) {
        return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم هي أرقام موجبة.");
    }
    const totalInvestment = buyPrice * quantity;
    const totalSaleValue = sellPrice * quantity;
    const profitOrLoss = totalSaleValue - totalInvestment;
    const pnlPercentage = (profitOrLoss / totalInvestment) * 100;
    const resultStatus = profitOrLoss >= 0 ? "ربح ✅" : "خسارة 🔻";
    const pnlSign = profitOrLoss >= 0 ? '+' : '';
    const responseMessage = `🧮 *نتيجة حساب الربح والخسارة*\n\n` + `📝 **المدخلات:**\n` + ` - *سعر الشراء:* \`$${buyPrice.toLocaleString()}\`\n` + ` - *سعر البيع:* \`$${sellPrice.toLocaleString()}\`\n` + ` - *الكمية:* \`${quantity.toLocaleString()}\`\n\n` + `📊 **النتائج:**\n` + ` - *إجمالي تكلفة الشراء:* \`$${totalInvestment.toLocaleString()}\`\n` + ` - *إجمالي قيمة البيع:* \`$${totalSaleValue.toLocaleString()}\`\n` + ` - *صافي الربح/الخسارة:* \`${pnlSign}${profitOrLoss.toLocaleString()}\` (\`${pnlSign}${formatNumber(pnlPercentage)}%\`)\n\n` + `**الحالة النهائية: ${resultStatus}**`;
    await ctx.reply(responseMessage, { parse_mode: "Markdown" });
});

bot.on("callback_query:data", async (ctx) => {
    try {
        await ctx.answerCallbackQuery();
        const data = ctx.callbackQuery.data;
        if (!ctx.callbackQuery.message) { console.log("Callback query has no message, skipping."); return; }

        if (data.startsWith("chart_")) {
            const period = data.split('_')[1];
            await ctx.editMessageText("⏳ جاري إنشاء تقرير الأداء...");
            let history, periodLabel, periodData;
            if (period === '24h') { history = await loadHourlyHistory(); periodLabel = "آخر 24 ساعة"; periodData = history.slice(-24); }
            else if (period === '7d') { history = await loadHistory(); periodLabel = "آخر 7 أيام"; periodData = history.slice(-7).map(h => ({ label: h.date.slice(5), total: h.total })); }
            else if (period === '30d') { history = await loadHistory(); periodLabel = "آخر 30 يومًا"; periodData = history.slice(-30).map(h => ({ label: h.date.slice(5), total: h.total })); }
            if (!periodData || periodData.length < 2) { await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لإنشاء تقرير لهذه الفترة."); return; }
            const stats = calculatePerformanceStats(periodData);
            if (!stats) { await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لإنشاء تقرير لهذه الفترة."); return; }
            const chartUrl = createChartUrl(periodData, periodLabel, stats.pnl);
            const pnlEmoji = stats.pnl >= 0 ? '🟢⬆️' : '🔴⬇️';
            const pnlSign = stats.pnl >= 0 ? '+' : '';
            const caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n\n` + `📈 **النتيجة:** ${pnlEmoji} \`${pnlSign}${formatNumber(stats.pnl)}\` (\`${pnlSign}${formatNumber(stats.pnlPercent)}%\`)\n` + `*التغير الصافي: من \`$${formatNumber(stats.startValue)}\` إلى \`$${formatNumber(stats.endValue)}\`*\n\n` + `📝 **ملخص إحصائيات الفترة:**\n` + ` ▫️ *أعلى قيمة وصلت لها المحفظة:* \`$${formatNumber(stats.maxValue)}\`\n` + ` ▫️ *أدنى قيمة وصلت لها المحفظة:* \`$${formatNumber(stats.minValue)}\`\n` + ` ▫️ *متوسط قيمة المحفظة:* \`$${formatNumber(stats.avgValue)}\`\n\n` + `*التقرير تم إنشاؤه في: ${new Date().toLocaleDateString("en-GB").replace(/\//g, '.')}*`;
            try { await ctx.replyWithPhoto(chartUrl, { caption: caption, parse_mode: "Markdown" }); await ctx.deleteMessage(); } catch (e) { console.error("Failed to send chart:", e); await ctx.editMessageText("❌ فشل إنشاء الرسم البياني. قد تكون هناك مشكلة في خدمة الرسوم البيانية."); }
            return;
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
            if (!messageForChannel) { messageForChannel = "حدث خطأ في استخلاص نص النشر."; }
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
            case "view_positions":
                const positions = await loadPositions();
                if (Object.keys(positions).length === 0) { await ctx.editMessageText("ℹ️ لا توجد مراكز مفتوحة قيد التتبع حاليًا.", { reply_markup: new InlineKeyboard().text("🔙 العودة إلى الإعدادات", "back_to_settings") }); } else {
                    let msg = "📄 *قائمة المراكز المفتوحة التي يتم تتبعها تلقائيًا:*\n";
                    for (const symbol in positions) { const pos = positions[symbol]; msg += `\n╭─ *${symbol}*`; const avgBuyPriceText = pos && pos.avgBuyPrice ? `$${formatNumber(pos.avgBuyPrice, 4)}` : 'غير متاح'; const totalAmountText = pos && pos.totalAmountBought ? formatNumber(pos.totalAmountBought, 6) : 'غير متاح'; const openDateText = pos && pos.openDate ? new Date(pos.openDate).toLocaleDateString('en-GB') : 'غير متاح'; msg += `\n├─ *متوسط الشراء:* \`${avgBuyPriceText}\``; msg += `\n├─ *الكمية الإجمالية المشتراة:* \`${totalAmountText}\``; msg += `\n╰─ *تاريخ فتح المركز:* \`${openDateText}\``; }
                    await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة إلى الإعدادات", "back_to_settings") });
                }
                break;
            case "back_to_settings": await sendSettingsMenu(ctx); break;
            case "manage_movement_alerts": await sendMovementAlertsMenu(ctx); break;
            case "set_global_alert": waitingState = 'set_global_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال النسبة المئوية العامة الجديدة لتنبيهات الحركة (مثال: `5` لـ 5%)."); break;
            case "set_coin_alert": waitingState = 'set_coin_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال رمز العملة والنسبة المئوية المخصصة لها.\n*مثال لضبط تنبيه عند 2.5% لـ BTC:*\n`BTC 2.5`\n\n*لحذف الإعداد المخصص لعملة ما وإعادتها للنسبة العامة، أرسل نسبة 0.*"); break;
            case "view_movement_alerts": const alertSettings = await loadAlertSettings(); let msg_alerts = `🚨 *الإعدادات الحالية لتنبيهات الحركة:*\n\n` + `*النسبة العامة (Global):* \`${alertSettings.global}%\`\n` + `--------------------\n*النسب المخصصة (Overrides):*\n`; if (Object.keys(alertSettings.overrides).length === 0) { msg_alerts += "لا توجد نسب مخصصة حاليًا." } else { for (const coin in alertSettings.overrides) { msg_alerts += `- *${coin}:* \`${alertSettings.overrides[coin]}%\`\n`; } } await ctx.editMessageText(msg_alerts, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة", "manage_movement_alerts") }); break;
            case "set_capital": waitingState = 'set_capital'; await ctx.editMessageText("💰 يرجى إرسال المبلغ الجديد لرأس المال (رقم فقط).", { reply_markup: undefined }); break;
            case "delete_alert": const alerts = await loadAlerts(); if (alerts.length === 0) { await ctx.editMessageText("ℹ️ لا توجد تنبيهات سعر محدد مسجلة حاليًا.", { reply_markup: new InlineKeyboard().text("🔙 العودة إلى الإعدادات", "back_to_settings") }); } else { let msg = "🗑️ *قائمة تنبيهات السعر المسجلة:*\n\n"; alerts.forEach((alert, index) => { msg += `*${index + 1}.* \`${alert.instId}\` عندما يكون السعر ${alert.condition === '>' ? 'أعلى من' : 'أقل من'} \`${alert.price}\`\n`; }); msg += "\n*يرجى إرسال رقم التنبيه الذي تود حذفه.*"; waitingState = 'delete_alert_number'; await ctx.editMessageText(msg, { parse_mode: "Markdown" }); } break;
            case "toggle_summary": case "toggle_autopost": case "toggle_debug": { let settings = await loadSettings(); if (data === 'toggle_summary') settings.dailySummary = !settings.dailySummary; else if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel; else if (data === 'toggle_debug') settings.debugMode = !settings.debugMode; await saveSettings(settings); await sendSettingsMenu(ctx); } break;
            case "delete_all_data": waitingState = 'confirm_delete_all'; await ctx.editMessageText("⚠️ *تحذير: هذا الإجراء لا يمكن التراجع عنه!* ⚠️\n\nسيتم حذف جميع بياناتك المخزنة، بما في ذلك رأس المال، المراكز، سجل الأداء، وجميع الإعدادات.\n\n*للمتابعة، أرسل كلمة: `تأكيد الحذف`*", { parse_mode: "Markdown", reply_markup: undefined }); setTimeout(() => { if (waitingState === 'confirm_delete_all') waitingState = null; }, 30000); break;
        }
    } catch (error) { console.error("Caught a critical error in callback_query handler:", error); }
});

bot.on("message:text", async (ctx) => {
    try {
        const text = ctx.message.text.trim();
        if (ctx.message.text && ctx.message.text.startsWith('/')) { return; }

        // Local variables for portfolio data to avoid refetching
        let prices, capital, assets, total, error;
        
        const fetchPortfolioData = async () => {
            if (!assets) { // Fetch only if not already fetched
                prices = await getMarketPrices();
                if (!prices) return { error: "❌ عذرًا، فشل في جلب أسعار السوق من OKX حاليًا." };
                capital = await loadCapital();
                const portfolioData = await getPortfolio(prices);
                assets = portfolioData.assets;
                total = portfolioData.total;
                error = portfolioData.error;
            }
            return { prices, capital, assets, total, error };
        };

        switch (text) {
            case "📊 عرض المحفظة":
                await ctx.reply("⏳ لحظات... جاري إعداد تقرير المحفظة.");
                const portfolioResult = await fetchPortfolioData();
                if (portfolioResult.error) { return await ctx.reply(portfolioResult.error); }
                const msgPortfolio = await formatPortfolioMsg(portfolioResult.assets, portfolioResult.total, portfolioResult.capital);
                await ctx.reply(msgPortfolio, { parse_mode: "Markdown" });
                return;
            
            // --- NEW FEATURE HANDLERS ---
            case "🚀 تحليل السوق":
                await ctx.reply("⏳ جاري تحليل بيانات السوق...");
                const marketMsg = await formatAdvancedMarketAnalysis();
                await ctx.reply(marketMsg, { parse_mode: "Markdown" });
                return;

            case "🏆 أفضل 5 أصول":
                await ctx.reply("⏳ جاري تحليل أصول محفظتك...");
                const topAssetsResult = await fetchPortfolioData();
                if (topAssetsResult.error) { return await ctx.reply(topAssetsResult.error); }
                const topAssetsMsg = await formatTop5Assets(topAssetsResult.assets);
                await ctx.reply(topAssetsMsg, { parse_mode: "Markdown" });
                return;

            case "⚡ إحصائيات سريعة":
                await ctx.reply("⏳ لحظات... جاري حساب الإحصائيات.");
                const quickStatsResult = await fetchPortfolioData();
                if (quickStatsResult.error) { return await ctx.reply(quickStatsResult.error); }
                const quickStatsMsg = await formatQuickStats(quickStatsResult.assets, quickStatsResult.total, quickStatsResult.capital);
                await ctx.reply(quickStatsMsg, { parse_mode: "Markdown" });
                return;

            // --- END OF NEW FEATURE HANDLERS ---

            case "📈 أداء المحفظة": const performanceKeyboard = new InlineKeyboard().text("آخر 24 ساعة", "chart_24h").row().text("آخر 7 أيام", "chart_7d").row().text("آخر 30 يومًا", "chart_30d"); await ctx.reply("اختر الفترة الزمنية المطلوبة لعرض تقرير الأداء:", { reply_markup: performanceKeyboard }); return;
            case "ℹ️ معلومات عملة": waitingState = 'coin_info'; await ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`)."); return;
            case "⚙️ الإعدادات": await sendSettingsMenu(ctx); return;
            case "🔔 ضبط تنبيه": waitingState = 'set_alert'; await ctx.reply("✍️ *لضبط تنبيه سعر محدد، استخدم الصيغة:*\n`BTC > 50000`\n`ETH < 3000`", {parse_mode: "Markdown"}); return;
            case "🧮 حاسبة الربح والخسارة": await ctx.reply("✍️ لحساب الربح/الخسارة، استخدم أمر `/pnl` بالصيغة التالية:\n`/pnl <سعر الشراء> <سعر البيع> <الكمية>`", {parse_mode: "Markdown"}); return;
        }

        if (waitingState) {
            const state = waitingState;
            waitingState = null;
            switch (state) {
                case 'set_capital': const amount = parseFloat(text); if (!isNaN(amount) && amount >= 0) { await saveCapital(amount); await ctx.reply(`✅ *تم تحديث رأس المال بنجاح.*\n\n💰 **المبلغ الجديد:** \`$${formatNumber(amount)}\``, { parse_mode: "Markdown" }); } else { await ctx.reply("❌ مبلغ غير صالح. يرجى إرسال رقم فقط."); } return;
                case 'set_global_alert_state': const percent = parseFloat(text); if (isNaN(percent) || percent <= 0) { return await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا موجبًا."); } let alertSettingsGlobal = await loadAlertSettings(); alertSettingsGlobal.global = percent; await saveAlertSettings(alertSettingsGlobal); await ctx.reply(`✅ تم تحديث النسبة العامة لتنبيهات الحركة إلى \`${percent}%\`.`); return;
                case 'set_coin_alert_state': const parts_coin_alert = text.split(/\s+/); if (parts_coin_alert.length !== 2) { return await ctx.reply("❌ *صيغة غير صحيحة*. يرجى إرسال رمز العملة ثم النسبة."); } const [symbol_coin_alert, percentStr_coin_alert] = parts_coin_alert; const coinPercent = parseFloat(percentStr_coin_alert); if (isNaN(coinPercent) || coinPercent < 0) { return await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا."); } let alertSettingsCoin = await loadAlertSettings(); if (coinPercent === 0) { delete alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()]; await ctx.reply(`✅ تم حذف الإعداد المخصص لـ *${symbol_coin_alert.toUpperCase()}* وستتبع الآن النسبة العامة.`); } else { alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()] = coinPercent; await ctx.reply(`✅ تم تحديث النسبة المخصصة لـ *${symbol_coin_alert.toUpperCase()}* إلى \`${coinPercent}%\`.`); } await saveAlertSettings(alertSettingsCoin); return;
                case 'coin_info':
                    const instId = text.toUpperCase();
                    const coinSymbol = instId.split('-')[0];
                    const loadingMessage = await ctx.reply(`⏳ جاري البحث وتجهيز الملف التحليلي الكامل لـ ${instId}...`);
                    
                    try {
                        const [details, prices, historicalPerf, techAnalysis] = await Promise.all([
                            getInstrumentDetails(instId),
                            getMarketPrices(),
                            getHistoricalPerformance(coinSymbol),
                            getTechnicalAnalysis(instId)
                        ]);

                        if (details.error) {
                            return await ctx.api.editMessageText(loadingMessage.chat.id, loadingMessage.message_id, `❌ ${details.error}`);
                        }

                        let msg = `ℹ️ *الملف التحليلي الكامل | ${instId}*\n\n` +
                                  `*القسم الأول: بيانات السوق*\n` +
                                  ` ▫️ *السعر الحالي:* \`$${formatNumber(details.price, 4)}\`\n` +
                                  ` ▫️ *أعلى سعر (24س):* \`$${formatNumber(details.high24h, 4)}\`\n` +
                                  ` ▫️ *أدنى سعر (24س):* \`$${formatNumber(details.low24h, 4)}\`\n` +
                                  ` ▫️ *حجم التداول (24س):* \`$${(details.vol24h || 0).toLocaleString()}\`\n\n`;

                        msg += `*القسم الثاني: تحليل مركزك الحالي*\n`;
                        const { assets: userAssets } = await getPortfolio(prices);
                        const ownedAsset = userAssets.find(a => a.asset === coinSymbol);
                        const positions = await loadPositions();
                        const assetPosition = positions[coinSymbol];

                        if (ownedAsset && assetPosition && assetPosition.avgBuyPrice) {
                            const totalPnl = (details.price * ownedAsset.amount) - (assetPosition.avgBuyPrice * ownedAsset.amount);
                            const totalPnlPercent = (assetPosition.avgBuyPrice > 0) ? (totalPnl / (assetPosition.avgBuyPrice * ownedAsset.amount)) * 100 : 0;
                            const totalPnlEmoji = totalPnl >= 0 ? '🟢' : '🔴';
                            const openDate = new Date(assetPosition.openDate);
                            const durationDays = (new Date().getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24);
                            
                            msg += ` ▪️ *متوسط سعر الشراء:* \`$${formatNumber(assetPosition.avgBuyPrice, 4)}\`\n`;
                            msg += ` ▪️ *الربح/الخسارة غير المحقق:* ${totalPnlEmoji} \`${formatNumber(totalPnl)}\` (\`${formatNumber(totalPnlPercent)}%\`)\n`;
                            msg += ` ▪️ *مدة فتح المركز:* \`${formatNumber(durationDays, 1)} يوم\`\n\n`;
                        } else {
                            msg += ` ▪️ لا يوجد مركز مفتوح حالياً لهذه العملة.\n\n`;
                        }

                        msg += `*القسم الثالث: تاريخ أدائك مع العملة*\n`;
                        if (historicalPerf && historicalPerf.tradeCount > 0) {
                            const pnlSign = historicalPerf.realizedPnl >= 0 ? '+' : '';
                            msg += ` ▪️ *إجمالي الربح/الخسارة المحقق:* \`${pnlSign}${formatNumber(historicalPerf.realizedPnl)}\`\n`;
                            msg += ` ▪️ *سجل الصفقات:* \`${historicalPerf.tradeCount}\` صفقات سابقة (${historicalPerf.winningTrades} رابحة / ${historicalPerf.losingTrades} خاسرة)\n`;
                            msg += ` ▪️ *متوسط مدة الصفقة:* \`${formatNumber(historicalPerf.avgDuration, 1)} يوم\`\n\n`;
                        } else {
                            msg += ` ▪️ لا يوجد تاريخ صفقات مغلقة لهذه العملة.\n\n`;
                        }

                        msg += `*القسم الرابع: مؤشرات فنية بسيطة*\n`;
                        if (techAnalysis.error) {
                            msg += ` ▪️ ${techAnalysis.error}\n`;
                        } else {
                            let rsiText = "منطقة محايدة";
                            if (techAnalysis.rsi > 70) rsiText = "منطقة تشبع شرائي 🔴";
                            if (techAnalysis.rsi < 30) rsiText = "منطقة تشبع بيعي 🟢";
                            
                            msg += ` ▪️ *مؤشر القوة النسبية (RSI):* \`${formatNumber(techAnalysis.rsi)}\` (${rsiText})\n`;
                            msg += ` ▪️ *موقفه من المتوسطات المتحركة:*\n`;
                            if(techAnalysis.sma20) msg += `    - السعر الحالي *${details.price > techAnalysis.sma20 ? 'فوق' : 'تحت'}* متوسط 20 يوم (\`$${formatNumber(techAnalysis.sma20, 4)}\`)\n`;
                            if(techAnalysis.sma50) msg += `    - السعر الحالي *${details.price > techAnalysis.sma50 ? 'فوق' : 'تحت'}* متوسط 50 يوم (\`$${formatNumber(techAnalysis.sma50, 4)}\`)`;
                        }

                        await ctx.api.editMessageText(loadingMessage.chat.id, loadingMessage.message_id, msg, { parse_mode: "Markdown" });

                    } catch (e) {
                        console.error("Error in coin_info deep dive:", e);
                        await ctx.api.editMessageText(loadingMessage.chat.id, loadingMessage.message_id, "❌ حدث خطأ غير متوقع أثناء تجميع التقرير.");
                    }
                    return;
                case 'set_alert':
                    const parts_alert = text.trim().split(/\s+/);
                    if (parts_alert.length !== 3) { return await ctx.reply("❌ صيغة غير صحيحة. يرجى استخدام الصيغة: `SYMBOL > PRICE`"); }
                    const [alertInstId, condition, priceStr] = parts_alert;
                    if (condition !== '>' && condition !== '<') { return await ctx.reply("❌ الشرط غير صالح. استخدم `>` أو `<` فقط."); }
                    const alertPrice = parseFloat(priceStr);
                    if (isNaN(alertPrice) || alertPrice <= 0) { return await ctx.reply("❌ السعر غير صالح."); }
                    const alertsList = await loadAlerts();
                    alertsList.push({ instId: alertInstId.toUpperCase(), condition: condition, price: alertPrice });
                    await saveAlerts(alertsList);
                    await ctx.reply(`✅ تم ضبط التنبيه بنجاح:\nسيتم إعلامك إذا أصبح سعر *${alertInstId.toUpperCase()}* ${condition === '>' ? 'أعلى من' : 'أقل من'} *${alertPrice}*`, { parse_mode: "Markdown" });
                    return;
                case 'delete_alert_number':
                    const alertIndex = parseInt(text) - 1;
                    let currentAlerts = await loadAlerts();
                    if (isNaN(alertIndex) || alertIndex < 0 || alertIndex >= currentAlerts.length) {
                        return await ctx.reply("❌ رقم غير صالح. يرجى الاختيار من القائمة.");
                    }
                    const removedAlert = currentAlerts.splice(alertIndex, 1)[0];
                    await saveAlerts(currentAlerts);
                    await ctx.reply(`✅ تم حذف التنبيه بنجاح:\n\`${removedAlert.instId} ${removedAlert.condition} ${removedAlert.price}\``, { parse_mode: "Markdown" });
                    return;
                case 'confirm_delete_all': if (text === 'تأكيد الحذف') { await getCollection("configs").deleteMany({}); await ctx.reply("✅ تم حذف جميع بياناتك المخزنة بنجاح. يمكنك البدء من جديد."); } else { await ctx.reply("❌ تم إلغاء عملية الحذف."); } return;
            }
        }
    } catch (error) { console.error("Caught a critical error in message:text handler:", error); }
});

// === Healthcheck endpoint for hosting platforms ===
app.get("/healthcheck", (req, res) => {
    res.status(200).send("OK");
});

// === Start Bot ===
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
