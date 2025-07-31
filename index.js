// =================================================================
// OKX Advanced Analytics Bot - v32 (Final Reviewed Build)
// =================================================================
// This is the final, fully reviewed version with all features and fixes.
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();

// --- Bot Basic Settings ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// --- Data Storage Files ---
const DATA_DIR = "./data";
const CAPITAL_FILE = `${DATA_DIR}/data_capital.json`;
const ALERTS_FILE = `${DATA_DIR}/data_alerts.json`;
const HISTORY_FILE = `${DATA_DIR}/data_history.json`;
const HOURLY_HISTORY_FILE = `${DATA_DIR}/data_hourly_history.json`;
const SETTINGS_FILE = `${DATA_DIR}/data_settings.json`;
const BALANCE_STATE_FILE = `${DATA_DIR}/data_balance_state.json`;
const POSITIONS_FILE = `${DATA_DIR}/data_positions.json`;
const ALERT_SETTINGS_FILE = `${DATA_DIR}/data_alert_settings.json`;
const PRICE_TRACKER_FILE = `${DATA_DIR}/data_price_tracker.json`;

// --- State and Interval Variables ---
let waitingState = null;
let balanceMonitoringInterval = null;
let previousBalanceState = {};
let alertsCheckInterval = null;
let dailyJobsInterval = null;
let hourlyJobsInterval = null;
let movementCheckInterval = null;

// === Helper and File Management Functions ===
function readJsonFile(filePath, defaultValue) { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR); if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8')); return defaultValue; } catch (error) { console.error(`Error reading ${filePath}:`, error); return defaultValue; } }
function writeJsonFile(filePath, data) { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR); fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch (error) { console.error(`Error writing to ${filePath}:`, error); } }
const loadCapital = () => readJsonFile(CAPITAL_FILE, 0);
const saveCapital = (amount) => writeJsonFile(CAPITAL_FILE, amount);
const loadAlerts = () => readJsonFile(ALERTS_FILE, []);
const saveAlerts = (alerts) => writeJsonFile(ALERTS_FILE, alerts);
const loadHistory = () => readJsonFile(HISTORY_FILE, []);
const saveHistory = (history) => writeJsonFile(HISTORY_FILE, history);
const loadHourlyHistory = () => readJsonFile(HOURLY_HISTORY_FILE, []);
const saveHourlyHistory = (history) => writeJsonFile(HOURLY_HISTORY_FILE, history);
const loadSettings = () => readJsonFile(SETTINGS_FILE, { dailySummary: false, autoPostToChannel: false, debugMode: false });
const saveSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);
const loadBalanceState = () => readJsonFile(BALANCE_STATE_FILE, {});
const saveBalanceState = (state) => writeJsonFile(BALANCE_STATE_FILE, state);
const loadPositions = () => readJsonFile(POSITIONS_FILE, {});
const savePositions = (positions) => writeJsonFile(POSITIONS_FILE, positions);
const loadAlertSettings = () => readJsonFile(ALERT_SETTINGS_FILE, { global: 5, overrides: {} });
const saveAlertSettings = (settings) => writeJsonFile(ALERT_SETTINGS_FILE, settings);
const loadPriceTracker = () => readJsonFile(PRICE_TRACKER_FILE, { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => writeJsonFile(PRICE_TRACKER_FILE, tracker);

// === Debug Message Helper ===
async function sendDebugMessage(message) {
    const settings = loadSettings();
    if (settings.debugMode) {
        try {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" });
        } catch (e) {
            console.error("Failed to send debug message:", e);
        }
    }
}

// === API Functions ===
function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body); const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }

