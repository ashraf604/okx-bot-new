// =================================================================
// OKX Advanced Analytics Bot - v28 (Price Movement Alerts)
// =================================================================
// هذا الإصدار يضيف نظام تنبيهات لحركة أسعار المحفظة والعملات الفردية.
// =================================================================

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();

// --- إعدادات البوت الأساسية ---
const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// --- ملفات تخزين البيانات ---
const DATA_DIR = "./data";
const CAPITAL_FILE = `${DATA_DIR}/data_capital.json`;
const ALERTS_FILE = `${DATA_DIR}/data_alerts.json`;
const HISTORY_FILE = `${DATA_DIR}/data_history.json`;
const SETTINGS_FILE = `${DATA_DIR}/data_settings.json`;
const BALANCE_STATE_FILE = `${DATA_DIR}/data_balance_state.json`;
const POSITIONS_FILE = `${DATA_DIR}/data_positions.json`;
const ALERT_SETTINGS_FILE = `${DATA_DIR}/data_alert_settings.json`; // <<< جديد: إعدادات تنبيهات الحركة
const PRICE_TRACKER_FILE = `${DATA_DIR}/data_price_tracker.json`; // <<< جديد: متتبع الأسعار للتنبيهات

// --- متغيرات الحالة والمؤشرات ---
let waitingState = null;
let balanceMonitoringInterval = null;
let previousBalanceState = {};
let alertsCheckInterval = null;
let dailyJobsInterval = null;
let movementCheckInterval = null; // <<< جديد: مؤقت فحص الحركة

// === دوال مساعدة وإدارة الملفات ===
function readJsonFile(filePath, defaultValue) { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR); if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8')); return defaultValue; } catch (error) { console.error(`Error reading ${filePath}:`, error); return defaultValue; } }
function writeJsonFile(filePath, data) { try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR); fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch (error) { console.error(`Error writing to ${filePath}:`, error); } }
const loadCapital = () => readJsonFile(CAPITAL_FILE, 0);
const saveCapital = (amount) => writeJsonFile(CAPITAL_FILE, amount);
const loadAlerts = () => readJsonFile(ALERTS_FILE, []);
const saveAlerts = (alerts) => writeJsonFile(ALERTS_FILE, alerts);
const loadHistory = () => readJsonFile(HISTORY_FILE, []);
const saveHistory = (history) => writeJsonFile(HISTORY_FILE, history);
const loadSettings = () => readJsonFile(SETTINGS_FILE, { dailySummary: false, autoPostToChannel: false, debugMode: false });
const saveSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);
const loadBalanceState = () => readJsonFile(BALANCE_STATE_FILE, {});
const saveBalanceState = (state) => writeJsonFile(BALANCE_STATE_FILE, state);
const loadPositions = () => readJsonFile(POSITIONS_FILE, {});
const savePositions = (positions) => writeJsonFile(POSITIONS_FILE, positions);
const loadAlertSettings = () => readJsonFile(ALERT_SETTINGS_FILE, { global: 5, overrides: {} }); // <<< جديد
const saveAlertSettings = (settings) => writeJsonFile(ALERT_SETTINGS_FILE, settings); // <<< جديد
const loadPriceTracker = () => readJsonFile(PRICE_TRACKER_FILE, { totalPortfolioValue: 0, assets: {} }); // <<< جديد
const savePriceTracker = (tracker) => writeJsonFile(PRICE_TRACKER_FILE, tracker); // <<< جديد

// ... (دوال API والعرض والمساعدة تبقى كما هي) ...

// === دوال منطق البوت والمهام المجدولة ===
// ... (getMarketPrices, getPortfolio, getBalanceForComparison, monitorBalanceChanges, etc. remain unchanged)

