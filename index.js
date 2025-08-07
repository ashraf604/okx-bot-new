// =================================================================
// OKX Advanced Analytics Bot - v57 (Comprehensive Trade Notifications)
// =================================================================
// This version introduces a completely redesigned, detailed private
// notification for every trade, fulfilling the user's core requirement.
// It ensures every trade is captured and analyzed with all key metrics.
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// --- إعدادات البوت والمتغيرات الأساسية ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT |

| 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";
// --- متغيرات الحالة ---
let waitingState = null;

// === دوال التعامل مع قاعدة البيانات ===
// هذه الدوال توفر واجهة مبسطة للقراءة والكتابة من وإلى مجموعة 'configs' في MongoDB
const getCollection = (collectionName) => getDB().collection("configs");
async function getConfig(id, defaultValue = {}) { const doc = await getCollection("configs").findOne({ _id: id }); return doc?
doc.data : defaultValue; }
async function saveConfig(id, data) { await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true });
}
const loadCapital = async () => (await getConfig("capital", { value: 0 })).value;
const saveCapital = (amount) => saveConfig("capital", { value: amount });
const loadSettings = () => getConfig("settings", { dailySummary: true, autoPostToChannel: true, debugMode: false });
const saveSettings = (settings) => saveConfig("settings", settings);
const loadPositions = () => getConfig("positions", {});
const savePositions = (positions) => saveConfig("positions", positions);
const loadHistory = () => getConfig("dailyHistory",);
const saveHistory = (history) => saveConfig("dailyHistory", history);
const loadHourlyHistory = () => getConfig("hourlyHistory",);
const saveHourlyHistory = (history) => saveConfig("hourlyHistory", history);
const loadBalanceState = () => getConfig("balanceState", {});
const saveBalanceState = (state) => saveConfig("balanceState", state);
const loadAlerts = () => getConfig("priceAlerts",);
const saveAlerts = (alerts) => saveConfig("priceAlerts", alerts);
const loadAlertSettings = () => getConfig("alertSettings", { global: 5, overrides: {} });
const saveAlertSettings = (settings) => saveConfig("alertSettings", settings);
const loadPriceTracker = () => getConfig("priceTracker", { totalPortfolioValue: 0, assets: {} });
const savePriceTracker = (tracker) => saveConfig("priceTracker", tracker);

