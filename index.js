// =================================================================
// OKX Advanced Analytics Bot - v119 (The Final & Correct Vercel Handler)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

// --- Bot Setup ---
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const AUTHORIZED_USER_ID = process.env.AUTHORIZED_USER_ID;
const API_BASE_URL = "https://www.okx.com";

// --- State Variables ---
let waitingState = null;

// =================================================================
// SECTION 1: DATABASE (VERCEL KV) AND HELPER FUNCTIONS
// =================================================================

let redis;
function connectDB() {
    if (!redis) {
        if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
            throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN must be set in Vercel environment.");
        }
        redis = new Redis({
            url: process.env.KV_REST_API_URL,
            token: process.env.KV_REST_API_TOKEN,
        });
        console.log("Successfully connected to Vercel KV (Redis).");
    }
    return redis;
}

function getDB() {
    if (!redis) return connectDB();
    return redis;
}

// ... All your database helper functions are here (getConfig, saveConfig, etc.)
async function getConfig(id, defaultValue = {}) { try { const data = await getDB().get(`config:${id}`); return data ? data : defaultValue; } catch (e) { console.error(`DB Error in getConfig for id: ${id}`, e); return defaultValue; } }
async function saveConfig(id, data) { try { await getDB().set(`config:${id}`, data); } catch (e) { console.error(`DB Error in saveConfig for id: ${id}`, e); } }
async function saveClosedTrade(tradeData) { try { await getDB().lpush("tradeHistory", JSON.stringify(tradeData)); } catch (e) { console.error("Error in saveClosedTrade:", e); } }
async function getHistoricalPerformance(asset) { try { const historyRaw = await getDB().lrange("tradeHistory", 0, -1); const history = historyRaw.map(item => JSON.parse(item)).filter(trade => trade.asset === asset); if (history.length === 0) return { realizedPnl: 0, tradeCount: 0, winningTrades: 0, losingTrades: 0, avgDuration: 0 }; const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0); const winningTrades = history.filter(trade => trade.pnl > 0).length; const losingTrades = history.filter(trade => trade.pnl <= 0).length; const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0); const avgDuration = history.length > 0 ? totalDuration / history.length : 0; return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration }; } catch (e) { console.error(`Error fetching historical performance for ${asset}:`, e); return null; } }
async function saveVirtualTrade(tradeData) { try { const tradeWithId = { ...tradeData, _id: crypto.randomBytes(16).toString("hex") }; await getDB().hset("virtualTrades", { [tradeWithId._id]: JSON.stringify(tradeWithId) }); return tradeWithId; } catch (e) { console.error("Error saving virtual trade:", e); } }
async function getActiveVirtualTrades() { try { const allTrades = await getDB().hgetall("virtualTrades"); return allTrades ? Object.values(allTrades).map(item => JSON.parse(item)).filter(trade => trade.status === 'active') : []; } catch (e) { console.error("Error fetching active virtual trades:", e); return []; } }
async function updateVirtualTradeStatus(tradeId, status, finalPrice) { try { const tradeRaw = await getDB().hget("virtualTrades", tradeId); if (tradeRaw) { const trade = JSON.parse(tradeRaw); trade.status = status; trade.closePrice = finalPrice; trade.closedAt = new Date(); await getDB().hset("virtualTrades", { [tradeId]: JSON.stringify(trade) }); } } catch (e) { console.error(`Error updating virtual trade ${tradeId}:`, e); } }
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
function formatNumber(num, decimals = 2) { const number = parseFloat(num); if (isNaN(number) || !isFinite(number)) return (0).toFixed(decimals); return number.toFixed(decimals); }
async function sendDebugMessage(message) { const settings = await loadSettings(); if (settings.debugMode) { try { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" }); } catch (e) { console.error("Failed to send debug message:", e); } } }
function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }


// =================================================================
// SECTIONS 2, 3, 4: ALL DATA, FORMATTING, AND BACKGROUND FUNCTIONS
// This includes all your functions like getMarketPrices, formatPortfolioMsg, monitorBalanceChanges, etc.
// They are correct and preserved. For brevity, they are not all pasted again.
// =================================================================
async function getMarketPrices() { try { const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { console.error("Failed to fetch market prices (OKX Error):", tickersJson.msg); return null; } const prices = {}; tickersJson.data.forEach(t => { if (t.instId.endsWith('-USDT')) { const lastPrice = parseFloat(t.last); const openPrice = parseFloat(t.open24h); let change24h = 0; if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice; prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h, volCcy24h: parseFloat(t.volCcy24h) }; } }); return prices; } catch (error) { console.error("Exception in getMarketPrices:", error.message); return null; } }
async function getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) { return { error: `فشل جلب المحفظة: ${json.msg || 'بيانات غير متوقعة من المنصة'}` }; } let assets = [], total = 0, usdtValue = 0; json.data[0].details.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 }; const value = amount * priceData.price; total += value; if (asset.ccy === "USDT") { usdtValue = value; } if (value >= 1) { assets.push({ asset: asset.ccy, price: priceData.price, value, amount, change24h: priceData.change24h }); } } }); assets.sort((a, b) => b.value - a.value); return { assets, total, usdtValue }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
// ... and so on for all other functions in these sections...
async function getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0' || !json.data || !json.data[0] || !json.data[0].details) return null; const balanceMap = {}; json.data[0].details.forEach(asset => { balanceMap[asset.ccy] = parseFloat(asset.eq); }); return balanceMap; } catch (error) { console.error("Exception in getBalanceForComparison:", error); return null; } }
async function getInstrumentDetails(instId) { try { const tickerRes = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const tickerJson = await tickerRes.json(); if (tickerJson.code !== '0' || !tickerJson.data[0]) return { error: `لم يتم العثور على العملة.` }; const tickerData = tickerJson.data[0]; return { price: parseFloat(tickerData.last), high24h: parseFloat(tickerData.high24h), low24h: parseFloat(tickerData.low24h), vol24h: parseFloat(tickerData.volCcy24h), }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getHistoricalCandles(instId, limit = 100) { try { const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&limit=${limit}`); const json = await res.json(); if (json.code !== '0' || !json.data || json.data.length === 0) return []; return json.data.map(c => parseFloat(c[4])).reverse(); } catch (e) { console.error(`Exception in getHistoricalCandles for ${instId}:`, e); return []; } }
function calculateSMA(closes, period) { if (closes.length < period) return null; const sum = closes.slice(-period).reduce((acc, val) => acc + val, 0); return sum / period; }
function calculateRSI(closes, period = 14) { if (closes.length < period + 1) return null; let gains = 0, losses = 0; for (let i = 1; i <= period; i++) { const diff = closes[i] - closes[i - 1]; diff > 0 ? gains += diff : losses -= diff; } let avgGain = gains / period, avgLoss = losses / period; for (let i = period + 1; i < closes.length; i++) { const diff = closes[i] - closes[i - 1]; if (diff > 0) { avgGain = (avgGain * (period - 1) + diff) / period; avgLoss = (avgLoss * (period - 1)) / period; } else { avgLoss = (avgLoss * (period - 1) - diff) / period; avgGain = (avgGain * (period - 1)) / period; } } if (avgLoss === 0) return 100; const rs = avgGain / avgLoss; return 100 - (100 / (1 + rs)); }
async function getTechnicalAnalysis(instId) { const closes = await getHistoricalCandles(instId, 51); if (closes.length < 51) return { error: "بيانات الشموع غير كافية." }; return { rsi: calculateRSI(closes), sma20: calculateSMA(closes, 20), sma50: calculateSMA(closes, 50) }; }
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values[0]; const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0) ? (pnl / startValue) * 100 : 0; const maxValue = Math.max(...values); const minValue = Math.min(...values); const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length; return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue }; }
function createChartUrl(history, periodLabel, pnl) { if (history.length < 2) return null; const chartColor = pnl >= 0 ? 'rgb(75, 192, 75)' : 'rgb(255, 99, 132)'; const chartBgColor = pnl >= 0 ? 'rgba(75, 192, 75, 0.2)' : 'rgba(255, 99, 132, 0.2)'; const labels = history.map(h => h.label); const data = history.map(h => h.total.toFixed(2)); const chartConfig = { type: 'line', data: { labels: labels, datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: chartBgColor, borderColor: chartColor, tension: 0.1 }] }, options: { title: { display: true, text: `أداء المحفظة - ${periodLabel}` } } }; return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`; }
function formatPrivateBuy(details) { const { asset, price, amountChange, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; let msg = `*مراقبة الأصول 🔬:*\n**عملية استحواذ جديدة 🟢**\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`; msg += `🔸 **نوع العملية:** تعزيز مركز / بناء مركز جديد\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`; msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`\n`; msg += ` ▪️ **الكمية المضافة:** \`${formatNumber(Math.abs(amountChange), 6)}\`\n`; msg += ` ▪️ **التكلفة الإجمالية للصفقة:** \`$${formatNumber(tradeValue)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`; msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(tradeSizePercent)}%\`\n`; msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`\n`; msg += ` ▪️ **السيولة المتبقية (USDT):** \`$${formatNumber(newUsdtValue)}\`\n`; msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }
function formatPrivateSell(details) { const { asset, price, amountChange, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; let msg = `*مراقبة الأصول 🔬:*\n**مناورة تكتيكية 🟠**\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `🔸 **الأصل المستهدف:** \`${asset}/USDT\`\n`; msg += `🔸 **نوع العملية:** تخفيف المركز / جني أرباح جزئي\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*تحليل الصفقة:*\n`; msg += ` ▪️ **سعر التنفيذ:** \`$${formatNumber(price, 4)}\`\n`; msg += ` ▪️ **الكمية المخففة:** \`${formatNumber(Math.abs(amountChange), 6)}\`\n`; msg += ` ▪️ **العائد الإجمالي للصفقة:** \`$${formatNumber(tradeValue)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*التأثير على هيكل المحفظة:*\n`; msg += ` ▪️ **حجم الصفقة من إجمالي المحفظة:** \`${formatNumber(tradeSizePercent)}%\`\n`; msg += ` ▪️ **الوزن الجديد للأصل:** \`${formatNumber(newAssetWeight)}%\`\n`; msg += ` ▪️ **السيولة الجديدة (USDT):** \`$${formatNumber(newUsdtValue)}\`\n`; msg += ` ▪️ **مؤشر السيولة الحالي:** \`${formatNumber(newCashPercent)}%\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }
function formatPrivateCloseReport(details) { const { asset, avgBuyPrice, avgSellPrice, pnl, pnlPercent, durationDays, highestPrice, lowestPrice } = details; const pnlSign = pnl >= 0 ? '+' : ''; const emoji = pnl >= 0 ? '🟢' : '🔴'; let msg = `*ملف المهمة المكتملة 📂:*\n**تم إغلاق مركز ${asset} بنجاح ✅**\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*النتيجة النهائية للمهمة:*\n`; msg += ` ▪️ **الحالة:** **${pnl >= 0 ? "مربحة" : "خاسرة"}**\n`; msg += ` ▪️ **صافي الربح/الخسارة:** \`${pnlSign}$${formatNumber(pnl)}\` ${emoji}\n`; msg += ` ▪️ **نسبة العائد على الاستثمار (ROI):** \`${pnlSign}${formatNumber(pnlPercent)}%\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*الجدول الزمني والأداء:*\n`; msg += ` ▪️ **مدة الاحتفاظ بالمركز:** \`${formatNumber(durationDays, 1)} يوم\`\n`; msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`\n`; msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`\n`; msg += ` ▪️ **أعلى قمة سعرية مسجلة:** \`$${formatNumber(highestPrice, 4)}\`\n`; msg += ` ▪️ **أدنى قاع سعري مسجل:** \`$${formatNumber(lowestPrice, 4)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*بتاريخ الإغلاق:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }
function formatPublicBuy(details) { const { asset, price, oldTotalValue, tradeValue, oldUsdtValue, newCashPercent } = details; const tradeSizePercent = oldTotalValue > 0 ? (tradeValue / oldTotalValue) * 100 : 0; const cashConsumedPercent = (oldUsdtValue > 0) ? (tradeValue / oldUsdtValue) * 100 : 0; let msg = `*💡 توصية جديدة: بناء مركز في ${asset} 🟢*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${asset}/USDT\`\n`; msg += `*سعر الدخول الحالي:* \`$${formatNumber(price, 4)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*استراتيجية إدارة المحفظة:*\n`; msg += ` ▪️ *حجم الدخول:* تم تخصيص \`${formatNumber(tradeSizePercent)}%\` من المحفظة لهذه الصفقة.\n`; msg += ` ▪️ *استهلاك السيولة:* استهلك هذا الدخول \`${formatNumber(cashConsumedPercent)}%\` من السيولة النقدية المتاحة.\n`; msg += ` ▪️ *السيولة المتبقية:* بعد الصفقة، أصبحت السيولة تشكل \`${formatNumber(newCashPercent)}%\` من المحفظة.\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nنرى في هذه المستويات فرصة واعدة. المراقبة مستمرة، وسنوافيكم بتحديثات إدارة الصفقة.\n`; msg += `#توصية #${asset}`; return msg; }
function formatPublicSell(details) { const { asset, price, amountChange, position } = details; const totalPositionAmountBeforeSale = position.totalAmountBought - (position.totalAmountSold - Math.abs(amountChange)); const soldPercent = totalPositionAmountBeforeSale > 0 ? (Math.abs(amountChange) / totalPositionAmountBeforeSale) * 100 : 0; const partialPnl = (price - position.avgBuyPrice); const partialPnlPercent = position.avgBuyPrice > 0 ? (partialPnl / position.avgBuyPrice) * 100 : 0; let msg = `*⚙️ تحديث التوصية: إدارة مركز ${asset} 🟠*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${asset}/USDT\`\n`; msg += `*سعر البيع الجزئي:* \`$${formatNumber(price, 4)}\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*استراتيجية إدارة المحفظة:*\n`; msg += ` ▪️ *الإجراء:* تم بيع \`${formatNumber(soldPercent)}%\` من مركزنا لتأمين الأرباح.\n`; msg += ` ▪️ *النتيجة:* ربح محقق على الجزء المباع بنسبة \`${formatNumber(partialPnlPercent)}%\` 🟢.\n`; msg += ` ▪️ *حالة المركز:* لا يزال المركز مفتوحًا بالكمية المتبقية.\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملاحظات:*\nخطوة استباقية لإدارة المخاطر وحماية رأس المال. نستمر في متابعة الأهداف الأعلى.\n`; msg += `#إدارة_مخاطر #${asset}`; return msg; }
function formatPublicClose(details) { const { asset, pnlPercent, durationDays, avgBuyPrice, avgSellPrice } = details; const pnlSign = pnlPercent >= 0 ? '+' : ''; const emoji = pnlPercent >= 0 ? '🟢' : '🔴'; let msg = `*🏆 النتيجة النهائية لتوصية ${asset} ✅*\n━━━━━━━━━━━━━━━━━━━━\n`; msg += `*الأصل:* \`${asset}/USDT\`\n`; msg += `*الحالة:* **تم إغلاق الصفقة بالكامل.**\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*ملخص أداء التوصية:*\n`; msg += ` ▪️ **متوسط سعر الدخول:** \`$${formatNumber(avgBuyPrice, 4)}\`\n`; msg += ` ▪️ **متوسط سعر الخروج:** \`$${formatNumber(avgSellPrice, 4)}\`\n`; msg += ` ▪️ **العائد النهائي على الاستثمار (ROI):** \`${pnlSign}${formatNumber(pnlPercent)}%\` ${emoji}\n`; msg += ` ▪️ **مدة التوصية:** \`${formatNumber(durationDays, 1)} يوم\`\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n*الخلاصة:*\n`; if (pnlPercent >= 0) { msg += `صفقة موفقة أثبتت أن الصبر على التحليل يؤتي ثماره.\n`; } else { msg += `الخروج بانضباط وفقًا للخطة هو نجاح بحد ذاته. نحافظ على رأس المال للفرصة القادمة.\n`; } msg += `\nنبارك لمن اتبع التوصية. نستعد الآن للبحث عن الفرصة التالية.\n`; msg += `#نتائجتوصيات #${asset}`; return msg; }
async function formatPortfolioMsg(assets, total, capital) { const positions = await loadPositions(); let dailyPnlText = " ▫️ *الأداء اليومي (24س):* `لا توجد بيانات كافية`\n"; let totalValue24hAgo = 0; assets.forEach(asset => { if (asset.asset === 'USDT') totalValue24hAgo += asset.value; else if (asset.change24h !== undefined && asset.price > 0) totalValue24hAgo += asset.amount * (asset.price / (1 + asset.change24h)); else totalValue24hAgo += asset.value; }); if (totalValue24hAgo > 0) { const dailyPnl = total - totalValue24hAgo; const dailyPnlPercent = (dailyPnl / totalValue24hAgo) * 100; const sign = dailyPnl >= 0 ? '+' : ''; dailyPnlText = ` ▫️ *الأداء اليومي (24س):* ${dailyPnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${sign}${formatNumber(dailyPnl)}\` (\`${sign}${formatNumber(dailyPnlPercent)}%\`)\n`; } const pnl = capital > 0 ? total - capital : 0; const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0; const pnlSign = pnl >= 0 ? '+' : ''; const usdtValue = (assets.find(a => a.asset === 'USDT') || { value: 0 }).value; const cashPercent = total > 0 ? (usdtValue / total) * 100 : 0; const liquidityText = ` ▫️ *السيولة:* 💵 نقدي ${formatNumber(cashPercent, 1)}% / 📈 مستثمر ${formatNumber(100 - cashPercent, 1)}%`; let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n`; msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`; msg += `━━━━━━━━━━━━━━━━━━━\n*نظرة عامة على الأداء:*\n`; msg += ` ▫️ *القيمة الإجمالية:* \`$${formatNumber(total)}\`\n`; msg += ` ▫️ *رأس المال:* \`$${formatNumber(capital)}\`\n`; msg += ` ▫️ *إجمالي الربح غير المحقق:* ${pnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${pnlSign}${formatNumber(pnl)}\` (\`${pnlSign}${formatNumber(pnlPercent)}%\`)\n`; msg += dailyPnlText + liquidityText + `\n━━━━━━━━━━━━━━━━━━━━\n*مكونات المحفظة:*\n`; assets.forEach((a, index) => { const percent = total > 0 ? (a.value / total) * 100 : 0; msg += "\n"; if (a.asset === "USDT") { msg += `*USDT* (الرصيد النقدي) 💵\n*القيمة:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)`; } else { const change24hPercent = (a.change24h || 0) * 100; const changeEmoji = change24hPercent >= 0 ? '🟢⬆️' : '🔴⬇️'; const changeSign = change24hPercent >= 0 ? '+' : ''; msg += `╭─ *${a.asset}/USDT*\n`; msg += `├─ *القيمة الحالية:* \`$${formatNumber(a.value)}\` (*الوزن:* \`${formatNumber(percent)}%\`)\n`; msg += `├─ *سعر السوق:* \`$${formatNumber(a.price, 4)}\`\n`; msg += `├─ *الأداء اليومي:* ${changeEmoji} \`${changeSign}${formatNumber(change24hPercent)}%\`\n`; const position = positions[a.asset]; if (position?.avgBuyPrice > 0) { const totalCost = position.avgBuyPrice * a.amount; const assetPnl = a.value - totalCost; const assetPnlPercent = totalCost > 0 ? (assetPnl / totalCost) * 100 : 0; msg += `├─ *متوسط الشراء:* \`$${formatNumber(position.avgBuyPrice, 4)}\`\n`; msg += `╰─ *ربح/خسارة غير محقق:* ${assetPnl >= 0 ? '🟢' : '🔴'} \`${assetPnl >= 0 ? '+' : ''}${formatNumber(assetPnl)}\` (\`${assetPnl >= 0 ? '+' : ''}${formatNumber(assetPnlPercent)}%\`)`; } else { msg += `╰─ *متوسط الشراء:* \`غير مسجل\``; } } if (index < assets.length - 1) msg += `\n━━━━━━━━━━━━━━━━━━━━`; }); return msg; }
async function formatAdvancedMarketAnalysis() { const prices = await getMarketPrices(); if (!prices) return "❌ فشل جلب بيانات السوق."; const marketData = Object.entries(prices).map(([instId, data]) => ({ instId, ...data })).filter(d => d.volCcy24h > 10000 && d.change24h !== undefined); marketData.sort((a, b) => b.change24h - a.change24h); const topGainers = marketData.slice(0, 5); const topLosers = marketData.slice(-5).reverse(); marketData.sort((a, b) => b.volCcy24h - a.volCcy24h); const highVolume = marketData.slice(0, 5); let msg = `🚀 *تحليل السوق المتقدم* | ${new Date().toLocaleDateString("ar-EG")}\n━━━━━━━━━━━━━━━━━━━\n\n`; msg += "📈 *أكبر الرابحين (24س):*\n" + topGainers.map(c => `  - \`${c.instId}\`: \`+${formatNumber(c.change24h * 100)}%\``).join('\n') + "\n\n"; msg += "📉 *أكبر الخاسرين (24س):*\n" + topLosers.map(c => `  - \`${c.instId}\`: \`${formatNumber(c.change24h * 100)}%\``).join('\n') + "\n\n"; msg += "📊 *الأعلى في حجم التداول:*\n" + highVolume.map(c => `  - \`${c.instId}\`: \`${(c.volCcy24h / 1e6).toFixed(2)}M\` USDT`).join('\n') + "\n\n"; msg += "💡 *توصية:* راقب الأصول ذات حجم التداول المرتفع، فهي غالبًا ما تقود اتجاه السوق."; return msg; }
async function formatQuickStats(assets, total, capital) { const pnl = capital > 0 ? total - capital : 0; const pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0; const statusEmoji = pnl >= 0 ? '🟢' : '🔴'; const statusText = pnl >= 0 ? 'ربح' : 'خسارة'; let msg = "⚡ *إحصائيات سريعة*\n\n"; msg += `💎 *إجمالي الأصول:* \`${assets.filter(a => a.asset !== 'USDT').length}\`\n`; msg += `💰 *القيمة الحالية:* \`$${formatNumber(total)}\`\n`; msg += `📈 *نسبة الربح/الخسارة:* \`${formatNumber(pnlPercent)}%\`\n`; msg += `🎯 *الحالة:* ${statusEmoji} ${statusText}\n\n`; msg += `⏰ *آخر تحديث:* ${new Date().toLocaleTimeString("ar-EG")}`; return msg; }
async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) { if (!asset || price === undefined || price === null || isNaN(price)) return { analysisResult: null }; const positions = await loadPositions(); let position = positions[asset]; let analysisResult = { type: 'none', data: {} }; if (amountChange > 0) { if (!position) { positions[asset] = { totalAmountBought: amountChange, totalCost: amountChange * price, avgBuyPrice: price, openDate: new Date().toISOString(), totalAmountSold: 0, realizedValue: 0, highestPrice: price, lowestPrice: price }; } else { position.totalAmountBought += amountChange; position.totalCost += (amountChange * price); position.avgBuyPrice = position.totalCost / position.totalAmountBought; } analysisResult.type = 'buy'; } else if (amountChange < 0 && position) { position.realizedValue += (Math.abs(amountChange) * price); position.totalAmountSold += Math.abs(amountChange); if (newTotalAmount * price < 1) { const finalPnl = position.realizedValue - position.totalCost; const finalPnlPercent = position.totalCost > 0 ? (finalPnl / position.totalCost) * 100 : 0; const closeDate = new Date(); const openDate = new Date(position.openDate); const durationDays = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24); const avgSellPrice = position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0; const closeReportData = { asset, pnl: finalPnl, pnlPercent: finalPnlPercent, durationDays, avgBuyPrice: position.avgBuyPrice, avgSellPrice, highestPrice: position.highestPrice, lowestPrice: position.lowestPrice }; await saveClosedTrade(closeReportData); analysisResult = { type: 'close', data: closeReportData }; delete positions[asset]; } else { analysisResult.type = 'sell'; } } await savePositions(positions); analysisResult.data.position = positions[asset] || position; return { analysisResult }; }
async function monitorBalanceChanges() { try { await sendDebugMessage("Checking balance changes..."); const previousState = await loadBalanceState(); const previousBalances = previousState.balances || {}; const oldTotalValue = previousState.totalValue || 0; const oldUsdtValue = previousBalances['USDT'] || 0; const currentBalance = await getBalanceForComparison(); if (!currentBalance) return; const prices = await getMarketPrices(); if (!prices) return; const { assets: newAssets, total: newTotalValue, usdtValue: newUsdtValue } = await getPortfolio(prices); if (newTotalValue === undefined) return; if (Object.keys(previousBalances).length === 0) { await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue }); return; } const allAssets = new Set([...Object.keys(previousBalances), ...Object.keys(currentBalance)]); let stateNeedsUpdate = false; for (const asset of allAssets) { if (asset === 'USDT') continue; const prevAmount = previousBalances[asset] || 0; const currAmount = currentBalance[asset] || 0; const difference = currAmount - prevAmount; const priceData = prices[`${asset}-USDT`]; if (!priceData || !priceData.price || isNaN(priceData.price) || Math.abs(difference * priceData.price) < 1) continue; stateNeedsUpdate = true; const { analysisResult } = await updatePositionAndAnalyze(asset, difference, priceData.price, currAmount); if (analysisResult.type === 'none') continue; const tradeValue = Math.abs(difference) * priceData.price; const newAssetData = newAssets.find(a => a.asset === asset); const newAssetValue = newAssetData ? newAssetData.value : 0; const newAssetWeight = newTotalValue > 0 ? (newAssetValue / newTotalValue) * 100 : 0; const newCashPercent = newTotalValue > 0 ? (newUsdtValue / newTotalValue) * 100 : 0; const baseDetails = { asset, price: priceData.price, amountChange: difference, tradeValue, oldTotalValue, newAssetWeight, newUsdtValue, newCashPercent, oldUsdtValue, position: analysisResult.data.position }; const settings = await loadSettings(); let privateMessage, publicMessage; if (analysisResult.type === 'buy') { privateMessage = formatPrivateBuy(baseDetails); publicMessage = formatPublicBuy(baseDetails); await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" }); if (settings.autoPostToChannel) { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" }); } } else if (analysisResult.type === 'sell') { privateMessage = formatPrivateSell(baseDetails); publicMessage = formatPublicSell(baseDetails); await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" }); if (settings.autoPostToChannel) { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" }); } } else if (analysisResult.type === 'close') { privateMessage = formatPrivateCloseReport(analysisResult.data); publicMessage = formatPublicClose(analysisResult.data); if (settings.autoPostToChannel) { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" }); await bot.api.sendMessage(AUTHORIZED_USER_ID, privateMessage, { parse_mode: "Markdown" }); } else { const confirmationKeyboard = new InlineKeyboard().text("✅ نعم، انشر التقرير", "publish_report").text("❌ لا، تجاهل", "ignore_report"); const hiddenMarker = `\n<REPORT>${JSON.stringify(publicMessage)}</REPORT>`; const confirmationMessage = `*تم إغلاق المركز بنجاح. هل تود نشر الملخص في القناة؟*\n\n${privateMessage}${hiddenMarker}`; await bot.api.sendMessage(AUTHORIZED_USER_ID, confirmationMessage, { parse_mode: "Markdown", reply_markup: confirmationKeyboard }); } } } if (stateNeedsUpdate) { await saveBalanceState({ balances: currentBalance, totalValue: newTotalValue }); await sendDebugMessage("State updated after balance change."); } } catch (e) { console.error("CRITICAL ERROR in monitorBalanceChanges:", e); } }
async function trackPositionHighLow() { try { const positions = await loadPositions(); if (Object.keys(positions).length === 0) return; const prices = await getMarketPrices(); if (!prices) return; let positionsUpdated = false; for (const symbol in positions) { const position = positions[symbol]; const currentPrice = prices[`${symbol}-USDT`]?.price; if (currentPrice) { if (!position.highestPrice || currentPrice > position.highestPrice) { position.highestPrice = currentPrice; positionsUpdated = true; } if (!position.lowestPrice || currentPrice < position.lowestPrice) { position.lowestPrice = currentPrice; positionsUpdated = true; } } } if (positionsUpdated) { await savePositions(positions); await sendDebugMessage("Updated position high/low prices."); } } catch(e) { console.error("CRITICAL ERROR in trackPositionHighLow:", e); } }
async function checkPriceAlerts() { try { const alerts = await loadAlerts(); if (alerts.length === 0) return; const prices = await getMarketPrices(); if (!prices) return; const remainingAlerts = []; let triggered = false; for (const alert of alerts) { const currentPrice = prices[alert.instId]?.price; if (currentPrice === undefined) { remainingAlerts.push(alert); continue; } if ((alert.condition === '>' && currentPrice > alert.price) || (alert.condition === '<' && currentPrice < alert.price)) { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🚨 *تنبيه سعر!* \`${alert.instId}\`\nالشرط: ${alert.condition} ${alert.price}\nالسعر الحالي: \`${currentPrice}\``, { parse_mode: "Markdown" }); triggered = true; } else { remainingAlerts.push(alert); } } if (triggered) await saveAlerts(remainingAlerts); } catch (error) { console.error("Error in checkPriceAlerts:", error); } }
async function checkPriceMovements() { try { await sendDebugMessage("Checking price movements..."); const alertSettings = await loadAlertSettings(); const priceTracker = await loadPriceTracker(); const prices = await getMarketPrices(); if (!prices) return; const { assets, total: currentTotalValue, error } = await getPortfolio(prices); if (error || currentTotalValue === undefined) return; if (priceTracker.totalPortfolioValue === 0) { priceTracker.totalPortfolioValue = currentTotalValue; assets.forEach(a => { if (a.price) priceTracker.assets[a.asset] = a.price; }); await savePriceTracker(priceTracker); return; } let trackerUpdated = false; for (const asset of assets) { if (asset.asset === 'USDT' || !asset.price) continue; const lastPrice = priceTracker.assets[asset.asset]; if (lastPrice) { const changePercent = ((asset.price - lastPrice) / lastPrice) * 100; const threshold = alertSettings.overrides[asset.asset] || alertSettings.global; if (Math.abs(changePercent) >= threshold) { const movementText = changePercent > 0 ? 'صعود' : 'هبوط'; const message = `📈 *تنبيه حركة سعر لأصل!* \`${asset.asset}\`\n*الحركة:* ${movementText} بنسبة \`${formatNumber(changePercent)}%\`\n*السعر الحالي:* \`$${formatNumber(asset.price, 4)}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } else { priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } if (trackerUpdated) await savePriceTracker(priceTracker); } catch (e) { console.error("CRITICAL ERROR in checkPriceMovements:", e); } }
async function runDailyJobs() { try { const settings = await loadSettings(); if (!settings.dailySummary) return; const prices = await getMarketPrices(); if (!prices) return; const { total } = await getPortfolio(prices); if (total === undefined) return; const history = await loadHistory(); const date = new Date().toISOString().slice(0, 10); const todayIndex = history.findIndex(h => h.date === date); if (todayIndex > -1) history[todayIndex].total = total; else history.push({ date, total }); if (history.length > 35) history.shift(); await saveHistory(history); console.log(`[Daily Summary Recorded]: ${date} - $${formatNumber(total)}`); } catch (e) { console.error("CRITICAL ERROR in runDailyJobs:", e); } }
async function runHourlyJobs() { try { const prices = await getMarketPrices(); if (!prices) return; const { total } = await getPortfolio(prices); if (total === undefined) return; const history = await loadHourlyHistory(); const hourLabel = new Date().toISOString().slice(0, 13); const existingIndex = history.findIndex(h => h.label === hourLabel); if (existingIndex > -1) history[existingIndex].total = total; else history.push({ label: hourLabel, total }); if (history.length > 72) history.splice(0, history.length - 72); await saveHourlyHistory(history); } catch (e) { console.error("Error in hourly jobs:", e); } }
async function monitorVirtualTrades() { const activeTrades = await getActiveVirtualTrades(); if (!activeTrades || activeTrades.length === 0) return; const prices = await getMarketPrices(); if (!prices) { console.error("Could not fetch prices for monitoring virtual trades."); return; } for (const trade of activeTrades) { const priceData = prices[trade.instId]; if (priceData && priceData.price) { const currentPrice = priceData.price; let status = 'active'; let finalPrice = null; if (trade.stopLoss && currentPrice <= trade.stopLoss) { status = 'closed_sl'; finalPrice = trade.stopLoss; } else if (trade.takeProfit && currentPrice >= trade.takeProfit) { status = 'closed_tp'; finalPrice = trade.takeProfit; } if (status !== 'active') { await updateVirtualTradeStatus(trade._id, status, finalPrice); await bot.api.sendMessage(AUTHORIZED_USER_ID, `🔔 *Virtual Trade Update:*\n- Asset: ${trade.instId}\n- Status: ${status}\n- Closed at: $${finalPrice}`, { parse_mode: 'Markdown' }); } } } }

// =================================================================
// SECTION 5: BOT UI AND COMMAND HANDLERS
// =================================================================

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("🚀 تحليل السوق").text("💡 توصية افتراضية").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").row()
    .resized();

bot.use(async (ctx, next) => {
    if (String(ctx.from?.id) === String(AUTHORIZED_USER_ID)) {
        if (waitingState && ctx.message?.text) {
            const state = waitingState;
            const text = ctx.message.text;
            waitingState = null;

            try {
                switch (state) {
                    case 'capital':
                        const amount = parseFloat(text);
                        if (!isNaN(amount) && amount > 0) {
                            await saveCapital(amount);
                            await ctx.reply(`✅ تم تحديث رأس المال إلى: $${formatNumber(amount)}`);
                        } else {
                            await ctx.reply("❌ مبلغ غير صالح.");
                        }
                        break;
                    case 'alert':
                         const parts = text.split(' ');
                         if (parts.length !== 3) return await ctx.reply("❌ صيغة غير صحيحة. استخدم: `SYMBOL > PRICE`");
                         const [symbol, condition, price] = parts;
                         if (!['<', '>'].includes(condition) || isNaN(parseFloat(price))) {
                             return await ctx.reply("❌ صيغة غير صحيحة. استخدم `>` للصعود أو `<` للهبوط وسعر صحيح.");
                         }
                         const instId = `${symbol.toUpperCase()}-USDT`;
                         const alerts = await loadAlerts();
                         alerts.push({ instId, condition, price: parseFloat(price) });
                         await saveAlerts(alerts);
                         await ctx.reply(`✅ تم إضافة تنبيه جديد: ${instId} ${condition} $${price}`);
                         break;
                     case 'instrument_info':
                         const instInfo = await getInstrumentDetails(text.toUpperCase() + '-USDT');
                         if(instInfo.error) return await ctx.reply(instInfo.error);
                         const tech = await getTechnicalAnalysis(text.toUpperCase() + '-USDT');
                         let infoMsg = `*🔍 معلومات ${text.toUpperCase()}:*\n`;
                         infoMsg += `  - السعر الحالي: \`$${formatNumber(instInfo.price, 4)}\`\n`;
                         infoMsg += `  - أعلى/أدنى (24س): \`$${formatNumber(instInfo.high24h, 4)}\` / \`$${formatNumber(instInfo.low24h, 4)}\`\n`;
                         infoMsg += `  - حجم التداول (24س): \`${formatNumber(instInfo.vol24h / 1e6, 2)}M\`\n`;
                         if(!tech.error){
                            infoMsg += `  - مؤشر القوة النسبية (RSI): \`${formatNumber(tech.rsi)}\`\n`;
                            infoMsg += `  - متوسط 20/50 يوم: \`$${formatNumber(tech.sma20, 4)}\` / \`$${formatNumber(tech.sma50, 4)}\``;
                         }
                         await ctx.reply(infoMsg, { parse_mode: "Markdown" });
                         break;
                }
            } catch (e) {
                console.error(`Error in waitingState handler ('${state}'):`, e);
                await ctx.reply("حدث خطأ أثناء معالجة طلبك.");
            }

        } else {
            await next();
        }
    } else if (ctx.from) {
        await ctx.reply("عذراً، هذا البوت خاص.");
    }
});