// === Display and Helper Functions ===
function formatPortfolioMsg(assets, total, capital) { const positions = loadPositions(); let pnl = capital > 0 ? total - capital : 0; let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0; let msg = `📊 *ملخص المحفظة* 📊\n\n`; msg += `💰 *القيمة الحالية:* \`$${total.toFixed(2)}\`\n`; msg += `💼 *رأس المال الأساسي:* \`$${capital.toFixed(2)}\`\n`; msg += `📈 *الربح/الخسارة (PnL):* ${pnl >= 0 ? '🟢' : '🔴'} \`$${pnl.toFixed(2)}\` (\`${pnlPercent.toFixed(2)}%\`)\n`; msg += `━━━━━━━━━━━━━━━━━━`; assets.forEach((a, index) => { let percent = total > 0 ? ((a.value / total) * 100).toFixed(2) : 0; if (a.asset === "USDT") { msg += `\n\n╭─💎 *${a.asset}* (\`${percent}%\`)\n`; msg += `╰─💰 القيمة: \`$${a.value.toFixed(2)}\``; } else { msg += `\n\n╭─💎 *${a.asset}* (\`${percent}%\`)\n`; msg += `├─💰 القيمة: \`$${a.value.toFixed(2)}\`\n`; msg += `├─📈 السعر الحالي: \`$${a.price.toFixed(4)}\`\n`; if (positions[a.asset] && positions[a.asset].avgBuyPrice > 0) { const avgBuyPrice = positions[a.asset].avgBuyPrice; msg += `├─🛒 متوسط الشراء: \`$${avgBuyPrice.toFixed(4)}\`\n`; const totalCost = avgBuyPrice * a.amount; const assetPnl = a.value - totalCost; const assetPnlPercent = (totalCost > 0) ? (assetPnl / totalCost) * 100 : 0; const pnlEmoji = assetPnl >= 0 ? '🟢' : '🔴'; msg += `╰─📉 الربح/الخسارة: ${pnlEmoji} \`$${assetPnl.toFixed(2)}\` (\`${assetPnlPercent.toFixed(2)}%\`)`; } else { msg += `╰─🛒 متوسط الشراء: لم يتم تسجيله`; } } if (index < assets.length - 1) { msg += `\n━━━━━━━━━━━━━━━━━━`; } }); msg += `\n\n🕒 *آخر تحديث:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`; return msg; }
function createChartUrl(history, periodLabel) {
    if (history.length < 2) return null;
    const labels = history.map(h => h.label);
    const data = history.map(h => h.total.toFixed(2));
    const chartConfig = {
        type: 'line', data: { labels: labels, datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: 'rgba(75, 192, 192, 0.2)', borderColor: 'rgb(75, 192, 192)', tension: 0.1 }] },
        options: { title: { display: true, text: `أداء المحفظة - ${periodLabel}` } }
    };
    return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`;
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

// === Bot Logic and Scheduled Tasks ===
async function getMarketPrices() { try { const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json(); if (tickersJson.code !== '0') { console.error("Failed to fetch market prices:", tickersJson.msg); return null; } const prices = {}; tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last)); return prices; } catch (error) { console.error("Exception in getMarketPrices:", error); return null; } }
async function getPortfolio(prices) { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') return { error: `فشل جلب المحفظة: ${json.msg}` }; let assets = [], total = 0; json.data[0]?.details?.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0); const value = amount * price; if (value >= 1) { assets.push({ asset: asset.ccy, price, value, amount }); } total += value; } }); const filteredAssets = assets.filter(a => a.value >= 1); filteredAssets.sort((a, b) => b.value - a.value); return { assets: filteredAssets, total }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function getBalanceForComparison() { try { const path = "/api/v5/account/balance"; const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json(); if (json.code !== '0') { console.error("Error fetching balance for comparison:", json.msg); return null; } const balanceMap = {}; json.data[0]?.details?.forEach(asset => { const totalBalance = parseFloat(asset.eq); if (totalBalance > 1e-9) { balanceMap[asset.ccy] = totalBalance; } }); return balanceMap; } catch (error) { console.error("Exception in getBalanceForComparison:", error); return null; } }
async function monitorBalanceChanges() { await sendDebugMessage("بدء دورة التحقق من الصفقات..."); const currentBalance = await getBalanceForComparison(); if (!currentBalance) { await sendDebugMessage("فشل جلب الرصيد الحالي."); return; } if (Object.keys(previousBalanceState).length === 0) { previousBalanceState = currentBalance; saveBalanceState(previousBalanceState); await sendDebugMessage("تم تسجيل الرصيد الأولي وحفظه."); return; } const allAssets = new Set([...Object.keys(previousBalanceState), ...Object.keys(currentBalance)]); for (const asset of allAssets) { if (asset === 'USDT') continue; const prevAmount = previousBalanceState[asset] || 0; const currAmount = currentBalance[asset] || 0; const difference = currAmount - prevAmount; if (Math.abs(difference) < 1e-9) continue; await sendDebugMessage(`*تغيير مكتشف!* \n- العملة: ${asset}\n- السابق: \`${prevAmount}\`\n- الحالي: \`${currAmount}\``); const prices = await getMarketPrices(); if (!prices) { await sendDebugMessage("فشل جلب الأسعار."); return; } let previousTotalPortfolioValue = 0; for (const prevAsset in previousBalanceState) { const prevAssetPrice = prices[`${prevAsset}-USDT`] || (prevAsset === "USDT" ? 1 : 0); previousTotalPortfolioValue += (previousBalanceState[prevAsset] * prevAssetPrice); } const previousUSDTBalance = previousBalanceState['USDT'] || 0; const { total: newTotalPortfolioValue } = await getPortfolio(prices); const price = prices[`${asset}-USDT`]; if (newTotalPortfolioValue === undefined || !price) { await sendDebugMessage("فشل جلب بيانات المحفظة/السعر."); return; } const tradeValue = Math.abs(difference) * price; const avgPrice = tradeValue / Math.abs(difference); const type = difference > 0 ? 'شراء' : 'بيع'; const typeEmoji = difference > 0 ? '🟢' : '🔴'; let publicRecommendationText = ""; let callbackData = ""; const newAssetValue = currAmount * price; const portfolioPercentage = newTotalPortfolioValue > 0 ? (newAssetValue / newTotalPortfolioValue) * 100 : 0; if (type === 'شراء') { const entryOfPortfolio = previousTotalPortfolioValue > 0 ? (tradeValue / previousTotalPortfolioValue) * 100 : 0; const entryOfCash = previousUSDTBalance > 0 ? (tradeValue / previousUSDTBalance) * 100 : 0; publicRecommendationText = `🔔 *توصية جديدة: ${type}* ${typeEmoji}\n\n` + `*العملة:* \`${asset}/USDT\`\n` + `*متوسط سعر الدخول:* ~ \`$${avgPrice.toFixed(4)}\`\n` + `*حجم الدخول:* \`${entryOfPortfolio.toFixed(2)}%\` *من المحفظة*\n` + `*تم استخدام:* \`${entryOfCash.toFixed(2)}%\` *من الكاش المتاح*\n` + `*تمثل الآن:* \`${portfolioPercentage.toFixed(2)}%\` *من المحفظة*`; callbackData = `publish_${asset}_${avgPrice.toFixed(4)}_${portfolioPercentage.toFixed(2)}_${entryOfPortfolio.toFixed(2)}_${entryOfCash.toFixed(2)}_${type}_${currAmount}`; } else { if (currAmount < 0.0001) { publicRecommendationText = `🔔 *توصية جديدة: إغلاق مركز* ${typeEmoji}\n\n` + `*العملة:* \`${asset}/USDT\`\n` + `*متوسط سعر البيع:* ~ \`$${avgPrice.toFixed(4)}\``; } else { publicRecommendationText = `🔔 *توصية جديدة: تخفيف مركز* ${typeEmoji}\n\n` + `*العملة:* \`${asset}/USDT\`\n` + `*متوسط سعر البيع:* ~ \`$${avgPrice.toFixed(4)}\`\n` + `*الكمية المتبقية تمثل الآن:* \`${portfolioPercentage.toFixed(2)}%\` *من المحفظة*`; } callbackData = `publish_${asset}_${avgPrice.toFixed(4)}_${portfolioPercentage.toFixed(2)}_0_0_${type}_${currAmount}`; } const remainingCash = currentBalance['USDT'] || 0; let privateNotificationText = `🔔 *تنبيه بصفقة جديدة*\n\n` + `${typeEmoji} *${type} ${asset}*\n` + `- *الكمية:* \`${Math.abs(difference).toFixed(6)}\`\n` + `- *متوسط السعر:* ~ \`$${avgPrice.toFixed(4)}\`\n` + `- *قيمة الصفقة:* ~ \`$${tradeValue.toFixed(2)}\`\n\n` + `--- \n📊 *الوضع بعد الصفقة:*\n` + `- *نسبة العملة:* \`${portfolioPercentage.toFixed(2)}%\`\n` + `- *الكاش المتبقي:* \`$${remainingCash.toFixed(2)}\``; const settings = loadSettings(); if (settings.autoPostToChannel) { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, publicRecommendationText, { parse_mode: "Markdown" }); await bot.api.sendMessage(AUTHORIZED_USER_ID, privateNotificationText, { parse_mode: "Markdown" }); } else { const confirmationKeyboard = new InlineKeyboard().text("✅ نشر في القناة", callbackData).text("❌ تجاهل", "ignore_trade"); await bot.api.sendMessage(AUTHORIZED_USER_ID, privateNotificationText + "\n\n*هل تريد نشر التوصية في القناة؟*", { parse_mode: "Markdown", reply_markup: confirmationKeyboard }); } previousBalanceState = currentBalance; saveBalanceState(previousBalanceState); await sendDebugMessage("تم تحديث وحفظ الحالة بعد معالجة صفقة واحدة. إنهاء الدورة الحالية."); return; } await sendDebugMessage("لا توجد تغييرات."); previousBalanceState = currentBalance; saveBalanceState(previousBalanceState); }
async function getInstrumentDetails(instId) { try { const res = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const json = await res.json(); if (json.code !== '0' || !json.data[0]) return { error: `لم يتم العثور على العملة.` }; const data = json.data[0]; return { price: parseFloat(data.last), high24h: parseFloat(data.high24h), low24h: parseFloat(data.low24h), vol24h: parseFloat(data.volCcy24h), }; } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; } }
async function checkPriceAlerts() { const alerts = loadAlerts(); if (alerts.length === 0) return; try { const prices = await getMarketPrices(); if (!prices) return; const remainingAlerts = []; let alertsTriggered = false; for (const alert of alerts) { const currentPrice = prices[alert.instId]; if (currentPrice === undefined) { remainingAlerts.push(alert); continue; } let triggered = false; if (alert.condition === '>' && currentPrice > alert.price) triggered = true; else if (alert.condition === '<' && currentPrice < alert.price) triggered = true; if (triggered) { const message = `🚨 *تنبيه سعر!* 🚨\n\n- العملة: *${alert.instId}*\n- الشرط: تحقق (${alert.condition} ${alert.price})\n- السعر الحالي: *${currentPrice}*`; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); alertsTriggered = true; } else { remainingAlerts.push(alert); } } if (alertsTriggered) { saveAlerts(remainingAlerts); } } catch (error) { console.error("Error in checkPriceAlerts:", error); } }
async function runDailyJobs() { const settings = loadSettings(); if (!settings.dailySummary) return; const prices = await getMarketPrices(); if (!prices) return; const { total, error } = await getPortfolio(prices); if (error) return console.error("Daily Summary Error:", error); const history = loadHistory(); const date = new Date().toISOString().slice(0, 10); if (history.length > 0 && history[history.length - 1].date === date) { history[history.length - 1].total = total; } else { history.push({ date: date, total: total }); } if (history.length > 35) history.shift(); saveHistory(history); console.log(`[✅ Daily Summary]: ${date} - $${total.toFixed(2)}`); }
async function runHourlyJobs() { const prices = await getMarketPrices(); if (!prices) return; const { total, error } = await getPortfolio(prices); if (error) return; const hourlyHistory = loadHourlyHistory(); const now = new Date(); const label = `${now.getHours()}:00`; hourlyHistory.push({ label: label, total: total }); if (hourlyHistory.length > 24) hourlyHistory.shift(); saveHourlyHistory(hourlyHistory); console.log(`[✅ Hourly Summary]: ${label} - $${total.toFixed(2)}`); }
async function checkPriceMovements() { await sendDebugMessage("بدء دورة التحقق من حركة الأسعار..."); const alertSettings = loadAlertSettings(); const priceTracker = loadPriceTracker(); const prices = await getMarketPrices(); if (!prices) { await sendDebugMessage("فشل جلب الأسعار، تخطي دورة فحص الحركة."); return; } const { assets, total: currentTotalValue, error } = await getPortfolio(prices); if (error || currentTotalValue === undefined) { await sendDebugMessage("فشل جلب المحفظة، تخطي دورة فحص الحركة."); return; } if (priceTracker.totalPortfolioValue === 0) { priceTracker.totalPortfolioValue = currentTotalValue; assets.forEach(a => { if (a.price) priceTracker.assets[a.asset] = a.price; }); savePriceTracker(priceTracker); await sendDebugMessage("تم تسجيل قيم تتبع الأسعار الأولية."); return; } let trackerUpdated = false; const lastTotalValue = priceTracker.totalPortfolioValue; if (lastTotalValue > 0) { const changePercent = ((currentTotalValue - lastTotalValue) / lastTotalValue) * 100; if (Math.abs(changePercent) >= alertSettings.global) { const emoji = changePercent > 0 ? '🟢' : '🔴'; const movementText = changePercent > 0 ? 'صعود' : 'هبوط'; const message = `📊 *تنبيه حركة المحفظة!*\n\n*الحركة:* ${emoji} *${movementText}* \`${changePercent.toFixed(2)}%\`\n*القيمة الحالية:* \`$${currentTotalValue.toFixed(2)}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); priceTracker.totalPortfolioValue = currentTotalValue; trackerUpdated = true; } } for (const asset of assets) { if (asset.asset === 'USDT' || !asset.price) continue; const lastPrice = priceTracker.assets[asset.asset]; if (lastPrice) { const changePercent = ((asset.price - lastPrice) / lastPrice) * 100; const threshold = alertSettings.overrides[asset.asset] || alertSettings.global; if (Math.abs(changePercent) >= threshold) { const emoji = changePercent > 0 ? '🟢' : '🔴'; const movementText = changePercent > 0 ? 'صعود' : 'هبوط'; const message = `📈 *تنبيه حركة سعر!*\n\n*العملة:* \`${asset.asset}\`\n*الحركة:* ${emoji} *${movementText}* \`${changePercent.toFixed(2)}%\`\n*السعر الحالي:* \`$${asset.price.toFixed(4)}\``; await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" }); priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } else { priceTracker.assets[asset.asset] = asset.price; trackerUpdated = true; } } if (trackerUpdated) { savePriceTracker(priceTracker); await sendDebugMessage("تم تحديث متتبع الأسعار بعد إرسال تنبيه."); } else { await sendDebugMessage("لا توجد حركات أسعار تتجاوز الحد."); } }

// --- لوحات المفاتيح والقوائم ---
const mainKeyboard = new Keyboard().text("📊 عرض المحفظة").text("📈 أداء المحفظة").row().text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row().text("🧮 حاسبة الربح والخسارة").row().text("👁️ مراقبة الصفقات").text("⚙️ الإعدادات").resized();
async function sendSettingsMenu(ctx) {
    const settings = loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").text("💼 إدارة المراكز", "manage_positions").row()
        .text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts").row()
        .text("💾 نسخ احتياطي واستعادة", "backup_restore").row()
        .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
        .text(`🚀 النشر التلقائي: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost")
        .text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").row()
        .text("🔥 حذف كل البيانات 🔥", "delete_all_data");
    const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*";
    try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); } catch { await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); }
}
async function sendPositionsMenu(ctx) { const positionsKeyboard = new InlineKeyboard().text("➕ إضافة أو تعديل مركز", "add_position").row().text("📄 عرض كل المراكز", "view_positions").row().text("🗑️ حذف مركز", "delete_position").row().text("🔙 العودة للإعدادات", "back_to_settings"); await ctx.editMessageText("💼 *إدارة متوسطات الشراء*", { parse_mode: "Markdown", reply_markup: positionsKeyboard }); }
async function sendMovementAlertsMenu(ctx) { const alertSettings = loadAlertSettings(); const text = `🚨 *إدارة تنبيهات الحركة*\n\n- النسبة العامة الحالية: \`${alertSettings.global}%\`\n- يمكنك تعيين نسبة مختلفة لعملة معينة.`; const keyboard = new InlineKeyboard() .text("📊 تعديل النسبة العامة", "set_global_alert").row() .text("💎 تعديل نسبة عملة", "set_coin_alert").row() .text("📄 عرض كل الإعدادات", "view_movement_alerts").row() .text("🔙 العودة للإعدادات الرئيسية", "back_to_settings"); try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }); } catch { await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard }); } }

