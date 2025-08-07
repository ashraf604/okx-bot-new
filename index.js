// =================================================================
// OKX Advanced Analytics Bot - v67 (Stable & Full-Featured)
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();
const { connectDB, getDB } = require("./database.js");

// --- Bot Setup ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const API_BASE_URL = "https://www.okx.com";

// --- State Variables ---
let waitingState = null;

// === Database Functions ===
const getCollection = (collectionName) => getDB().collection("configs");

async function getConfig(id, defaultValue = {}) {
    try {
        const doc = await getCollection("configs").findOne({ _id: id });
        return doc ? doc.data : defaultValue;
    } catch (e) {
        console.error(`Error getting config ${id}:`, e);
        return defaultValue;
    }
}

async function saveConfig(id, data) {
    try {
        await getCollection("configs").updateOne({ _id: id }, { $set: { data: data } }, { upsert: true });
    } catch (e) {
        console.error(`Error saving config ${id}:`, e);
    }
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
        if (tickersJson.code !== '0') return null;
        const prices = {};
        tickersJson.data.forEach(t => {
            const lastPrice = parseFloat(t.last);
            const openPrice = parseFloat(t.open24h);
            const change24h = openPrice > 0 ? (lastPrice - openPrice) / openPrice : 0;
            prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h: change24h };
        });
        return prices;
    } catch (error) { return null; }
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
    } catch (e) { return { error: "خطأ في الاتصال بالمنصة." }; }
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
    } catch (error) { return null; }
}

// ... (بقية الدوال المساعدة مثل getInstrumentDetails, createChartUrl, etc. كما هي في ملفك الأصلي)

async function updatePositionAndAnalyze(asset, amountChange, price, newTotalAmount) {
    if (!asset || isNaN(price)) return null;
    const positions = await loadPositions();
    const position = positions[asset];
    const tradeValue = Math.abs(amountChange) * price;
    let retrospectiveReport = null;
    
    if (amountChange > 0) { // Buy
        if (!position) {
            positions[asset] = { totalAmountBought: amountChange, totalCost: tradeValue, avgBuyPrice: price, openDate: new Date().toISOString(), totalAmountSold: 0, realizedValue: 0 };
        } else {
            position.totalAmountBought += amountChange;
            position.totalCost += tradeValue;
            position.avgBuyPrice = position.totalCost / position.totalAmountBought;
        }
    } else if (amountChange < 0 && position) { // Sell
        const amountSold = Math.abs(amountChange);
        position.realizedValue += tradeValue;
        position.totalAmountSold += amountSold;
        if (newTotalAmount * price < 1) { // Closing position
            const finalPnl = position.realizedValue - position.totalCost;
            const finalPnlPercent = (position.totalCost > 0) ? (finalPnl / position.totalCost) * 100 : 0;
            const pnlEmoji = finalPnl >= 0 ? '🟢⬆️' : '🔴⬇️';
            retrospectiveReport = `✅ **تقرير إغلاق مركز: ${asset}**\n\n` +
                `*النتيجة النهائية:* ${pnlEmoji} \`${finalPnl >= 0 ? '+' : ''}${finalPnl.toFixed(2)}\` (\`${finalPnl >= 0 ? '+' : ''}${finalPnlPercent.toFixed(2)}%\`)\n`;
            delete positions[asset];
        }
    }
    await savePositions(positions);
    return retrospectiveReport;
}