bot.command("start", (ctx) => {
    ctx.reply("أهلاً بك في بوت التحليل المتقدم!", { reply_markup: mainKeyboard });
});

bot.hears("📊 عرض المحفظة", async (ctx) => {
    const loadingMsg = await ctx.reply("⏳ جاري إعداد التقرير...");
    try {
        const prices = await getMarketPrices();
        if (!prices) {
            return bot.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, "❌ فشل جلب أسعار السوق.");
        }
        const capital = await loadCapital();
        const portfolio = await getPortfolio(prices);
        if (portfolio.error) {
            return bot.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, `❌ ${portfolio.error}`);
        }
        const msg = await formatPortfolioMsg(portfolio.assets, portfolio.total, capital);
        await bot.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, msg, { parse_mode: "Markdown" });
    } catch(e) {
         console.error("Error in 'عرض المحفظة' handler:", e);
         await bot.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, "❌ حدث خطأ داخلي أثناء عرض المحفظة.");
    }
});

bot.hears("⚙️ الإعدادات", async (ctx) => {
    try {
        const settings = await loadSettings();
        const settingsMenu = new InlineKeyboard()
            .text(`النشر التلقائي للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost").row()
            .text(`الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
            .text("💰 تعيين رأس المال", "set_capital")
            .text("📊 إدارة تنبيهات الحركة", "manage_movement_alerts").row()
            .text(`وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug")
            .text("🔥 حذف جميع البيانات", "delete_all_data").row()
            .text("🔙 إغلاق", "close_menu");

        await ctx.reply("⚙️ *لوحة التحكم والإعدادات الرئيسية*", {
            parse_mode: "Markdown",
            reply_markup: settingsMenu
        });
    } catch (e) {
        console.error("Error in 'الإعدادات' handler:", e);
        await ctx.reply("حدث خطأ في عرض الإعدادات.");
    }
});

bot.on("callback_query:data", async (ctx) => {
    const query = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();
    let settings = await loadSettings();

    try {
        switch (query) {
            case 'toggle_autopost':
                settings.autoPostToChannel = !settings.autoPostToChannel;
                break;
            case 'toggle_summary':
                settings.dailySummary = !settings.dailySummary;
                break;
            case 'toggle_debug':
                settings.debugMode = !settings.debugMode;
                break;
            case 'set_capital':
                waitingState = 'capital';
                await ctx.reply("الرجاء إرسال مبلغ رأس المال الجديد.");
                await ctx.deleteMessage();
                return;
            case 'close_menu':
                await ctx.deleteMessage();
                return;
            case 'delete_all_data':
                 await Promise.all([
                    saveConfig("capital", { value: 0 }),
                    saveConfig("positions", {}),
                    saveConfig("dailyHistory", []),
                    saveConfig("hourlyHistory", []),
                    saveConfig("priceAlerts", [])
                 ]);
                 await ctx.reply("✅ تم حذف جميع بيانات التداول والتاريخ المحفوظة.");
                 await ctx.deleteMessage();
                 return;
            case 'publish_report':
                const originalMessage = ctx.callbackQuery.message.text;
                const reportMarker = '<REPORT>';
                const reportEndMarker = '</REPORT>';
                const startIndex = originalMessage.indexOf(reportMarker);
                if(startIndex !== -1){
                    const reportJson = originalMessage.substring(startIndex + reportMarker.length, originalMessage.indexOf(reportEndMarker));
                    try {
                        const publicMessage = JSON.parse(reportJson);
                        await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicMessage, { parse_mode: "Markdown" });
                        await ctx.editMessageText(originalMessage.split(reportMarker)[0] + "\n\n*✅ تم النشر بنجاح.*", {parse_mode: "Markdown", reply_markup: undefined});
                    } catch (e) { console.error("Failed to publish report:", e); }
                }
                return;
            case 'ignore_report':
                const originalMsg = ctx.callbackQuery.message.text;
                const marker = '<REPORT>';
                await ctx.editMessageText(originalMsg.split(marker)[0] + "\n\n*👍 تم التجاهل.*", {parse_mode: "Markdown", reply_markup: undefined});
                return;
            
        }
    
        await saveSettings(settings);
    
        const updatedMenu = new InlineKeyboard()
            .text(`النشر التلقائي للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost").row()
            .text(`الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
            .text("💰 تعيين رأس المال", "set_capital")
            .text("📊 إدارة تنبيهات الحركة", "manage_movement_alerts").row()
            .text(`وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug")
            .text("🔥 حذف جميع البيانات", "delete_all_data").row()
            .text("🔙 إغلاق", "close_menu");
    
        await ctx.editMessageReplyMarkup({ reply_markup: updatedMenu });

    } catch (e) {
        console.error("Error in callback_query handler:", e);
    }
});

bot.hears("🚀 تحليل السوق", async (ctx) => {
    try {
        const msg = await formatAdvancedMarketAnalysis();
        await ctx.reply(msg, {parse_mode: "Markdown"});
    } catch (e) {
        console.error("Error in 'تحليل السوق' handler:", e);
        await ctx.reply("حدث خطأ في تحليل السوق.");
    }
});

bot.hears("🔔 ضبط تنبيه", (ctx) => {
    waitingState = 'alert';
    ctx.reply("✍️ لإضافة تنبيه، أرسل رسالة بالصيغة التالية:\n`BTC > 70000`\nأو\n`ETH < 3500`", {parse_mode: "Markdown"});
});

bot.hears("ℹ️ معلومات عملة", (ctx) => {
    waitingState = 'instrument_info';
    ctx.reply("يرجى إرسال رمز العملة (مثال: BTC)");
});

bot.hears("📈 أداء المحفظة", async (ctx) => {
    try {
        await ctx.reply("📊 جاري حساب أداء المحفظة...");
        const history = await loadHistory();
        const stats = calculatePerformanceStats(history);
        if (!stats) return ctx.reply("لا توجد بيانات كافية.");

        const chartUrl = createChartUrl(history, 'Last 30 Days', stats.pnl);
        const pnlSign = stats.pnl >= 0 ? '+' : '';
        let msg = `*--- تقرير الأداء ---*\n`;
        msg += `قيمة البداية: \`$${formatNumber(stats.startValue)}\`\n`;
        msg += `القيمة النهائية: \`$${formatNumber(stats.endValue)}\`\n`;
        msg += `صافي الربح/الخسارة: \`${pnlSign}$${formatNumber(stats.pnl)}\`\n`;
        msg += `نسبة التغيير: \`${pnlSign}${formatNumber(stats.pnlPercent)}%\``;

        if (chartUrl) {
            await ctx.replyWithPhoto(chartUrl, { caption: msg, parse_mode: "Markdown" });
        } else {
            await ctx.reply(msg, { parse_mode: "Markdown" });
        }
    } catch (e) {
        console.error("Error in 'أداء المحفظة' handler:", e);
        await ctx.reply("حدث خطأ في عرض الأداء.");
    }
});


// =================================================================
// SECTION 6: VERCEL SERVER HANDLER (The Correct Way)
// =================================================================
const app = express();
app.use(express.json());

// Initialize DB connection once.
connectDB();

// The official, recommended way to handle webhooks with express
const webhookHandler = webhookCallback(bot, "express");

app.post("/api/bot", webhookHandler);

app.get("/api/cron", async (req, res) => {
    // Secure the cron endpoint
    if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).send('Unauthorized');
    }
    try {
        console.log("Cron job triggered...");
        // Run all background jobs
        await Promise.all([
            monitorBalanceChanges(),
            trackPositionHighLow(),
            checkPriceAlerts(),
            checkPriceMovements(),
            monitorVirtualTrades(),
            runHourlyJobs(),
            runDailyJobs()
        ]);
        console.log("Cron jobs finished successfully.");
        res.status(200).send("Cron jobs executed successfully.");
    } catch (e) {
        console.error("CRITICAL ERROR during cron execution:", e);
        res.status(500).send("Cron jobs failed.");
    }
});

app.get("/", (req, res) => {
    res.status(200).send("OKX Advanced Analytics Bot v119 is alive.");
});

// General error handler for express
app.use((err, req, res, next) => {
    console.error("--- EXPRESS SERVER ERROR ---", err);
    if (!res.headersSent) {
        res.status(500).send("An unexpected server error occurred.");
    }
});

// Export the app for Vercel's serverless environment
module.exports = app;