// --- معالجات الأوامر والرسائل ---
bot.use(async (ctx, next) => { if (ctx.from?.id === AUTHORIZED_USER_ID) { await next(); } else { console.log(`Unauthorized access attempt by user ID: ${ctx.from?.id}`); } });
bot.command("start", async (ctx) => { await ctx.reply("🤖 *بوت OKX التحليلي المتكامل*", { parse_mode: "Markdown", reply_markup: mainKeyboard }); });
bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));
bot.command("pnl", async (ctx) => { const args = ctx.match.trim().split(/\s+/); if (args.length !== 3 || args[0] === '') { return await ctx.reply("❌ *صيغة غير صحيحة.*\n\n" + "`/pnl <شراء> <بيع> <كمية>`\n\n" + "*مثال:*\n`/pnl 100 120 0.5`", { parse_mode: "Markdown" }); } const [buyPrice, sellPrice, quantity] = args.map(parseFloat); if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) { return await ctx.reply("❌ *خطأ:* تأكد من أن القيم أرقام موجبة."); } const totalInvestment = buyPrice * quantity; const totalSaleValue = sellPrice * quantity; const profitOrLoss = totalSaleValue - totalInvestment; const pnlPercentage = (profitOrLoss / totalInvestment) * 100; const resultStatus = profitOrLoss >= 0 ? "ربح ✅" : "خسارة 🔻"; const responseMessage = `*📊 نتيجة الحساب:*\n\n- إجمالي الشراء: \`$${totalInvestment.toLocaleString()}\`\n- إجمالي البيع: \`$${totalSaleValue.toLocaleString()}\`\n\n- الربح/الخسارة: \`$${profitOrLoss.toLocaleString()}\`\n- النسبة: \`${pnlPercentage.toFixed(2)}%\`\n\n*النتيجة: ${resultStatus}*`; await ctx.reply(responseMessage, { parse_mode: "Markdown" }); });
bot.command("avg", async (ctx) => { const args = ctx.match.trim().split(/\s+/); if (args.length !== 2 || args[0] === '') { return await ctx.reply("❌ *صيغة غير صحيحة.*\n\n" + "استخدم: `/avg <SYMBOL> <PRICE>`\n\n" + "*مثال:*\n`/avg OP 1.50`", { parse_mode: "Markdown" }); } const [symbol, priceStr] = args; const price = parseFloat(priceStr); if (isNaN(price) || price <= 0) { return await ctx.reply("❌ *خطأ:* السعر يجب أن يكون رقمًا موجبًا."); } const positions = loadPositions(); positions[symbol.toUpperCase()] = { avgBuyPrice: price }; savePositions(positions); await ctx.reply(`✅ تم تحديث متوسط شراء *${symbol.toUpperCase()}* إلى \`$${price.toFixed(4)}\`.`, { parse_mode: "Markdown" }); });

