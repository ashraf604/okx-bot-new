// =================================================================
// OKX Advanced Analytics Bot - v88 (Stable Base v70 + Virtual Trades)
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
        const avgDuration = totalDuration / history.length;
        return { realizedPnl, tradeCount: history.length, winningTrades, losingTrades, avgDuration };
    } catch (e) {
        console.error(`Error fetching historical performance for ${asset}:`, e);
        return null;
    }
}

// --- NEW: Virtual Trade DB Functions ---
async function saveVirtualTrade(tradeData) {
    try {
        const tradeWithId = { ...tradeData, _id: new crypto.randomBytes(16).toString("hex") };
        await getCollection("virtualTrades").insertOne(tradeWithId);
        return tradeWithId;
    } catch (e) {
        console.error("Error saving virtual trade:", e);
    }
}

async function getActiveVirtualTrades() {
    try {
        return await getCollection("virtualTrades").find({ status: 'active' }).toArray();
    } catch (e) {
        console.error("Error fetching active virtual trades:", e);
        return [];
    }
}

async function updateVirtualTradeStatus(tradeId, status, finalPrice) {
    try {
        await getCollection("virtualTrades").updateOne({ _id: tradeId }, { $set: { status: status, closePrice: finalPrice, closedAt: new Date() } });
    } catch (e) {
        console.error(`Error updating virtual trade ${tradeId}:`, e);
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
            const lastPrice = parseFloat(t.last);
            const openPrice = parseFloat(t.open24h);
            let change24h = 0;
            if (openPrice > 0) change24h = (lastPrice - openPrice) / openPrice;
            prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h: change24h };
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
            datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: chartBgColor, borderColor: chartColor, tension: 0.1 }]
        },
        options: { title: { display: true, text: `أداء المحفظة - ${periodLabel}` } }
    };
    return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`;
}

// =================================================================
// SECTION 3: BACKGROUND JOBS
// =================================================================

async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) {
    if (!asset || price === undefined || price === null || isNaN(price)) return null;
    const positions = await loadPositions();
    const position = positions[asset];
    const tradeValue = Math.abs(amountChange) * price;
    let report = null;

    if (amountChange > 0) {
        if (!position) {
            positions[asset] = { totalAmountBought: amountChange, totalCost: tradeValue, avgBuyPrice: price, openDate: new Date().toISOString(), totalAmountSold: 0, realizedValue: 0 };
        } else {
            position.totalAmountBought += amountChange;
            position.totalCost += tradeValue;
            position.avgBuyPrice = position.totalCost / position.totalAmountBought;
        }
    } else if (amountChange < 0 && position) {
        position.realizedValue += tradeValue;
        position.totalAmountSold += Math.abs(amountChange);
        if (newTotalAmount * price < 1) {
            const finalPnl = position.realizedValue - position.totalCost;
            const finalPnlPercent = position.totalCost > 0 ? (finalPnl / position.totalCost) * 100 : 0;
            report = `✅ *تقرير إغلاق مركز: ${asset}*\n\n` + `*النتيجة النهائية للصفقة:* ${finalPnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${finalPnl >= 0 ? '+' : ''}${formatNumber(finalPnl)}\` (\`${finalPnl >= 0 ? '+' : ''}${formatNumber(finalPnlPercent)}%\`)`;
            
            const closeDate = new Date();
            const openDate = new Date(position.openDate);
            const durationDays = (closeDate.getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24);
            const avgSellPrice = position.totalAmountSold > 0 ? position.realizedValue / position.totalAmountSold : 0;
            await saveClosedTrade({ asset, pnl: finalPnl, pnlPercent, openDate, closeDate, durationDays, avgBuyPrice: position.avgBuyPrice, avgSellPrice });
            
            delete positions[asset];
        }
    }
    await savePositions(positions);
    return report;
}

