// =================================================================
// OKX Advanced Analytics Bot - Final Polished Version
// Features: Portfolio Charting, Detailed Coin Info, Daily Summary,
// Price Alerts, Trade Monitoring, and a full Settings Hub.
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

// دالة عامة لقراءة ملف JSON بأمان
function readJsonFile(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath));
        return defaultValue;
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
        return defaultValue;
    }
}

// دالة عامة لكتابة ملف JSON بأمان
function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`Error writing to ${filePath}:`, error);
    }
}

// دوالจัดการ البيانات
const loadCapital = () => readJsonFile(CAPITAL_FILE, 0);
const saveCapital = (amount) => writeJsonFile(CAPITAL_FILE, amount);
const loadAlerts = () => readJsonFile(ALERTS_FILE, []);
const saveAlerts = (alerts) => writeJsonFile(ALERTS_FILE, alerts);
const loadLastTrades = () => readJsonFile(TRADES_FILE, {});
const saveLastTrades = (trades) => writeJsonFile(TRADES_FILE, trades);
const loadHistory = () => readJsonFile(HISTORY_FILE, []);
const saveHistory = (history) => writeJsonFile(HISTORY_FILE, history);
const loadSettings = () => readJsonFile(SETTINGS_FILE, { dailySummary: false });
const saveSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);

// دالة لإنشاء ترويسات OKX API
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

async function getPortfolio() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, { headers: getHeaders("GET", "/api/v5/account/balance") });
        const json = await res.json();
        if (json.code !== '0') return { error: `فشل جلب المحفظة: ${json.msg}` };
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        const prices = {};
        if (tickersJson.data) tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last));
        let assets = [], total = 0;
        json.data[0]?.details?.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0);
                const value = amount * price;
                if (value >= 1) {
                    assets.push({ asset: asset.ccy, price, value, amount });
                    total += value;
                }
            }
        });
        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; }
}

async function getInstrumentDetails(instId) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`);
        const json = await res.json();
        if (json.code !== '0' || !json.data[0]) return { error: `لم يتم العثور على العملة.` };
        const data = json.data[0];
        return {
            price: parseFloat(data.last), high24h: parseFloat(data.high24h),
            low24h: parseFloat(data.low24h), vol24h: parseFloat(data.volCcy24h),
        };
    } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; }
}

// === دوال العرض والمهام المجدولة ===

function formatPortfolioMsg(assets, total, capital) {
    let pnl = capital > 0 ? total - capital : 0;
    let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;
    let msg = `📊 *ملخص المحفظة* 📊\n\n`;
    msg += `💰 *القيمة الحالية:* $${total.toFixed(2)}\n`;
    msg += `💼 *رأس المال الأساسي:* $${capital.toFixed(2)}\n`;
    msg += `📈 *الربح/الخسارة (PnL):* ${pnl >= 0 ? '🟢' : '🔴'} $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\n`;
    msg += `------------------------------------\n`;
    assets.forEach(a => {
        let percent = total > 0 ? ((a.value / total) * 100).toFixed(2) : 0;
        msg += `💎 *${a.asset}* (${percent}%)\n`;
        if (a.asset !== "USDT") msg += `  السعر: $${a.price.toFixed(4)}\n`;
        msg += `  القيمة: $${a.value.toFixed(2)}\n`;
        msg += `  الكمية: ${a.amount}\n\n`;
    });
    msg += `🕒 *آخر تحديث:* ${new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })}`;
    return msg;
}

function createChartUrl(history) {
    if (history.length < 2) return null;
    const last7Days = history.slice(-7);
    const labels = last7Days.map(h => h.date.slice(5));
    const data = last7Days.map(h => h.total.toFixed(2));
    const chartConfig = {
        type: 'line', data: { labels: labels, datasets: [{ label: 'قيمة المحفظة ($)', data: data, fill: true, backgroundColor: 'rgba(75, 192, 192, 0.2)', borderColor: 'rgb(75, 192, 192)', tension: 0.1 }] },
        options: { title: { display: true, text: 'أداء المحفظة آخر 7 أيام' } }
    };
    return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&backgroundColor=white`;
}

async function checkNewTrades() { /* ... الكود كما هو في النسخ السابقة ... */ }
async function checkAlerts() { /* ... الكود كما هو في النسخ السابقة ... */ }

async function runDailyJobs() {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Cairo" }));
    const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD format

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

    // 2. إرسال الملخص اليومي (مرة واحدة يوميًا الساعة 9 صباحًا)
    const settings = loadSettings();
    if (settings.dailySummary && now.getHours() === 9 && now.getMinutes() === 0) {
        const { assets, total, error } = await getPortfolio();
        if (!error) {
            const capital = loadCapital();
            const msg = formatPortfolioMsg(assets, total, capital);
            await bot.api.sendMessage(AUTHORIZED_USER_ID, "📰 *ملخصك اليومي للمحفظة*\n\n" + msg, { parse_mode: "Markdown" });
        }
    }
}