// --- دالة جديدة لمراقبة حركة الأسعار ---
async function checkPriceMovements() {
    await sendDebugMessage("بدء دورة التحقق من حركة الأسعار...");
    const alertSettings = loadAlertSettings();
    const priceTracker = loadPriceTracker();
    const prices = await getMarketPrices();
    if (!prices) {
        await sendDebugMessage("فشل جلب الأسعار، تخطي دورة فحص الحركة.");
        return;
    }
    
    const { assets, total: currentTotalValue, error } = await getPortfolio(prices);
    if (error || currentTotalValue === undefined) {
        await sendDebugMessage("فشل جلب المحفظة، تخطي دورة فحص الحركة.");
        return;
    }

    // أول تشغيل: فقط سجل القيم الحالية
    if (priceTracker.totalPortfolioValue === 0) {
        priceTracker.totalPortfolioValue = currentTotalValue;
        assets.forEach(a => {
            if (a.price) priceTracker.assets[a.asset] = a.price;
        });
        savePriceTracker(priceTracker);
        await sendDebugMessage("تم تسجيل قيم تتبع الأسعار الأولية.");
        return;
    }
    
    let trackerUpdated = false;

    // 1. التحقق من حركة المحفظة الإجمالية
    const lastTotalValue = priceTracker.totalPortfolioValue;
    if (lastTotalValue > 0) {
        const changePercent = ((currentTotalValue - lastTotalValue) / lastTotalValue) * 100;
        if (Math.abs(changePercent) >= alertSettings.global) {
            const emoji = changePercent > 0 ? '🟢' : '🔴';
            const message = `📊 *تنبيه حركة المحفظة!*\n\n*تحركت القيمة الإجمالية:* ${emoji} \`${changePercent.toFixed(2)}%\`\n*القيمة الحالية:* \`$${currentTotalValue.toFixed(2)}\``;
            await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
            priceTracker.totalPortfolioValue = currentTotalValue;
            trackerUpdated = true;
        }
    }

    // 2. التحقق من حركة العملات الفردية
    for (const asset of assets) {
        if (asset.asset === 'USDT' || !asset.price) continue;
        
        const lastPrice = priceTracker.assets[asset.asset];
        if (lastPrice) {
            const changePercent = ((asset.price - lastPrice) / lastPrice) * 100;
            const threshold = alertSettings.overrides[asset.asset] || alertSettings.global;
            if (Math.abs(changePercent) >= threshold) {
                const emoji = changePercent > 0 ? '🟢' : '🔴';
                const message = `📈 *تنبيه حركة سعر!*\n\n*العملة:* \`${asset.asset}\`\n*تحرك السعر:* ${emoji} \`${changePercent.toFixed(2)}%\`\n*السعر الحالي:* \`$${asset.price.toFixed(4)}\``;
                await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
                priceTracker.assets[asset.asset] = asset.price;
                trackerUpdated = true;
            }
        } else {
            // إذا كانت العملة جديدة في المحفظة، سجل سعرها
            priceTracker.assets[asset.asset] = asset.price;
            trackerUpdated = true;
        }
    }

    if (trackerUpdated) {
        savePriceTracker(priceTracker);
        await sendDebugMessage("تم تحديث متتبع الأسعار بعد إرسال تنبيه.");
    } else {
        await sendDebugMessage("لا توجد حركات أسعار تتجاوز الحد.");
    }
}