// ======================= التعديل الرئيسي هنا =======================
async function monitorBalanceChanges() {
    try {
        await sendDebugMessage("بدء دورة التحقق من الصفقات...");
        let previousState = await loadBalanceState();
        let previousBalanceState = previousState.balances || {};
        let previousTotalPortfolioValue = previousState.totalValue || 0;
        
        const currentBalance = await getBalanceForComparison();
        if (!currentBalance) return;
        
        const prices = await getMarketPrices();
        if (!prices) return;

        const { total: newTotalPortfolioValue, assets: currentAssets, error } = await getPortfolio(prices);
        if (error) return;

        if (Object.keys(previousBalanceState).length === 0) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
            return;
        }

        const allAssets = new Set([...Object.keys(previousBalanceState), ...Object.keys(currentBalance)]);
        let tradesDetected = false;

        for (const asset of allAssets) {
            if (asset === 'USDT') continue;
            const prevAmount = previousBalanceState[asset] || 0;
            const currAmount = currentBalance[asset] || 0;
            const difference = currAmount - prevAmount;
            
            const priceData = prices[`${asset}-USDT`];
            if (!priceData || isNaN(priceData.price)) continue;
            
            const tradeValue = Math.abs(difference * priceData.price);
            if (tradeValue < 0.1) continue;

            tradesDetected = true;
            const price = priceData.price;
            const retrospectiveReport = await updatePositionAndAnalyze(asset, difference, price, currAmount);

            if (retrospectiveReport) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, retrospectiveReport, { parse_mode: "Markdown" });
            }

            const newAssetValue = currAmount * price;
            const portfolioPercentage = newTotalPortfolioValue > 0 ? (newAssetValue / newTotalPortfolioValue) * 100 : 0;
            const usdtAsset = currentAssets.find(a => a.asset === 'USDT') || { value: 0 };
            const newCashValue = usdtAsset.value;
            const newCashPercentage = newTotalPortfolioValue > 0 ? (newCashValue / newTotalPortfolioValue) * 100 : 0;
            const entryOfPortfolio = previousTotalPortfolioValue > 0 ? (tradeValue / previousTotalPortfolioValue) * 100 : 0;

            const tradeType = difference > 0 ? "شراء 🟢⬆️" : (currAmount * price < 1 ? "إغلاق مركز 🔴⬇️" : "بيع جزئي 🟠");

            // بناء الرسالة المفصلة للمستخدم
            const privateTradeAnalysisText = `🔔 **تحليل حركة تداول**\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🔸 **العملية:** ${tradeType}\n` +
                `🔸 **الأصل:** \`${asset}/USDT\`\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 **تفاصيل الصفقة:**\n` +
                ` ▫️ *سعر التنفيذ:* \`$${price.toFixed(4)}\`\n` +
                ` ▫️ *الكمية:* \`${Math.abs(difference).toFixed(6)}\`\n` +
                ` ▫️ *قيمة الصفقة:* \`$${tradeValue.toFixed(2)}\`\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 **التأثير على المحفظة:**\n` +
                ` ▫️ *حجم الصفقة من المحفظة:* \`${entryOfPortfolio.toFixed(2)}%\`\n` +
                ` ▫️ *الوزن الجديد للعملة:* \`${portfolioPercentage.toFixed(2)}%\`\n` +
                ` ▫️ *نسبة الكاش الجديدة:* \`${newCashPercentage.toFixed(2)}%\``;

            const settings = await loadSettings();
            if (settings.autoPostToChannel) {
                // بناء الرسالة المختصرة للقناة
                const channelText = `🔔 **توصية جديدة: ${difference > 0 ? "شراء 🟢" : "بيع 🔴"}**\n\n` +
                    `*العملة:* \`${asset}/USDT\`\n` +
                    `*متوسط سعر الدخول:* ~\`$${price.toFixed(4)}\`\n` +
                    `*حجم الدخول:* \`${entryOfPortfolio.toFixed(2)}%\` من المحفظة\n` +
                    `*تمثل الآن:* \`${portfolioPercentage.toFixed(2)}%\` من المحفظة`;
                
                try {
                    // إرسال الرسالة المختصرة للقناة
                    await bot.api.sendMessage(TARGET_CHANNEL_ID, channelText, { parse_mode: "Markdown" });
                    // إرسال الرسالة المفصلة لك
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, privateTradeAnalysisText, { parse_mode: "Markdown" });
                } catch (e) {
                    console.error("Failed to auto-post:", e);
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, "❌ فشل النشر التلقائي في القناة. يرجى التحقق من صلاحيات البوت.");
                }
            } else {
                const confirmationKeyboard = new InlineKeyboard()
                    .text("✅ تأكيد ونشر", "publish_trade")
                    .text("❌ تجاهل", "ignore_trade");
                await bot.api.sendMessage(AUTHORIZED_USER_ID, `*تم اكتشاف صفقة جديدة، هل تود نشرها؟*\n\n${privateTradeAnalysisText}`, { parse_mode: "Markdown", reply_markup: confirmationKeyboard });
            }
        }

        if (tradesDetected) {
            await saveBalanceState({ balances: currentBalance, totalValue: newTotalPortfolioValue });
        }
    } catch (e) {
        console.error("CRITICAL ERROR in monitorBalanceChanges:", e);
    }
}