bot.on("message:forward_date", async (ctx) => {
    if (ctx.message.text && ctx.message.text.startsWith("OKX_BOT_BACKUP_V1:")) {
        try {
            const encodedData = ctx.message.text.split(':')[1];
            const decodedString = Buffer.from(encodedData, 'base64').toString('utf8');
            const backupData = JSON.parse(decodedString);

            if (backupData.capital) saveCapital(backupData.capital);
            if (backupData.positions) savePositions(backupData.positions);
            if (backupData.alertSettings) saveAlertSettings(backupData.alertSettings);
            if (backupData.settings) saveSettings(backupData.settings);

            await ctx.reply("✅ *تم استعادة الإعدادات بنجاح!*");
        } catch (e) {
            await ctx.reply("❌ *فشل استعادة النسخة الاحتياطية.* قد تكون الرسالة تالفة أو غير صحيحة.");
            console.error("Restore failed:", e);
        }
    }
});

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    if (data.startsWith("publish_")) {
        const [, asset, priceStr, portfolioPercentageStr, entryOfPortfolioStr, entryOfCashStr, type, currAmountStr] = data.split('_');
        const currAmount = parseFloat(currAmountStr);
        const typeEmoji = type === 'شراء' ? '🟢' : '🔴';
        let finalRecommendation = "";
        if (type === 'شراء') {
            finalRecommendation = `🔔 *توصية جديدة: ${type}* ${typeEmoji}\n\n` + `*العملة:* \`${asset}/USDT\`\n` + `*متوسط سعر الدخول:* ~ \`$${priceStr}\`\n` + `*حجم الدخول:* \`${entryOfPortfolioStr}%\` *من المحفظة*\n` + `*تم استخدام:* \`${entryOfCashStr}%\` *من الكاش المتاح*\n` + `*تمثل الآن:* \`${portfolioPercentageStr}%\` *من المحفظة*`;
        } else { // بيع
             if (currAmount < 0.0001) {
                finalRecommendation = `🔔 *توصية جديدة: إغلاق مركز* ${typeEmoji}\n\n` + `*العملة:* \`${asset}/USDT\`\n` + `*متوسط سعر البيع:* ~ \`$${priceStr}\``;
            } else {
                finalRecommendation = `🔔 *توصية جديدة: تخفيف مركز* ${typeEmoji}\n\n` + `*العملة:* \`${asset}/USDT\`\n` + `*متوسط سعر البيع:* ~ \`$${priceStr}\`\n` + `*الكمية المتبقية تمثل الآن:* \`${portfolioPercentageStr}%\` *من المحفظة*`;
            }
        }
        try { await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, finalRecommendation, { parse_mode: "Markdown" }); await ctx.editMessageText("✅ تم نشر التوصية بنجاح."); } catch (e) { console.error("Failed to post to channel:", e); await ctx.editMessageText("❌ فشل النشر."); }
        return;
    }
    if (data === "ignore_trade") { await ctx.editMessageText("👍 تم تجاهل الصفقة."); return; }
    
    if (data.startsWith("chart_")) {
        const period = data.split('_')[1];
        await ctx.editMessageText("⏳ جاري إنشاء التقرير...");
        
        let history, periodLabel, periodData;
        
        if (period === '24h') {
            history = loadHourlyHistory();
            periodLabel = "آخر 24 ساعة";
            periodData = history.slice(-24).map(h => ({ label: h.label, total: h.total }));
        } else if (period === '7d') {
            history = loadHistory();
            periodLabel = "آخر 7 أيام";
            periodData = history.slice(-7).map(h => ({ label: h.date.slice(5), total: h.total }));
        } else if (period === '30d') {
            history = loadHistory();
            periodLabel = "آخر 30 يومًا";
            periodData = history.slice(-30).map(h => ({ label: h.date.slice(5), total: h.total }));
        }

        const stats = calculatePerformanceStats(periodData);
        if (!stats) {
            await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لهذه الفترة.");
            return;
        }

        const chartUrl = createChartUrl(periodData, periodLabel);
        const pnlEmoji = stats.pnl >= 0 ? '🟢' : '🔴';
        const caption = `📊 *${periodLabel}*\n\n` +
                      `📈 *النتيجة:* ${pnlEmoji} \`$${stats.pnl.toFixed(2)}\` (\`${stats.pnlPercent.toFixed(2)}%\`)\n` +
                      `📉 *التغير الصافي:* من \`$${stats.startValue.toFixed(2)}\` إلى \`$${stats.endValue.toFixed(2)}\`\n\n` +
                      `*ملخص الفترة:*\n` +
                      `⬆️ *أعلى قيمة:* \`$${stats.maxValue.toFixed(2)}\`\n` +
                      `⬇️ *أدنى قيمة:* \`$${stats.minValue.toFixed(2)}\`\n` +
                      `📊 *متوسط القيمة:* \`$${stats.avgValue.toFixed(2)}\``;
        
        if (chartUrl) {
            await ctx.replyWithPhoto(chartUrl, { caption: caption, parse_mode: "Markdown" });
        } else {
            await ctx.reply(caption, { parse_mode: "Markdown" });
        }
        await ctx.deleteMessage();
        return;
    }

    switch (data) {
        case "manage_positions": await sendPositionsMenu(ctx); break;
        case "add_position": waitingState = 'add_position_state'; await ctx.reply("✍️ أرسل رمز العملة ومتوسط سعر الشراء.\n*مثال:*\n`OP 1.50`"); break;
        case "view_positions": const positions = loadPositions(); if (Object.keys(positions).length === 0) { await ctx.reply("ℹ️ لا توجد متوسطات شراء مسجلة."); } else { let msg = "📄 *متوسطات الشراء المسجلة:*\n\n"; for (const symbol in positions) { msg += `*${symbol}*: \`$${positions[symbol].avgBuyPrice.toFixed(4)}\`\n`; } await ctx.reply(msg, { parse_mode: "Markdown" }); } break;
        case "delete_position": waitingState = 'delete_position_state'; await ctx.reply("🗑️ أرسل رمز العملة التي تريد حذفها.\n*مثال:*\n`OP`"); break;
        case "manage_movement_alerts": await sendMovementAlertsMenu(ctx); break;
        case "set_global_alert": waitingState = 'set_global_alert_state'; await ctx.reply("✍️ أرسل النسبة المئوية العامة الجديدة (رقم فقط)."); break;
        case "set_coin_alert": waitingState = 'set_coin_alert_state'; await ctx.reply("✍️ أرسل رمز العملة والنسبة.\n*مثال:*\n`BTC 2.5`\n(للحذف أرسل نسبة 0)"); break;
        case "view_movement_alerts": const alertSettings = loadAlertSettings(); let msg_alerts = `🚨 *إعدادات تنبيهات الحركة:*\n\n` + `*النسبة العامة:* \`${alertSettings.global}%\`\n` + `--------------------\n*النسب المخصصة:*\n`; if (Object.keys(alertSettings.overrides).length === 0) { msg_alerts += "لا توجد." } else { for (const coin in alertSettings.overrides) { msg_alerts += `- *${coin}:* \`${alertSettings.overrides[coin]}%\`\n`; } } await ctx.reply(msg_alerts, { parse_mode: "Markdown" }); break;
        case "back_to_settings": await sendSettingsMenu(ctx); break;
        case "set_capital": waitingState = 'set_capital'; await ctx.reply("💰 أرسل المبلغ الجديد لرأس المال."); break;
        case "backup_restore":
            const backupData = { capital: loadCapital(), positions: loadPositions(), alertSettings: loadAlertSettings(), settings: loadSettings() };
            const backupString = `OKX_BOT_BACKUP_V1:${Buffer.from(JSON.stringify(backupData)).toString('base64')}`;
            await ctx.reply(`📋 *نسخة احتياطية*\n\nقم بنسخ هذه الرسالة والاحتفاظ بها. لاستعادة الإعدادات، قم بعمل "إعادة توجيه" (Forward) لهذه الرسالة إلى البوت.\n\n\`\`\`\n${backupString}\n\`\`\``, { parse_mode: "Markdown" });
            break;
        case "delete_alert": waitingState = 'delete_alert'; await ctx.reply("🗑️ أرسل ID التنبيه الذي تريد حذفه."); break;
        case "toggle_summary":
        case "toggle_autopost":
        case "toggle_debug":
            {
                const settings = loadSettings();
                if (data === 'toggle_summary') settings.dailySummary = !settings.dailySummary;
                else if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel;
                else if (data === 'toggle_debug') settings.debugMode = !settings.debugMode;
                saveSettings(settings);
                
                const updatedKeyboard = new InlineKeyboard()
                    .text("💰 تعيين رأس المال", "set_capital").text("💼 إدارة المراكز", "manage_positions").row()
                    .text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts").row()
                    .text("💾 نسخ احتياطي واستعادة", "backup_restore").row()
                    .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
                    .text(`🚀 النشر التلقائي: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost")
                    .text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").row()
                    .text("🔥 حذف كل البيانات 🔥", "delete_all_data");
                await ctx.editMessageReplyMarkup({ reply_markup: updatedKeyboard });
            }
            break;
        case "delete_all_data": waitingState = 'confirm_delete_all'; await ctx.reply("⚠️ هل أنت متأكد؟ أرسل `تأكيد` للحذف.", { parse_mode: "Markdown" }); setTimeout(() => { if (waitingState === 'confirm_delete_all') waitingState = null; }, 30000); break;
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        switch (state) {
            case 'set_global_alert_state': const percent = parseFloat(text); if (isNaN(percent) || percent <= 0) { return await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا موجبًا."); } const alertSettingsGlobal = loadAlertSettings(); alertSettingsGlobal.global = percent; saveAlertSettings(alertSettingsGlobal); await ctx.reply(`✅ تم تحديث النسبة العامة إلى \`${percent}%\`.`); return;
            case 'set_coin_alert_state': const parts_coin_alert = text.split(/\s+/); if (parts_coin_alert.length !== 2) { return await ctx.reply("❌ *صيغة غير صحيحة*. يرجى إرسال رمز العملة ثم النسبة."); } const [symbol_coin_alert, percentStr_coin_alert] = parts_coin_alert; const coinPercent = parseFloat(percentStr_coin_alert); if (isNaN(coinPercent) || coinPercent < 0) { return await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا."); } const alertSettingsCoin = loadAlertSettings(); if (coinPercent === 0) { delete alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()]; await ctx.reply(`✅ تم حذف النسبة المخصصة لـ *${symbol_coin_alert.toUpperCase()}* وستتبع النسبة العامة.`); } else { alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()] = coinPercent; await ctx.reply(`✅ تم تحديث النسبة المخصصة لـ *${symbol_coin_alert.toUpperCase()}* إلى \`${coinPercent}%\`.`); } saveAlertSettings(alertSettingsCoin); return;
            case 'add_position_state': const parts_add = text.split(/\s+/); if (parts_add.length !== 2) { await ctx.reply("❌ صيغة غير صحيحة."); return; } const [symbol_add, priceStr_add] = parts_add; const price_add = parseFloat(priceStr_add); if (isNaN(price_add) || price_add <= 0) { await ctx.reply("❌ السعر غير صالح."); return; } const positions_add = loadPositions(); positions_add[symbol_add.toUpperCase()] = { avgBuyPrice: price_add }; savePositions(positions_add); await ctx.reply(`✅ تم تحديث متوسط شراء *${symbol_add.toUpperCase()}* إلى \`$${price_add.toFixed(4)}\`.`, { parse_mode: "Markdown" }); return;
            case 'delete_position_state': const symbol_delete = text.toUpperCase(); const positions_delete = loadPositions(); if (positions_delete[symbol_delete]) { delete positions_delete[symbol_delete]; savePositions(positions_delete); await ctx.reply(`✅ تم حذف متوسط شراء *${symbol_delete}* بنجاح.`); } else { await ctx.reply(`❌ لم يتم العثور على مركز مسجل للعملة *${symbol_delete}*.`); } return;
            case 'set_capital': const amount = parseFloat(text); if (!isNaN(amount) && amount >= 0) { saveCapital(amount); await ctx.reply(`✅ تم تحديث رأس المال إلى: $${amount.toFixed(2)}`); } else { await ctx.reply("❌ مبلغ غير صالح."); } return;
            case 'coin_info': const { error, ...details } = await getInstrumentDetails(text); if (error) { await ctx.reply(`❌ ${error}`); } else { let msg = `*ℹ️ معلومات ${text.toUpperCase()}*\n\n- السعر: \`$${details.price}\`\n- الأعلى (24س): \`$${details.high24h}\`\n- الأدنى (24س): \`$${details.low24h}\``; await ctx.reply(msg, { parse_mode: "Markdown" }); } return;
            case 'set_alert': const parts = text.trim().split(/\s+/); if (parts.length !== 3) return await ctx.reply("❌ صيغة غير صحيحة."); const [instId, condition, priceStr] = parts; const price = parseFloat(priceStr); if (!['>', '<'].includes(condition) || isNaN(price)) return await ctx.reply("❌ صيغة غير صحيحة."); const alerts = loadAlerts(); const newAlert = { id: crypto.randomBytes(4).toString('hex'), instId: instId.toUpperCase(), condition, price }; alerts.push(newAlert); saveAlerts(alerts); await ctx.reply(`✅ تم ضبط التنبيه: ${newAlert.instId} ${newAlert.condition} ${newAlert.price}`); return;
            case 'delete_alert': const currentAlerts = loadAlerts(); const filteredAlerts = currentAlerts.filter(a => a.id !== text); if (currentAlerts.length === filteredAlerts.length) { await ctx.reply(`❌ لم يتم العثور على تنبيه بالـ ID.`); } else { saveAlerts(filteredAlerts); await ctx.reply(`✅ تم حذف التنبيه.`); } return;
            case 'confirm_delete_all': if (text.toLowerCase() === 'تأكيد') { if (fs.existsSync(CAPITAL_FILE)) fs.unlinkSync(CAPITAL_FILE); if (fs.existsSync(ALERTS_FILE)) fs.unlinkSync(ALERTS_FILE); if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE); if(fs.existsSync(HOURLY_HISTORY_FILE)) fs.unlinkSync(HOURLY_HISTORY_FILE); if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE); if (fs.existsSync(POSITIONS_FILE)) fs.unlinkSync(POSITIONS_FILE); if (fs.existsSync(BALANCE_STATE_FILE)) fs.unlinkSync(BALANCE_STATE_FILE); if(fs.existsSync(ALERT_SETTINGS_FILE)) fs.unlinkSync(ALERT_SETTINGS_FILE); if(fs.existsSync(PRICE_TRACKER_FILE)) fs.unlinkSync(PRICE_TRACKER_FILE); await ctx.reply("🔥 تم حذف جميع البيانات."); } else { await ctx.reply("🛑 تم إلغاء الحذف."); } return;
        }
    }

    switch (text) {
        case "📊 عرض المحفظة": await ctx.reply('⏳ لحظات...'); const prices = await getMarketPrices(); if (!prices) return await ctx.reply("❌ فشل جلب الأسعار."); const { assets, total, error } = await getPortfolio(prices); if (error) { await ctx.reply(`❌ ${error}`); } else { const capital = loadCapital(); const msg = formatPortfolioMsg(assets, total, capital); await ctx.reply(msg, { parse_mode: "Markdown" }); } break;
        case "📈 أداء المحفظة":
            const keyboard = new InlineKeyboard()
                .text("آخر 24 ساعة", "chart_24h")
                .text("آخر 7 أيام", "chart_7d")
                .text("آخر 30 يومًا", "chart_30d");
            await ctx.reply("اختر الفترة الزمنية لعرض الأداء:", { reply_markup: keyboard });
            break;
        case "ℹ️ معلومات عملة": waitingState = 'coin_info'; await ctx.reply("✍️ أرسل رمز العملة (مثال: `BTC-USDT`)."); break;
        case "🔔 ضبط تنبيه": waitingState = 'set_alert'; await ctx.reply("✍️ أرسل التنبيه بالصيغة: `SYMBOL > PRICE`"); break;
        case "🧮 حاسبة الربح والخسارة": await ctx.reply("استخدم الأمر مباشرة: `/pnl <شراء> <بيع> <كمية>`"); break;
        case "👁️ مراقبة الصفقات": await ctx.reply("ℹ️ *المراقبة تعمل تلقائيًا في الخلفية.*", { parse_mode: "Markdown" }); break;
        case "⚙️ الإعدادات": await sendSettingsMenu(ctx); break;
        default: await ctx.reply("لم أتعرف على هذا الأمر.", { reply_markup: mainKeyboard });
    }
});

// --- Bot Startup ---
async function startBot() {
    console.log("Starting bot...");
    previousBalanceState = loadBalanceState();
    if (Object.keys(previousBalanceState).length > 0) {
        console.log("Initial balance state loaded from file.");
    } else {
        console.log("No previous balance state found. Will capture on the first run.");
    }
    
    balanceMonitoringInterval = setInterval(monitorBalanceChanges, 1 * 60 * 1000);
    alertsCheckInterval = setInterval(checkPriceAlerts, 5 * 60 * 1000);
    dailyJobsInterval = setInterval(runDailyJobs, 24 * 60 * 60 * 1000);
    hourlyJobsInterval = setInterval(runHourlyJobs, 1 * 60 * 60 * 1000);
    movementCheckInterval = setInterval(checkPriceMovements, 10 * 60 * 1000);

    app.use(express.json());
    app.use(`/${bot.token}`, webhookCallback(bot, "express"));

    app.listen(PORT, () => {
        console.log(`Bot server listening on port ${PORT}`);
    });
}

startBot().catch(err => console.error("Failed to start bot:", err));