// --- لوحات المفاتيح والقوائم ---
// ... (mainKeyboard remains unchanged) ...
async function sendSettingsMenu(ctx) {
    const settings = loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").text("💼 إدارة المراكز", "manage_positions").row()
        .text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts").row() // <<< زر جديد
        .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
        .text(`🚀 النشر التلقائي: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost")
        .text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").row()
        .text("🔥 حذف كل البيانات 🔥", "delete_all_data");
    const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*";
    try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); } catch { await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard }); }
}
// ... (sendPositionsMenu remains unchanged) ...

// --- قائمة جديدة لإدارة تنبيهات الحركة ---
async function sendMovementAlertsMenu(ctx) {
    const alertSettings = loadAlertSettings();
    const text = `🚨 *إدارة تنبيهات الحركة*\n\n- النسبة العامة الحالية: \`${alertSettings.global}%\`\n- يمكنك تعيين نسبة مختلفة لعملة معينة.`;
    const keyboard = new InlineKeyboard()
        .text("📊 تعديل النسبة العامة", "set_global_alert").row()
        .text("💎 تعديل نسبة عملة", "set_coin_alert").row()
        .text("📄 عرض كل الإعدادات", "view_movement_alerts").row()
        .text("🔙 العودة للإعدادات الرئيسية", "back_to_settings");

    try {
        await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch {
        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
    }
}


// --- معالجات الأوامر والرسائل ---
// ... (bot.use, bot.command remain unchanged) ...

bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();

    // ... (publish, ignore_trade logic remains unchanged) ...
    
    switch (data) {
        // --- حالات القائمة الجديدة ---
        case "manage_movement_alerts":
            await sendMovementAlertsMenu(ctx);
            break;
        case "set_global_alert":
            waitingState = 'set_global_alert_state';
            await ctx.reply("✍️ أرسل النسبة المئوية العامة الجديدة (رقم فقط).");
            break;
        case "set_coin_alert":
            waitingState = 'set_coin_alert_state';
            await ctx.reply("✍️ أرسل رمز العملة والنسبة المئوية.\n\n*مثال:*\n`BTC 2.5`");
            break;
        case "view_movement_alerts":
            const alertSettings = loadAlertSettings();
            let msg = `🚨 *إعدادات تنبيهات الحركة الحالية:*\n\n` +
                      `*النسبة العامة:* \`${alertSettings.global}%\`\n` +
                      `--------------------\n*النسب المخصصة:*\n`;
            if (Object.keys(alertSettings.overrides).length === 0) {
                msg += "لا توجد نسب مخصصة."
            } else {
                for (const coin in alertSettings.overrides) {
                    msg += `- *${coin}:* \`${alertSettings.overrides[coin]}%\`\n`;
                }
            }
            await ctx.reply(msg, { parse_mode: "Markdown" });
            break;

        // ... (باقي الحالات تبقى كما هي) ...
        case "manage_positions": await sendPositionsMenu(ctx); break;
        case "back_to_settings": await sendSettingsMenu(ctx); break;
        // ...
    }
});

bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (waitingState) {
        const state = waitingState;
        waitingState = null;
        switch (state) {
            // --- حالات جديدة لإدارة تنبيهات الحركة ---
            case 'set_global_alert_state':
                const percent = parseFloat(text);
                if (isNaN(percent) || percent <= 0) {
                    return await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا موجبًا.");
                }
                const alertSettingsGlobal = loadAlertSettings();
                alertSettingsGlobal.global = percent;
                saveAlertSettings(alertSettingsGlobal);
                await ctx.reply(`✅ تم تحديث النسبة العامة إلى \`${percent}%\`.`);
                return;

            case 'set_coin_alert_state':
                const parts = text.split(/\s+/);
                if (parts.length !== 2) {
                    return await ctx.reply("❌ *صيغة غير صحيحة*. يرجى إرسال رمز العملة ثم النسبة.");
                }
                const [symbol, percentStr] = parts;
                const coinPercent = parseFloat(percentStr);
                 if (isNaN(coinPercent) || coinPercent < 0) { // 0 لحذف النسبة المخصصة
                    return await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا.");
                }
                const alertSettingsCoin = loadAlertSettings();
                if (coinPercent === 0) {
                    delete alertSettingsCoin.overrides[symbol.toUpperCase()];
                     await ctx.reply(`✅ تم حذف النسبة المخصصة لـ *${symbol.toUpperCase()}* وستتبع النسبة العامة.`);
                } else {
                    alertSettingsCoin.overrides[symbol.toUpperCase()] = coinPercent;
                    await ctx.reply(`✅ تم تحديث النسبة المخصصة لـ *${symbol.toUpperCase()}* إلى \`${coinPercent}%\`.`);
                }
                saveAlertSettings(alertSettingsCoin);
                return;

            // ... (باقي الحالات تبقى كما هي) ...
        }
    }

    // ... (باقي كود معالجة الرسائل النصية يبقى كما هو) ...
});


// --- بدء تشغيل البوت ---
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
    dailyJobsInterval = setInterval(runDailyJobs, 60 * 60 * 1000);
    movementCheckInterval = setInterval(checkPriceMovements, 10 * 60 * 1000); // <<< جديد: تحقق كل 10 دقائق

    app.use(express.json());
    app.use(`/${bot.token}`, webhookCallback(bot, "express"));

    app.listen(PORT, () => {
        console.log(`Bot server listening on port ${PORT}`);
    });
}

startBot().catch(err => console.error("Failed to start bot:", err));