// === واجهة البوت والأوامر ===

// لوحة المفاتيح الرئيسية
const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("👁️ مراقبة الصفقات").text("⚙️ الإعدادات").resized();

bot.command("start", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply("🤖 *بوت OKX التحليلي المتكامل*\n\n- أهلاً بك! الواجهة الرئيسية للوصول السريع، والإدارة الكاملة من قائمة /settings.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

// قائمة الإعدادات
bot.command("settings", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const settings = loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").text("📄 عرض التنبيهات", "view_alerts").row()
        .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
        .text("🔥 حذف كل البيانات 🔥", "delete_all_data");
    await ctx.reply("⚙️ *لوحة التحكم والإعدادات*:", { reply_markup: settingsKeyboard });
});

// === معالجات الأزرار والرسائل ===

// الأزرار الرئيسية
bot.hears("📊 عرض المحفظة", async (ctx) => { /* ... الكود كما هو ... */ });
bot.hears("📈 أداء المحفظة", async (ctx) => { /* ... الكود كما هو ... */ });
bot.hears("ℹ️ معلومات عملة", (ctx) => { waitingState = 'coin_info'; ctx.reply("ℹ️ أرسل رمز العملة (مثال: BTC-USDT)."); });
bot.hears("🔔 ضبط تنبيه", (ctx) => { waitingState = 'set_alert'; ctx.reply("📝 *أرسل تفاصيل التنبيه:*\n`SYMBOL > PRICE`", { parse_mode: "Markdown" }); });
bot.hears("⚙️ الإعدادات", (ctx) => ctx.api.sendMessage(ctx.from.id, "/settings"));
bot.hears("👁️ مراقبة الصفقات", async (ctx) => { /* ... الكود كما هو ... */ });


// الأزرار المضمنة (Inline)
bot.callbackQuery("set_capital", async (ctx) => { waitingState = 'set_capital'; await ctx.answerCallbackQuery(); await ctx.reply("💰 أرسل المبلغ الجديد لرأس المال."); });
bot.callbackQuery("view_alerts", async (ctx) => { /* ... الكود كما هو ... */ });
bot.callbackQuery("delete_alert", async (ctx) => { waitingState = 'delete_alert'; await ctx.answerCallbackQuery(); await ctx.reply("🗑️ أرسل ID التنبيه الذي تريد حذفه."); });
bot.callbackQuery("toggle_summary", async (ctx) => { /* ... الكود كما هو ... */ });
bot.callbackQuery("delete_all_data", async (ctx) => {
    saveAlerts([]); saveLastTrades({}); saveHistory([]);
    await ctx.answerCallbackQuery({ text: "تم حذف جميع البيانات بنجاح!" });
    await ctx.editMessageText("🗑️ تم مسح كل سجلات التنبيهات والصفقات وتاريخ المحفظة.");
});


// المعالج الرئيسي للرسائل النصية
bot.on("message:text", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID || !waitingState) return;
    const text = ctx.message.text;

    switch (waitingState) {
        case 'set_capital':
            const amount = parseFloat(text);
            if (!isNaN(amount) && amount > 0) {
                saveCapital(amount); await ctx.reply(`✅ تم تحديث رأس المال إلى: $${amount.toFixed(2)}`);
            } else { await ctx.reply("❌ مبلغ غير صالح."); }
            break;
        case 'coin_info':
            const { error, ...details } = await getInstrumentDetails(text);
            if (error) { await ctx.reply(`❌ ${error}`); }
            else { /* ... عرض التفاصيل كما في النسخة السابقة ... */ }
            break;
        case 'set_alert':
            /* ... الكود كما هو ... */
            break;
        case 'delete_alert':
            /* ... الكود كما هو ... */
            break;
    }
    waitingState = null; // إعادة تعيين الحالة بعد المعالجة
});


// === بدء تشغيل الخادم والمهام المجدولة ===
app.use(express.json());
app.use(webhookCallback(bot, "express"));

app.listen(PORT, async () => {
    console.log(`✅ Bot running on port ${PORT}`);
    if (!alertsCheckInterval) { alertsCheckInterval = setInterval(checkAlerts, 60000); console.log("✅ Price alert checker started."); }
    if (!dailyJobsInterval) { dailyJobsInterval = setInterval(runDailyJobs, 60000); console.log("✅ Daily jobs scheduler started."); }
    try {
        const domain = process.env.RAILWAY_STATIC_URL || process.env.RENDER_EXTERNAL_URL;
        if (domain) {
            const webhookUrl = `https://${domain}`;
            await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
            console.log(`✅ Webhook set to: ${webhookUrl}`);
        } else { console.warn("Webhook URL not found."); }
    } catch (e) { console.error("Failed to set webhook:", e); }
});