async function monitorBalanceChanges() {
    try {
        const previousState = await loadBalanceState();
        const previousBalances = previousState.balances || {};
        const currentBalance = await getBalanceForComparison();
        if (!currentBalance) return;
        const prices = await getMarketPrices();
        if (!prices) return;
        
        const { total: newTotalValue } = await getPortfolio(prices);
        if (newTotalValue === undefined) return;

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
            if (currentPrice === undefined) { 
                remainingAlerts.push(alert); 
                continue; 
            }
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

// --- NEW: Background job for virtual trades ---
async function monitorVirtualTrades() {
    const activeTrades = await getActiveVirtualTrades();
    if (activeTrades.length === 0) return;

    const prices = await getMarketPrices();
    if (!prices) return;

    for (const trade of activeTrades) {
        const currentPrice = prices[trade.instId]?.price;
        if (!currentPrice) continue;

        let finalStatus = null;
        let pnl = 0;
        let finalPrice = 0;

        if (currentPrice >= trade.targetPrice) {
            finalPrice = trade.targetPrice;
            pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
            finalStatus = 'completed';
            const profitPercent = (pnl / trade.virtualAmount) * 100;
            const msg = `🎯 *الهدف تحقق (توصية افتراضية)!* ✅\n\n` +
                        `*العملة:* \`${trade.instId}\`\n` +
                        `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                        `*سعر الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\`\n\n` +
                        `💰 *الربح المحقق:* \`+$${formatNumber(pnl)}\` (\`+${formatNumber(profitPercent)}%\`)`;
            await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
        }
        else if (currentPrice <= trade.stopLossPrice) {
            finalPrice = trade.stopLossPrice;
            pnl = (finalPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
            finalStatus = 'stopped';
            const lossPercent = (pnl / trade.virtualAmount) * 100;
            const msg = `🛑 *تم تفعيل وقف الخسارة (توصية افتراضية)!* 🔻\n\n` +
                        `*العملة:* \`${trade.instId}\`\n` +
                        `*سعر الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\`\n` +
                        `*سعر الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`\n\n` +
                        `💸 *الخسارة:* \`$${formatNumber(pnl)}\` (\`${formatNumber(lossPercent)}%\`)`;
            await bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
        }

        if (finalStatus) {
            await updateVirtualTradeStatus(trade._id, finalStatus, finalPrice);
        }
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
        if (existingIndex > -1) {
            history[existingIndex].total = total;
        } else {
            history.push({ label: hourLabel, total: total });
        }
        if (history.length > 72) {
            history.splice(0, history.length - 72);
        }
        await saveHourlyHistory(history);
    } catch (e) {
        console.error("Error in hourly jobs:", e);
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
    } catch (e) {
        console.error("CRITICAL ERROR in runDailyJobs:", e);
    }
}

// =================================================================
// SECTION 4: BOT SETUP, KEYBOARDS, AND HANDLERS
// =================================================================

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("💡 توصية افتراضية").text("ℹ️ معلومات عملة").row()
    .text("🔔 ضبط تنبيه").text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();

const virtualTradeKeyboard = new InlineKeyboard()
    .text("➕ إضافة توصية جديدة", "add_virtual_trade").row()
    .text("📈 متابعة التوصيات الحية", "track_virtual_trades");

async function sendSettingsMenu(ctx) {
    const settings = await loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital")
        .text("💼 عرض المراكز المفتوحة", "view_positions").row()
        .text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts") // This button was missing
        .text("🗑️ حذف تنبيه سعر", "delete_alert").row()
        .text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary")
        .text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").row()
        .text("🔥 حذف جميع البيانات 🔥", "delete_all_data");
    const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*";
    try {
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
    } catch {
        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
    }
}

// This function was missing
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
});

bot.command("start", (ctx) => {
    const welcomeMessage = `🤖 *أهلاً بك في بوت OKX التحليلي المتكامل، مساعدك الذكي لإدارة وتحليل محفظتك الاستثمارية.*\n\n` +
        `*الإصدار: v88 - Stable & Complete*\n\n` +
        `أنا هنا لمساعدتك على:\n` +
        `- 📊 تتبع أداء محفظتك وصفقاتك الحقيقية.\n` +
        `- 💡 متابعة توصيات افتراضية وتنبيهك بالنتائج.\n` +
        `- 🔔 ضبط تنبيهات ذكية للأسعار.\n\n` +
        `*اضغط على الأزرار أدناه للبدء!*`;
    ctx.reply(welcomeMessage, { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", sendSettingsMenu);

bot.command("pnl", async (ctx) => {
    const args = ctx.match.trim().split(/\s+/);
    if (args.length !== 3 || args[0] === '') {
        return await ctx.reply(`❌ *صيغة غير صحيحة.*\n*مثال:* \`/pnl <سعر الشراء> <سعر البيع> <الكمية>\``, { parse_mode: "Markdown" });
    }
    const [buyPrice, sellPrice, quantity] = args.map(parseFloat);
    if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) {
        return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم هي أرقام موجبة.");
    }
    const investment = buyPrice * quantity;
    const saleValue = sellPrice * quantity;
    const pnl = saleValue - investment;
    const pnlPercent = (investment > 0) ? (pnl / investment) * 100 : 0;
    const status = pnl >= 0 ? "ربح ✅" : "خسارة 🔻";
    const sign = pnl >= 0 ? '+' : '';
    const msg = `🧮 *نتيجة حساب الربح والخسارة*\n\n` +
                `*صافي الربح/الخسارة:* \`${sign}${formatNumber(pnl)}\` (\`${sign}${formatNumber(pnlPercent)}%\`)\n` +
                `**الحالة النهائية: ${status}**`;
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery();
    const data = ctx.callbackQuery.data;

    if (data.startsWith("chart_")) {
        const period = data.split('_')[1];
        await ctx.editMessageText("⏳ جاري إنشاء تقرير الأداء...");
        let history, periodLabel, periodData;
        if (period === '24h') { history = await loadHourlyHistory(); periodLabel = "آخر 24 ساعة"; periodData = history.slice(-24).map(h => ({label: new Date(h.label).getHours() + ':00', total: h.total })); }
        else if (period === '7d') { history = await loadHistory(); periodLabel = "آخر 7 أيام"; periodData = history.slice(-7).map(h => ({ label: h.date.slice(5), total: h.total })); }
        else if (period === '30d') { history = await loadHistory(); periodLabel = "آخر 30 يومًا"; periodData = history.slice(-30).map(h => ({ label: h.date.slice(5), total: h.total })); }
        if (!periodData || periodData.length < 2) return await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة.");
        const stats = calculatePerformanceStats(periodData);
        if (!stats) return await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة.");
        const chartUrl = createChartUrl(periodData, periodLabel, stats.pnl);
        const pnlSign = stats.pnl >= 0 ? '+' : '';
        const caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n\n` +
                      `📈 *النتيجة:* ${stats.pnl >= 0 ? '🟢⬆️' : '🔴⬇️'} \`${pnlSign}${formatNumber(stats.pnl)}\` (\`${pnlSign}${formatNumber(stats.pnlPercent)}%\`)\n` +
                      `*التغير الصافي: من \`$${formatNumber(stats.startValue)}\` إلى \`$${formatNumber(stats.endValue)}\`*\n\n` +
                      `📝 *ملخص إحصائيات الفترة:*\n` +
                      ` ▫️ *أعلى قيمة:* \`$${formatNumber(stats.maxValue)}\`\n` +
                      ` ▫️ *أدنى قيمة:* \`$${formatNumber(stats.minValue)}\`\n` +
                      ` ▫️ *متوسط القيمة:* \`$${formatNumber(stats.avgValue)}\`\n\n` +
                      `*التقرير تم إنشاؤه في: ${new Date().toLocaleDateString("en-GB").replace(/\//g, '.')}*`;
        try { await ctx.replyWithPhoto(chartUrl, { caption: caption, parse_mode: "Markdown" }); await ctx.deleteMessage(); } 
        catch (e) { console.error("Chart send failed:", e); await ctx.editMessageText("❌ فشل إنشاء الرسم البياني."); }
        return;
    }
    
    switch(data) {
        case "add_virtual_trade":
            waitingState = 'add_virtual_trade';
            await ctx.editMessageText(
                "✍️ *لإضافة توصية افتراضية، أرسل التفاصيل في 5 أسطر منفصلة:*\n\n" +
                "`BTC-USDT`\n" +
                "`65000` (سعر الدخول)\n" +
                "`70000` (سعر الهدف)\n" +
                "`62000` (وقف الخسارة)\n" +
                "`1000` (المبلغ الافتراضي)\n\n" +
                "**ملاحظة:** *لا تكتب كلمات مثل 'دخول' أو 'هدف'، فقط الأرقام والرمز.*"
            , { parse_mode: "Markdown" });
            break;

        case "track_virtual_trades":
            await ctx.editMessageText("⏳ جاري جلب التوصيات النشطة...");
            const activeTrades = await getActiveVirtualTrades();
            if (activeTrades.length === 0) {
                return await ctx.editMessageText("✅ لا توجد توصيات افتراضية نشطة حاليًا.", { reply_markup: virtualTradeKeyboard });
            }
            const prices = await getMarketPrices();
            if (!prices) {
                return await ctx.editMessageText("❌ فشل جلب الأسعار.", { reply_markup: virtualTradeKeyboard });
            }
            let reportMsg = "📈 *متابعة حية للتوصيات النشطة:*\n" + "━━━━━━━━━━━━━━━━━━━━\n";
            for (const trade of activeTrades) {
                const currentPrice = prices[trade.instId]?.price;
                if (!currentPrice) {
                    reportMsg += `*${trade.instId}:* \`لا يمكن جلب السعر الحالي.\`\n`;
                } else {
                    const pnl = (currentPrice - trade.entryPrice) * (trade.virtualAmount / trade.entryPrice);
                    const pnlPercent = (pnl / trade.virtualAmount) * 100;
                    const emoji = pnl >= 0 ? '🟢' : '🔴';
                    reportMsg += `*${trade.instId}* ${emoji}\n` +
                               ` ▫️ *الدخول:* \`$${formatNumber(trade.entryPrice, 4)}\` | *الحالي:* \`$${formatNumber(currentPrice, 4)}\`\n` +
                               ` ▫️ *ربح/خسارة:* \`$${formatNumber(pnl)}\` (\`${formatNumber(pnlPercent)}%\`)\n` +
                               ` ▫️ *الهدف:* \`$${formatNumber(trade.targetPrice, 4)}\` | *الوقف:* \`$${formatNumber(trade.stopLossPrice, 4)}\`\n`;
                }
                reportMsg += "━━━━━━━━━━━━━━━━━━━━\n";
            }
            await ctx.editMessageText(reportMsg, { parse_mode: "Markdown", reply_markup: virtualTradeKeyboard });
            break;
            
        case "set_capital": waitingState = 'set_capital'; await ctx.editMessageText("💰 يرجى إرسال المبلغ الجديد لرأس المال (رقم فقط)."); break;
        case "back_to_settings": await sendSettingsMenu(ctx); break;
        case "manage_movement_alerts": await sendMovementAlertsMenu(ctx); break;
        case "set_global_alert": waitingState = 'set_global_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال النسبة العامة الجديدة (مثال: `5`)."); break;
        case "set_coin_alert": waitingState = 'set_coin_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال رمز العملة والنسبة.\n*مثال:*\n`BTC 2.5`"); break;
        case "view_positions":
            const positions = await loadPositions();
            if (Object.keys(positions).length === 0) { await ctx.editMessageText("ℹ️ لا توجد مراكز مفتوحة.", { reply_markup: new InlineKeyboard().text("🔙 العودة", "back_to_settings") }); break; }
            let posMsg = "📄 *قائمة المراكز المفتوحة:*\n";
            for (const symbol in positions) {
                const pos = positions[symbol];
                posMsg += `\n- *${symbol}:* متوسط الشراء \`$${formatNumber(pos.avgBuyPrice, 4)}\``;
            }
            await ctx.editMessageText(posMsg, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة", "back_to_settings") });
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
            case 'add_virtual_trade':
                try {
                    const lines = text.split('\n').map(line => line.trim());
                    if (lines.length < 5) throw new Error("التنسيق غير صحيح، يجب أن يتكون من 5 أسطر.");

                    const instId = lines[0].toUpperCase();
                    const entryPrice = parseFloat(lines[1]);
                    const targetPrice = parseFloat(lines[2]);
                    const stopLossPrice = parseFloat(lines[3]);
                    const virtualAmount = parseFloat(lines[4]);
                    
                    if (!instId.endsWith('-USDT')) throw new Error("رمز العملة يجب أن ينتهي بـ -USDT.");
                    if (isNaN(entryPrice) || isNaN(targetPrice) || isNaN(stopLossPrice) || isNaN(virtualAmount)) {
                        throw new Error("تأكد من أن جميع القيم المدخلة هي أرقام صالحة.");
                    }
                    if (entryPrice <= 0 || targetPrice <= 0 || stopLossPrice <= 0 || virtualAmount <= 0) {
                        throw new Error("جميع القيم الرقمية يجب أن تكون أكبر من صفر.");
                    }
                    if (targetPrice <= entryPrice) throw new Error("سعر الهدف يجب أن يكون أعلى من سعر الدخول.");
                    if (stopLossPrice >= entryPrice) throw new Error("سعر وقف الخسارة يجب أن يكون أقل من سعر الدخول.");

                    const tradeData = { instId, entryPrice, targetPrice, stopLossPrice, virtualAmount, status: 'active', createdAt: new Date() };
                    await saveVirtualTrade(tradeData);
                    await ctx.reply(`✅ *تمت إضافة التوصية الافتراضية بنجاح.*\n\nسيتم إعلامك عند تحقيق الهدف أو تفعيل وقف الخسارة.`, { parse_mode: "Markdown" });
                } catch (e) {
                    await ctx.reply(`❌ *خطأ في إضافة التوصية:*\n${e.message}\n\nالرجاء المحاولة مرة أخرى بالتنسيق الصحيح.`);
                }
                return;
            
            case 'set_alert':
                 const parts = text.trim().split(/\s+/);
                 if (parts.length !== 3) return await ctx.reply("❌ صيغة غير صحيحة. مثال: `BTC > 50000`");
                 const [symbol, cond, priceStr] = parts;
                 if (cond !== '>' && cond !== '<') return await ctx.reply("❌ الشرط غير صالح. استخدم `>` أو `<`.");
                 const price = parseFloat(priceStr);
                 if (isNaN(price) || price <= 0) return await ctx.reply("❌ السعر غير صالح.");
                 const allAlerts = await loadAlerts();
                 allAlerts.push({ instId: symbol.toUpperCase() + '-USDT', condition: cond, price: price });
                 await saveAlerts(allAlerts);
                 await ctx.reply(`✅ تم ضبط التنبيه: ${symbol.toUpperCase()} ${cond} ${price}`, { parse_mode: "Markdown" });
                 return;
            case 'set_capital':
                 const amount = parseFloat(text);
                 if (!isNaN(amount) && amount >= 0) {
                     await saveCapital(amount);
                     await ctx.reply(`✅ *تم تحديث رأس المال إلى:* \`$${formatNumber(amount)}\``, { parse_mode: "Markdown" });
                 } else await ctx.reply("❌ مبلغ غير صالح.");
                 return;
             case 'delete_alert_number':
                 let currentAlerts = await loadAlerts();
                 const index = parseInt(text) - 1;
                 if (isNaN(index) || index < 0 || index >= currentAlerts.length) return await ctx.reply("❌ رقم غير صالح.");
                 currentAlerts.splice(index, 1);
                 await saveAlerts(currentAlerts);
                 await ctx.reply(`✅ تم حذف التنبيه.`);
                 return;
             case 'confirm_delete_all':
                 if (text === 'تأكيد الحذف') {
                     await getCollection("configs").deleteMany({});
                     await ctx.reply("✅ تم حذف جميع بياناتك.");
                 } else await ctx.reply("❌ تم إلغاء الحذف.");
                 return;
             case 'coin_info':
                 const instId = text.toUpperCase();
                 const loadingMsg = await ctx.reply(`⏳ جاري تجهيز التقرير لـ ${instId}...`);
                 const details = await getInstrumentDetails(instId);
                 if (details.error) return await ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, `❌ ${details.error}`);
                 let msg = `ℹ️ *معلومات سريعة | ${instId}*\n\n` +
                           `*السعر الحالي:* \`$${formatNumber(details.price, 4)}\`\n` +
                           `*أعلى (24س):* \`$${formatNumber(details.high24h, 4)}\`\n` +
                           `*أدنى (24س):* \`$${formatNumber(details.low24h, 4)}\``;
                 await ctx.api.editMessageText(loadingMsg.chat.id, loadingMsg.message_id, msg, { parse_mode: "Markdown" });
                 return;
        }
    }
    
    // --- Fallback for Main Menu Buttons ---
    switch (text) {
        case "📊 عرض المحفظة":
            await ctx.reply("⏳ جاري إعداد التقرير...");
            const prices = await getMarketPrices();
            if (!prices) return await ctx.reply("❌ فشل جلب أسعار السوق.");
            const capital = await loadCapital();
            const { assets, total, error } = await getPortfolio(prices);
            if (error) return await ctx.reply(error);
            const portfolioMsg = `🧾 *ملخص المحفظة*\n` + `*القيمة الإجمالية:* \`$${formatNumber(total)}\`\n` + `*رأس المال:* \`$${formatNumber(capital)}\`\n` + `*عدد الأصول:* \`${assets.length}\``;
            await ctx.reply(portfolioMsg, { parse_mode: "Markdown" });
            break;
        case "💡 توصية افتراضية":
            await ctx.reply("اختر الإجراء المطلوب للتوصيات الافتراضية:", { reply_markup: virtualTradeKeyboard });
            break;
        case "📈 أداء المحفظة":
            const performanceKeyboard = new InlineKeyboard().text("آخر 24 ساعة", "chart_24h").row().text("آخر 7 أيام", "chart_7d").row().text("آخر 30 يومًا", "chart_30d");
            await ctx.reply("اختر الفترة الزمنية لعرض تقرير الأداء:", { reply_markup: performanceKeyboard });
            break;
        case "⚙️ الإعدادات":
            await sendSettingsMenu(ctx);
            break;
        case "🔔 ضبط تنبيه":
            waitingState = 'set_alert';
            await ctx.reply("✍️ *لضبط تنبيه سعر، استخدم الصيغة:*\n`BTC > 50000`", { parse_mode: "Markdown" });
            break;
        case "🧮 حاسبة الربح والخسارة":
            await ctx.reply("✍️ لحساب الربح/الخسارة، استخدم أمر `/pnl` بالصيغة التالية:\n`/pnl <سعر الشراء> <سعر البيع> <الكمية>`", {parse_mode: "Markdown"});
            break;
        case "ℹ️ معلومات عملة":
             waitingState = 'coin_info';
             await ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`).");
             break;
    }
});

// =================================================================
// SECTION 5: SERVER AND BOT INITIALIZATION
// =================================================================

app.get("/healthcheck", (req, res) => res.status(200).send("OK"));

async function startBot() {
    try {
        await connectDB();
        console.log("MongoDB connected.");

        // Schedule ALL background jobs
        setInterval(monitorBalanceChanges, 60 * 1000);
        setInterval(checkPriceAlerts, 30 * 1000);
        setInterval(monitorVirtualTrades, 30 * 1000);
        setInterval(runHourlyJobs, 60 * 60 * 1000);
        setInterval(runDailyJobs, 24 * 60 * 60 * 1000);
        
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
        process.exit(1); 
    }
}

startBot();
