// ✅ OKX Advanced Analytics Bot - Cleaned (Removed 'Delete All Data' Button)

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

// --- ملفات التخزين ---
const CAPITAL_FILE = "data_capital.json";
const ALERTS_FILE = "data_alerts.json";
const TRADES_FILE = "data_trades.json";
const HISTORY_FILE = "data_history.json";
const SETTINGS_FILE = "data_settings.json";

// --- حالة البوت ---
let waitingState = null;
let tradeMonitoringInterval = null;
let alertsCheckInterval = null;
let dailyJobsInterval = null;

// --- دوال المساعدة والملفات ---
function readJsonFile(filePath, defaultValue) { try { if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath)); return defaultValue; } catch { return defaultValue; } }
function writeJsonFile(filePath, data) { try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); } catch {} }
const loadCapital = () => readJsonFile(CAPITAL_FILE, 0);
const saveCapital = (amount) => writeJsonFile(CAPITAL_FILE, amount);
const loadAlerts = () => readJsonFile(ALERTS_FILE, []);
const saveAlerts = (alerts) => writeJsonFile(ALERTS_FILE, alerts);
const loadHistory = () => readJsonFile(HISTORY_FILE, []);
const saveHistory = (history) => writeJsonFile(HISTORY_FILE, history);
const loadSettings = () => readJsonFile(SETTINGS_FILE, { dailySummary: false });
const saveSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);

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

// --- الدوال الخاصة بالمنصة والرسوم البيانية ---
async function getPortfolio() { /* نفس الكود الخاص بجلب المحفظة */ }
async function getInstrumentDetails(instId) { /* نفس الكود الخاص بجلب تفاصيل العملة */ }
function formatPortfolioMsg(assets, total, capital) { /* نفس الدالة */ }
function createChartUrl(history) { /* نفس الدالة */ }
async function checkNewTrades() { /* نفس الدالة */ }
async function checkAlerts() { /* نفس الدالة */ }
async function runDailyJobs() { /* نفس الدالة */ }

// --- واجهة المستخدم ---
const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("👁️ مراقبة الصفقات").text("⚙️ الإعدادات").resized();

bot.command("start", async (ctx) => { if (ctx.from.id !== AUTHORIZED_USER_ID) return; await ctx.reply("🤖 *بوت OKX التحليلي المتكامل*", { parse_mode: "Markdown", reply_markup: mainKeyboard }); });

bot.command("settings", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const settings = loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital")
        .text("📄 عرض التنبيهات", "view_alerts").row()
        .text("🗑️ حذف تنبيه", "delete_alert")
        .text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary");
    await ctx.reply("⚙️ *لوحة التحكم والإعدادات*:", { reply_markup: settingsKeyboard });
});

// تم حذف زر "🔥 حذف كل البيانات 🔥" بالكامل
// ويمكن حذف المعالج الخاص به إن أردت التنظيف الكامل من المشروع

// --- المعالجات ---
bot.callbackQuery("set_capital", async (ctx) => { /* كما هو */ });
bot.callbackQuery("view_alerts", async (ctx) => { /* كما هو */ });
bot.callbackQuery("delete_alert", async (ctx) => { /* كما هو */ });
bot.callbackQuery("toggle_summary", async (ctx) => { /* كما هو */ });

// --- الرسائل النصية ---
bot.on("message:text", async (ctx) => { /* كما هو */ });

// --- بدء التشغيل ---
app.use(express.json());
app.use(webhookCallback(bot, "express"));
app.listen(PORT, async () => {
    console.log(`✅ Bot running on port ${PORT}`);
    if (!alertsCheckInterval) alertsCheckInterval = setInterval(checkAlerts, 60000);
    if (!dailyJobsInterval) dailyJobsInterval = setInterval(runDailyJobs, 60000);
    try {
        const domain = process.env.RAILWAY_STATIC_URL || process.env.RENDER_EXTERNAL_URL;
        if (domain) {
            const webhookUrl = `https://${domain}`;
            await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
            console.log(`✅ Webhook set to: ${webhookUrl}`);
        }
    } catch (e) { console.error("Failed to set webhook:", e); }
});
