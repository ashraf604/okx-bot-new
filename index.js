// =================================================================
// OKX Advanced Analytics Bot - Final Stable Version
// This version fixes the daily summary logic and removes
// the unrequested "Delete All Data" feature.
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
const CAPITAL_FILE = "data_capital.json";
const ALERTS_FILE = "data_alerts.json";
const TRADES_FILE = "data_trades.json";
const HISTORY_FILE = "data_history.json";
const SETTINGS_FILE = "data_settings.json";

// --- متغيرات الحالة والمؤشرات ---
let waitingState = null; // 'set_capital', 'coin_info', 'set_alert', 'delete_alert'
let tradeMonitoringInterval = null;
let alertsCheckInterval = null;
let dailyJobsInterval = null;

// === دوال مساعدة وإدارة الملفات ===

function readJsonFile(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath));
        return defaultValue;
    } catch (error) { console.error(`Error reading ${filePath}:`, error); return defaultValue; }
}

function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) { console.error(`Error writing to ${filePath}:`, error); }
}

const loadCapital = () => readJsonFile(CAPITAL_FILE, 0);
const saveCapital = (amount) => writeJsonFile(CAPITAL_FILE, amount);
const loadAlerts = () => readJsonFile(ALERTS_FILE, []);
const saveAlerts = (alerts) => writeJsonFile(ALERTS_FILE, alerts);
const loadLastTrades = () => readJsonFile(TRADES_FILE, {});
const saveLastTrades = (trades) => writeJsonFile(TRADES_FILE, trades);
const loadHistory = () => readJsonFile(HISTORY_FILE, []);
const saveHistory = (history) => writeJsonFile(HISTORY_FILE, history);
// الإعدادات الافتراضية الآن تتضمن تاريخ آخر ملخص
const loadSettings = () => readJsonFile(SETTINGS_FILE, { dailySummary: false, lastSummaryDate: null });
const saveSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);

function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body);
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64");
    return {
        "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
        "Content-Type": "application/json",
    };
}

// === دوال جلب البيانات من OKX ===
async function getPortfolio() { /* ... الكود كما هو ... */ }
async function getInstrumentDetails(instId) { /* ... الكود كما هو ... */ }

// === دوال العرض والمهام المجدولة ===

function formatPortfolioMsg(assets, total, capital) { /* ... الكود كما هو ... */ }
function createChartUrl(history) { /* ... الكود كما هو ... */ }
async function checkNewTrades() { /* ... الكود كما هو ... */ }
async function checkAlerts() { /* ... الكود كما هو ... */ }

// ** دالة المهام اليومية مع منطق توقيت مُحسَّن **
async function runDailyJobs() {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" }));
    const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

    // 1. أخذ لقطة للمحفظة (مرة واحدة يوميًا)
    const history = loadHistory();
    if (!history.find(h => h.date === todayStr)) {
        const { total, error } = await getPortfolio();
        if (!error && total > 0) {
            history.push({ date: todayStr, total });
            saveHistory(history);
            console.log(`Portfolio snapshot taken for ${todayStr}: $${total}`);
        }
    }

    // 2. إرسال الملخص اليومي (منطق جديد وموثوق)
    const settings = loadSettings();
    // هل الملخص مفعل؟ وهل الساعة 9 صباحًا؟ وهل لم نرسل ملخصًا اليوم؟
    if (settings.dailySummary && now.getHours() === 9 && settings.lastSummaryDate !== todayStr) {
        console.log("Attempting to send daily summary...");
        const { assets, total, error } = await getPortfolio();
        if (!error) {
            const capital = loadCapital();
            const msg = formatPortfolioMsg(assets, total, capital);
            await bot.api.sendMessage(AUTHORIZED_USER_ID, "📰 *ملخصك اليومي للمحفظة*\n\n" + msg, { parse_mode: "Markdown" });
            
            // تحديث الإعدادات لتسجيل أن الملخص قد أُرسل اليوم
            settings.lastSummaryDate = todayStr;
            saveSettings(settings);
            console.log(`Daily summary sent for ${todayStr}.`);
        }
    }
}

// === واجهة البوت والأوامر ===

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("👁️ مراقبة الصفقات").text("⚙️ الإعدادات").resized();

bot.command("start", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply("🤖 *بوت OKX التحليلي المتكامل*\n\n- تم إصلاح الأخطاء. البوت جاهز للعمل.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const settings = loadSettings();
    // ** تم حذف زر "حذف كل البيانات" **
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").text("📄 عرض التنبيهات", "view_alerts").row()
        .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary");
    await ctx.reply("⚙️ *لوحة التحكم والإعدادات*:", { reply_markup: settingsKeyboard });
});

// === معالجات الأزرار المضمنة (Inline Keyboard) ===
bot.callbackQuery("set_capital", async (ctx) => { /* ... الكود كما هو ... */ });
bot.callbackQuery("view_alerts", async (ctx) => { /* ... الكود كما هو ... */ });
bot.callbackQuery("delete_alert", async (ctx) => { /* ... الكود كما هو ... */ });
bot.callbackQuery("toggle_summary", async (ctx) => {
    const settings = loadSettings();
    settings.dailySummary = !settings.dailySummary;
    saveSettings(settings);
    await ctx.answerCallbackQuery({ text: `الملخص اليومي الآن ${settings.dailySummary ? 'مفعل' : 'معطل'}.` });
    // تحديث الرسالة لتعكس الحالة الجديدة
    const newKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").text("📄 عرض التنبيهات", "view_alerts").row()
        .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary");
    await ctx.editMessageText("⚙️ *لوحة التحكم والإعدادات*:", { reply_markup: newKeyboard });
});
// ** تم حذف معالج زر "حذف كل البيانات" **

// === المعالج الشامل للرسائل النصية ===
bot.on("message:text", async (ctx) => { /* ... الكود كما هو في النسخة السابقة ... */ });

// === بدء تشغيل الخادم والمهام المجدولة ===
app.use(express.json());
app.use(webhookCallback(bot, "express"));

app.listen(PORT, async () => {
    console.log(`✅ Bot running on port ${PORT}`);
    // التحقق من التنبيهات كل دقيقة
    if (!alertsCheckInterval) { alertsCheckInterval = setInterval(checkAlerts, 60000); console.log("✅ Price alert checker started."); }
    // التحقق من المهام اليومية كل 5 دقائق لتقليل الحمل
    if (!dailyJobsInterval) { dailyJobsInterval = setInterval(runDailyJobs, 5 * 60000); console.log("✅ Daily jobs scheduler started."); }
    
    try {
        const domain = process.env.RAILWAY_STATIC_URL || process.env.RENDER_EXTERNAL_URL;
        if (domain) {
            const webhookUrl = `https://${domain}`;
            await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
            console.log(`✅ Webhook set to: ${webhookUrl}`);
        } else { console.warn("Webhook URL not found."); }
    } catch (e) { console.error("Failed to set webhook:", e); }
});