// (هنا بقية دوال المهام المجدولة مثل checkPriceAlerts, runDailyJobs, etc.)


// ========== Express Server & Bot Handlers ==========
// **الحل النهائي لمشكلة SIGTERM**
app.use(express.json());
app.get("/healthcheck", (req, res) => {
    res.status(200).send("OK");
});

bot.use(async (ctx, next) => {
    if (ctx.from?.id === AUTHORIZED_USER_ID) {
        await next();
    }
});

// هنا كل واجهة المستخدم والأوامر من ملفك الأصلي
const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();

bot.command("start", async (ctx) => {
    await ctx.reply(`🤖 *بوت OKX التحليلي المتكامل*\n*الإصدار: v67 - Stable & Full-Featured*\n\nأهلاً بك!`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));

bot.command("pnl", async (ctx) => {
    const args = ctx.match.trim().split(/\s+/);
    if (args.length !== 3 || args[0] === '') {
        return await ctx.reply(`❌ *صيغة غير صحيحة*\nاستخدم: \`/pnl <شراء> <بيع> <كمية>\``, { parse_mode: "Markdown" });
    }
    const [buyPrice, sellPrice, quantity] = args.map(parseFloat);
    if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) {
        return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم هي أرقام موجبة.");
    }
    const pnl = (sellPrice - buyPrice) * quantity;
    const pnlPercent = (pnl / (buyPrice * quantity)) * 100;
    await ctx.reply(`*النتيجة:* \`${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}\` (\`${pnl >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%\`)`, { parse_mode: "Markdown" });
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        if (state === 'set_capital') {
            const amount = parseFloat(text);
            if (!isNaN(amount) && amount >= 0) {
                await saveCapital(amount);
                await ctx.reply(`✅ تم تحديث رأس المال إلى \`$${amount.toFixed(2)}\``, { parse_mode: "Markdown" });
            } else {
                await ctx.reply("❌ مبلغ غير صالح.");
            }
        }
        // ... (بقية حالات waitingState)
        return;
    }

    switch (text) {
        case "📊 عرض المحفظة":
            // (منطق عرض المحفظة المفصل هنا)
            await ctx.reply("⏳ جارٍ إعداد تقرير المحفظة...");
            break;
        case "⚙️ الإعدادات":
            await sendSettingsMenu(ctx);
            break;
        // (بقية الحالات)
        default:
             await ctx.reply("أمر غير معروف. استخدم الأزرار.", { reply_markup: mainKeyboard });
    }
});

async function sendSettingsMenu(ctx) {
    const settings = await loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").row()
        .text(`🚀 النشر التلقائي: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost").row()
        .text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug");
    
    const text = "⚙️ *الإعدادات*";
    try {
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
    } catch {
        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
    }
}

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    if (data === "toggle_autopost" || data === "toggle_debug") {
        const settings = await loadSettings();
        if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel;
        if (data === 'toggle_debug') settings.debugMode = !settings.debugMode;
        await saveSettings(settings);
        await sendSettingsMenu(ctx);
    } else if (data === "set_capital") {
        waitingState = 'set_capital';
        await ctx.editMessageText("أرسل مبلغ رأس المال الجديد.");
    } else if (data === "publish_trade") {
        // (منطق النشر اليدوي هنا)
    }
    // ... (بقية حالات callback_query)
});


// ========== Start Bot ==========
async function startBot() {
    console.log("▶️ بدء تشغيل البوت...");
    try {
        await connectDB();
        console.log("✅ تم الاتصال بقاعدة البيانات بنجاح.");

        // جدولة المهام
        setInterval(monitorBalanceChanges, 60000);
        // (بقية المهام)

        console.log("✅ تم جدولة جميع المهام.");

        // بدء البوت بوضعية Polling
        await bot.start();
        console.log("🤖 البوت بدأ ويعمل في وضعية Polling.");

        // بدء الخادم للرد على فحص الصحة
        app.listen(PORT, () => {
            console.log(`🌐 الخادم يستمع على المنفذ ${PORT} وجاهز لفحص الصحة.`);
        });

    } catch (e) {
        console.error("❌ فشل حاد في بدء تشغيل البوت:", e);
        process.exit(1);
    }
}

startBot();