// === الدوال المساعدة وواجهة برمجة تطبيقات OKX ===
// دالة لإرسال رسائل التشخيص (Debug) إذا كان الوضع مفعلاً
async function sendDebugMessage(message) { const settings = await loadSettings();
if (settings.debugMode) { try { await bot.api.sendMessage(AUTHORIZED_USER_ID, `🐞 *Debug:* ${message}`, { parse_mode: "Markdown" });
} catch (e) { console.error("Failed to send debug message:", e);
} } }
// دالة لإنشاء الترويسات (Headers) المطلوبة لطلبات API مع التوقيع الرقمي
function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString();
const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object'? JSON.stringify(body) : body);
const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", };
}
// دالة لجلب أسعار السوق الحالية لجميع العملات
async function getMarketPrices() { try { const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`); const tickersJson = await tickersRes.json();
if (tickersJson.code!== '0') { console.error("Failed to fetch market prices (OKX Error):", tickersJson.msg); return null; } const prices = {};
tickersJson.data.forEach(t => { const lastPrice = parseFloat(t.last); const openPrice = parseFloat(t.open24h); let change24h = 0; if (openPrice > 0) { change24h = (lastPrice - openPrice) / openPrice; } prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h: change24h }; });
return prices; } catch (error) { console.error("Exception in getMarketPrices (Invalid Response):", error.message); return null;
} }
// دالة لجلب المحفظة وتحليلها وحساب القيمة الإجمالية
async function getPortfolio(prices) { try { const path = "/api/v5/account/balance";
const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json();
if (json.code!== '0') return { error: `فشل جلب المحفظة من OKX: ${json.msg}` };
let assets =, total = 0; json.data?.details?.forEach(asset => { const amount = parseFloat(asset.eq); if (amount > 0) { const instId = `${asset.ccy}-USDT`; const priceData = prices[instId] |

| { price: (asset.ccy === "USDT"? 1 : 0), change24h: 0 }; const price = priceData.price; const value = amount * price; total += value; if (value >= 1) { assets.push({ asset: asset.ccy, price: price, value: value, amount: amount, change24h: priceData.change24h }); } } });
const filteredAssets = assets.filter(a => a.value >= 1); filteredAssets.sort((a, b) => b.value - a.value); return { assets: filteredAssets, total };
} catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." };
} }
// دالة لجلب أرصدة العملات للمقارنة واكتشاف الصفقات
async function getBalanceForComparison() { try { const path = "/api/v5/account/balance";
const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) }); const json = await res.json();
if (json.code!== '0') { console.error("Error fetching balance for comparison:", json.msg); return null; } const balanceMap = {};
json.data?.details?.forEach(asset => { const totalBalance = parseFloat(asset.eq); if (totalBalance > -1e-9) { balanceMap[asset.ccy] = totalBalance; } }); return balanceMap;
} catch (error) { console.error("Exception in getBalanceForComparison:", error); return null;
} }
// دالة لجلب تفاصيل عملة معينة (السعر، الأعلى، الأدنى، إلخ)
async function getInstrumentDetails(instId) { try { const tickerRes = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`); const tickerJson = await tickerRes.json();
if (tickerJson.code!== '0' ||!tickerJson.data) return { error: `لم يتم العثور على العملة.` }; const tickerData = tickerJson.data;
const candleRes = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId.toUpperCase()}&bar=1D&limit=7`); const candleJson = await candleRes.json(); let weeklyData = { high: 0, low: 0 };
if (candleJson.code === '0' && candleJson.data.length > 0) { const highs = candleJson.data.map(c => parseFloat(c));
const lows = candleJson.data.map(c => parseFloat(c)); weeklyData.high = Math.max(...highs); weeklyData.low = Math.min(...lows);
} return { price: parseFloat(tickerData.last), high24h: parseFloat(tickerData.high24h), low24h: parseFloat(tickerData.low24h), vol24h: parseFloat(tickerData.volCcy24h), open24h: parseFloat(tickerData.open24h), weeklyHigh: weeklyData.high, weeklyLow: weeklyData.low };
} catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." };
} }
// دالة لجلب أعلى سعر تاريخي لعملة خلال فترة محددة
async function getHistoricalHighLow(instId, startDate, endDate) { try { const startMs = new Date(startDate).getTime(); const endMs = endDate.getTime();
const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&before=${startMs}&after=${endMs}`); const json = await res.json();
if (json.code!== '0' ||!json.data |

| json.data.length === 0) { console.error(`Could not fetch history for ${instId}:`, json.msg);
return { high: 0 }; } const highs = json.data.map(c => parseFloat(c)); return { high: Math.max(...highs) };
} catch (e) { console.error(`Exception in getHistoricalHighLow for ${instId}:`, e); return { high: 0 };
} }
// دالة لحساب إحصائيات الأداء لفترة زمنية
function calculatePerformanceStats(history) { if (history.length < 2) return null; const values = history.map(h => h.total); const startValue = values;
const endValue = values[values.length - 1]; const pnl = endValue - startValue; const pnlPercent = (startValue > 0)?
(pnl / startValue) * 100 : 0; const maxValue = Math.max(...values); const minValue = Math.min(...values);
const avgValue = values.reduce((sum, val) => sum + val, 0) / values.length;
return { startValue, endValue, pnl, pnlPercent, maxValue, minValue, avgValue };
}
// دالة لإنشاء رابط الرسم البياني باستخدام quickchart.io
function createChartUrl(history, periodLabel, pnl) { if (history.length < 2) return null; const chartColor = pnl >= 0?
'rgb(75, 192, 75)' : 'rgb(255, 99, 132)'; const chartBgColor = pnl >= 0?
'rgba(75, 192, 75, 0.2)' : 'rgba(255, 99, 132, 0.2)'; const labels = history.map(h => h.label);
const data = history.map(h => h.total.toFixed(2)); const chartConfig = { type: 'line', data: { labels: labels, datasets: }, options: { title: { display: true, text: `أداء المحفظة - ${periodLabel}` } } };
return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`; }

// === المنطق البرمجي الأساسي ومعالجات البوت ===
// دالة لتحديث المراكز المفتوحة وتحليل الصفقات عند إغلاقها
async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) { const positions = await loadPositions();
const position = positions[asset]; const tradeValue = Math.abs(amountChange) * price; let retrospectiveReport = null;
if (amountChange > 0) { // حالة الشراء
if (!position) { positions[asset] = { totalAmountBought: amountChange, totalCost: tradeValue, avgBuyPrice: price, openDate: new Date().toISOString(), totalAmountSold: 0, realizedValue: 0, };
} else { position.totalAmountBought += amountChange; position.totalCost += tradeValue; position.avgBuyPrice = position.totalCost / position.totalAmountBought;
} } else if (amountChange < 0 && position) { // حالة البيع
const amountSold = Math.abs(amountChange); position.realizedValue += tradeValue; position.totalAmountSold += amountSold;
if (newTotalAmount * price < 1) { // حالة إغلاق المركز بالكامل
await sendDebugMessage(`Position for ${asset} closed. Generating final report...`);
const finalPnl = position.realizedValue - position.totalCost; const finalPnlPercent = (position.totalCost > 0)? (finalPnl / position.totalCost) * 100 : 0;
const avgSellPrice = position.totalAmountSold > 0? position.realizedValue / position.totalAmountSold : 0; const pnlEmoji = finalPnl >= 0?
'🟢⬆️' : '🔴⬇️'; const { high: peakPrice } = await getHistoricalHighLow(`${asset}-USDT`, position.openDate, new Date()); let efficiencyText = "";
if (peakPrice > position.avgBuyPrice) { const maxPotentialPnl = (peakPrice - position.avgBuyPrice) * position.totalAmountBought;
if (maxPotentialPnl > 0 && finalPnl > 0) { const exitEfficiency = (finalPnl / maxPotentialPnl) * 100;
efficiencyText = `\n   - *كفاءة الخروج:* لقد حققت **${(exitEfficiency |

| 0).toFixed(1)}%** من أقصى ربح ممكن.`;
} } retrospectiveReport = `✅ **تقرير إغلاق مركز: ${asset}**\n\n` + `*النتيجة النهائية للصفقة:* ${pnlEmoji} \`${finalPnl >= 0?
'+' : ''}${(finalPnl |

| 0).toFixed(2)}\` (\`${finalPnl >= 0? '+' : ''}${(finalPnlPercent |
| 0).toFixed(2)}%\`)\n\n` + `**ملخص تحليل الأداء:**\n` + `   - *متوسط سعر الشراء:* \`$${(position.avgBuyPrice |
| 0).toFixed(4)}\`\n` + `   - *متوسط سعر البيع:* \`$${(avgSellPrice |
| 0).toFixed(4)}\`\n` + `   - *أعلى سعر خلال فترة التملك:* \`$${(peakPrice |
| 0).toFixed(4)}\`` + efficiencyText;
delete positions[asset]; } else { await sendDebugMessage(`Partial sell for ${asset} recorded.`); } } await savePositions(positions); return retrospectiveReport;
}
// دالة لتنسيق رسالة تقرير المحفظة الشامل
async function formatPortfolioMsg(assets, total, capital) { const history = await loadHistory(); const positions = await loadPositions();
let dailyPnlText = "   ▫️ *الأداء اليومي (24س):* `لا توجد بيانات كافية`\n";
if (history.length > 0) { const todayStr = new Date().toISOString().slice(0, 10); const previousDayRecord = history.filter(h => h.date!== todayStr).pop();
if (previousDayRecord && typeof previousDayRecord.total === 'number') { const dailyPnl = total - previousDayRecord.total;
const dailyPnlPercent = previousDayRecord.total > 0? (dailyPnl / previousDayRecord.total) * 100 : 0;
const dailyPnlEmoji = dailyPnl >= 0? '🟢⬆️' : '🔴⬇️'; const dailyPnlSign = dailyPnl >= 0? '+' : '';
dailyPnlText = `   ▫️ *الأداء اليومي (24س):* ${dailyPnlEmoji} \`${dailyPnlSign}${(dailyPnl |

| 0).toFixed(2)}\` (\`${dailyPnlSign}${(dailyPnlPercent |
| 0).toFixed(2)}%\`)\n`;
} } let pnl = capital > 0? total - capital : 0;
let pnlPercent = capital > 0? (pnl / capital) * 100 : 0;
let pnlEmoji = pnl >= 0? '🟢⬆️' : '🔴⬇️'; let pnlSign = pnl >= 0? '+' : '';
const usdtAsset = assets.find(a => a.asset === 'USDT'); const usdtValue = usdtAsset? usdtAsset.value : 0;
const cashPercent = total > 0? (usdtValue / total) * 100 : 0; const investedPercent = 100 - cashPercent;
const liquidityText = `   ▫️ *توزيع السيولة:* 💵 نقدي ${(cashPercent |

| 0).toFixed(1)}% / 📈 مستثمر ${(investedPercent |
| 0).toFixed(1)}%`;
let msg = `🧾 *التقرير التحليلي للمحفظة*\n\n`; msg += `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*\n`; msg += `━━━━━━━━━━━━━━━━━━━\n`;
msg += `📊 *نظرة عامة على الأداء:*\n`; msg += `   ▫️ *القيمة الإجمالية:* \`$${(total |

| 0).toFixed(2)}\`\n`;
msg += `   ▫️ *رأس المال المسجل:* \`$${(capital |

| 0).toFixed(2)}\`\n`;
msg += `   ▫️ *إجمالي الربح غير المحقق:* ${pnlEmoji} \`${pnlSign}${(pnl |

| 0).toFixed(2)}\` (\`${pnlSign}${(pnlPercent |
| 0).toFixed(2)}%\`)\n`; msg += dailyPnlText;
msg += liquidityText + `\n`; msg += `━━━━━━━━━━━━━━━━━━━━\n`; msg += `💎 *مكونات المحفظة:*\n`;
assets.forEach((a, index) => { let percent = total > 0? ((a.value / total) * 100) : 0; msg += "\n"; if (a.asset === "USDT") { msg += `*USDT* (الرصيد النقدي) 💵\n`; msg += `*القيمة:* \`$${(a.value |

| 0).toFixed(2)}\` (*الوزن:* \`${(percent |
| 0).toFixed(2)}%\`)`; } else { const change24hPercent = (a.change24h |
| 0) * 100; const changeEmoji = change24hPercent >= 0? '🟢⬆️' : '🔴⬇️'; const changeSign = change24hPercent >= 0? '+' : ''; msg += `╭─ *${a.asset}/USDT*\n`; msg += `├─ *القيمة الحالية:* \`$${(a.value |
| 0).toFixed(2)}\` (*الوزن:* \`${(percent |
| 0).toFixed(2)}%\`)\n`; msg += `├─ *سعر السوق:* \`$${(a.price |
| 0).toFixed(4)}\`\n`; msg += `├─ 
*الأداء اليومي:* ${changeEmoji} \`${changeSign}${(change24hPercent |

| 0).toFixed(2)}%\`\n`; const position = positions[a.asset]; if (position && position.avgBuyPrice > 0) { const avgBuyPrice = position.avgBuyPrice; const totalCost = avgBuyPrice * a.amount; const assetPnl = a.value - totalCost; const assetPnlPercent = (totalCost > 0)? (assetPnl / totalCost) * 100 : 0;
const assetPnlEmoji = assetPnl >= 0? '🟢⬆️' : '🔴⬇️'; const assetPnlSign = assetPnl >= 0? '+' : '';
msg += `├─ *متوسط الشراء:* \`$${(avgBuyPrice |

| 0).toFixed(4)}\`\n`; msg += `╰─ *ربح/خسارة غير محقق:* ${assetPnlEmoji} \`${assetPnlSign}${(assetPnl |
| 0).toFixed(2)}\` (\`${assetPnlSign}${(assetPnlPercent |
| 0).toFixed(2)}%\`)`;
} else { msg += `╰─ *متوسط الشراء:* \`غير مسجل\``;
} } if (index < assets.length - 1) { msg += `\n━━━━━━━━━━━━━━━━━━━━`; } }); return msg;
}

// vvv --- المنطق المطور لمراقبة الصفقات --- vvv
async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("بدء دورة التحقق من الصفقات...");
        const previousState = await loadBalanceState();
        const previousBalanceState = previousState.balances |

| {};
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
        
        const allAssets = new Set();
        let tradesDetected = false;

        for (const asset of allAssets) {
            if (asset === 'USDT') continue;
            const prevAmount = previousBalanceState[asset] |

| 0;
            const currAmount = currentBalance[asset] |

| 0;
            const difference = currAmount - prevAmount;
            if (Math.abs(difference * (prices?.price |

| 0)) < 0.1) continue; // تجاهل التغييرات الطفيفة
            
            tradesDetected = true;
            const priceData = prices;
            if (!priceData ||!priceData.price) { await sendDebugMessage(`لا يمكن العثور على سعر لـ ${asset}.`); continue; }
            const price = priceData.price;
            
            // --- إرسال تقرير إغلاق المركز إذا تم ---
            const retrospectiveReport = await updatePositionAndAnalyze(asset, difference, price, currAmount);
            if (retrospectiveReport) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, retrospectiveReport, { parse_mode: "Markdown" });
            }

            // --- بناء وإرسال تحليل الصفقة المفصل ---
            const tradeValue = Math.abs(difference) * price;
            const portfolioPercentage = newTotalPortfolioValue > 0? ((currAmount * price) / newTotalPortfolioValue) * 100 : 0;
            const usdtAsset = currentAssets.find(a => a.asset === 'USDT') |

| { value: 0 };
            const newCashValue = usdtAsset.value;
            const newCashPercentage = newTotalPortfolioValue > 0? (newCashValue / newTotalPortfolioValue) * 100 : 0;

            const previousTotalPortfolioValue = previousState.totalValue |

| newTotalPortfolioValue;
            const entryOfPortfolio = previousTotalPortfolioValue > 0? (tradeValue / previousTotalPortfolioValue) * 100 : 0;

            let tradeType = "";
            if (difference > 0) { tradeType = "شراء 🟢⬆️"; } 
            else { tradeType = (currAmount * price < 1)? "إغلاق مركز 🔴⬇️" : "بيع جزئي 🟠"; }

            const tradeAnalysisText = `🔔 **تحليل حركة تداول**\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🔸 **العملية:** ${tradeType}\n` +
                `🔸 **الأصل:** \`${asset}/USDT\`\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 **تفاصيل الصفقة:**\n` +
                `   ▫️ *سعر التنفيذ:* \`$${(price |

| 0).toFixed(4)}\`\n` +
                `   ▫️ *الكمية:* \`${Math.abs(difference).toFixed(6)}\`\n` +
                `   ▫️ *قيمة الصفقة:* \`$${tradeValue.toFixed(2)}\`\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 **التأثير على المحفظة:**\n` +
                `   ▫️ *حجم الصفقة من المحفظة:* \`${entryOfPortfolio.toFixed(2)}%\`\n` +
                `   ▫️ *الوزن الجديد للعملة:* \`${portfolioPercentage.toFixed(2)}%\`\n` +
                `   ▫️ *الرصيد النقدي الجديد:* \`$${newCashValue.toFixed(2)}\`\n` +
                `   ▫️ *نسبة الكاش الجديدة:* \`${newCashPercentage.toFixed(2)}%\`\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `*بتاريخ: ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}*`;
            await bot.api.sendMessage(AUTHORIZED_USER_ID, tradeAnalysisText, { parse_mode: "Markdown" });

            const settings = await loadSettings();
            if (settings.autoPostToChannel) {
                await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, tradeAnalysisText, { parse_mode: "Markdown" });
            }
        }
        
        if (tradesDetected) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            await sendDebugMessage(`State updated after processing all detected trades.`);
        } else {
            await sendDebugMessage("لا توجد تغييرات في أرصدة العملات.");
            // تحديث الحالة حتى لو لم تكن هناك صفقات للحفاظ على دقة قيمة المحفظة
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
        }
    } catch (e) { console.error("CRITICAL ERROR in monitorBalanceChanges:", e); }
}
// ^^^ نهاية المنطق المطور ^^^

//... باقي الدوال (مثل checkPriceAlerts, runDailyJobs, إلخ) لم تتغير بشكل جوهري عن الإصدارات السابقة
//... سيتم إدراجها هنا في الكود الفعلي ولكن تم حذفها من هذا العرض للاختصار.
//... (The rest of the code for other features like price alerts, daily jobs, UI handlers, etc., would follow here)

// --- بدء تشغيل البوت ---
async function startBot() {
    try {
        await connectDB();
        console.log("تم ربط قاعدة البيانات بنجاح بـMongoDB.");
        if (process.env.NODE_ENV === "production") {
            app.use(express.json());
            app.use(webhookCallback(bot, "express"));
            app.listen(PORT, () => { console.log(`بوت v57 (Comprehensive Notifications) يستمع على المنفذ ${PORT}`); });
        } else {
            bot.start();
            console.log("Bot v57 (Comprehensive Notifications) started with polling.");
        }
        // إعداد المؤقتات الدورية للمراقبة
        setInterval(monitorBalanceChanges, 60000); // كل دقيقة
        // setInterval(checkPriceAlerts, 30000); // (مثال لدالة أخرى)
        // setInterval(runDailyJobs, 3600000); // (مثال لدالة أخرى)
        // setInterval(checkPriceMovements, 60000); // (مثال لدالة أخرى)
    } catch (e) { console.error("FATAL: Could not start the bot.", e); }
}

startBot();
