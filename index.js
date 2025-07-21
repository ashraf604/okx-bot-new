// ✅ OKX Telegram Bot - Final & Corrected Version

import { Bot, webhookCallback, InlineKeyboard } from "grammy";
import express from "express";
import fs from "fs";
import https from "https";
import { getPrices, getPortfolio } from "./utils/okx.js";
import { createChartUrl } from "./utils/chart.js";

const bot = new Bot(process.env.BOT_TOKEN);
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
let alertsCheckInterval;

// ========== 📁 التخزين (Storage) =============
const SETTINGS_PATH = "./data_settings.json";
const ALERTS_PATH = "./data_alerts.json";
const HISTORY_PATH = "./data_history.json";
const CAPITAL_PATH = "./data_capital.json";

function loadJSON(path) {
    if (!fs.existsSync(path)) return [];
    try {
        const raw = fs.readFileSync(path);
        return JSON.parse(raw);
    } catch (error) {
        console.error(`Error reading or parsing JSON from ${path}:`, error);
        return [];
    }
}

function saveJSON(path, data) {
    fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

const loadSettings = () => loadJSON(SETTINGS_PATH);
const saveSettings = (data) => saveJSON(SETTINGS_PATH, data);
const loadAlerts = () => loadJSON(ALERTS_PATH);
const saveAlerts = (data) => saveJSON(ALERTS_PATH, data);
const loadHistory = () => loadJSON(HISTORY_PATH);
const saveHistory = (data) => saveJSON(HISTORY_PATH, data);
const loadCapital = () => {
    const data = loadJSON(CAPITAL_PATH);
    return data.length ? data[0].capital : 1000;
};
const saveCapital = (amount) => saveJSON(CAPITAL_PATH, [{ capital: amount }]);

// ========== 🔔 التنبيهات (Alerts) =============
async function checkAlerts() {
    try {
        const alerts = loadAlerts();
        if (alerts.length === 0) return;

        const prices = await getPrices();
        const notified = new Set();
        const remainingAlerts = [];

        for (const alert of alerts) {
            const currentPrice = prices[alert.symbol];
            if (!currentPrice) {
                remainingAlerts.push(alert);
                continue;
            };

            const triggered =
                (alert.condition === ">" && currentPrice > alert.price) ||
                (alert.condition === "<" && currentPrice < alert.price);

            if (triggered && !notified.has(alert.id)) {
                notified.add(alert.id);
                await bot.api.sendMessage(
                    AUTHORIZED_USER_ID,
                    `🚨 *تنبيه سعر*\n\nالعملة: *${alert.symbol}*\nالشرط: ${alert.condition} ${alert.price}\nالسعر الحالي: *${currentPrice}*`, { parse_mode: "Markdown" }
                );
                // If you want to remove the alert after it triggers, don't add it to remainingAlerts.
                // If you want it to persist, add it back:
                // remainingAlerts.push(alert);
            } else {
                // Alert not triggered, so keep it for next time.
                remainingAlerts.push(alert);
            }
        }
        
        // Save only the alerts that haven't been triggered (or all if you want them to persist)
        if (alerts.length !== remainingAlerts.length) {
            saveAlerts(remainingAlerts);
        }

    } catch (error) {
        console.error("Error in checkAlerts:", error);
    }
}


// ========== 📊 المهام اليومية (Daily Jobs) =============
async function runDailyJobs() {
    try {
        const settingsData = loadSettings();
        const settings = Array.isArray(settingsData) && settingsData.length > 0 ? settingsData[0] : settingsData;
        if (!settings || !settings.dailySummary) return;

        const { total, error } = await getPortfolio();
        if (error) {
            console.error("Daily Summary Error:", error);
            return;
        }

        const history = loadHistory();
        const date = new Date().toISOString().slice(0, 10);

        const lastEntry = history[history.length - 1];
        if (lastEntry && lastEntry.date === date) return; // Already saved for today

        history.push({ date, total });
        if (history.length > 30) history.shift(); // Keep only last 30 days
        saveHistory(history);

        console.log(`[✅ Daily Summary Saved]: ${date} - $${total.toFixed(2)}`);
    } catch (error) {
        console.error("Error in runDailyJobs:", error);
    }
}

// ========== 🧠 الأوامر (Commands) =============
bot.command("start", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply("👋 مرحبًا بك في بوت OKX التحليلي. اختر أمرًا:", {
        reply_markup: new InlineKeyboard()
            .text("📊 المحفظة", "portfolio")
            .text("📈 أداء المحفظة", "performance").row()
            .text("🔔 ضبط تنبيه", "set_alert")
            .text("👁️ مراقبة الصفقات", "watch_trades").row()
            .text("⚙️ الإعدادات", "settings")
    });
});

bot.command("settings", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const settingsData = loadSettings();
    const settings = Array.isArray(settingsData) && settingsData.length > 0 ? settingsData[0] : settingsData;
    const isSummaryEnabled = settings ? settings.dailySummary : false;
    
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital")
        .text("📄 عرض التنبيهات", "view_alerts").row()
        .text("🗑️ حذف تنبيه", "delete_alert")
        .text(`📰 الملخص اليومي: ${isSummaryEnabled ? '✅' : '❌'}`, "toggle_summary");
        
    await ctx.reply("⚙️ *لوحة التحكم والإعدادات*:", { reply_markup: settingsKeyboard, parse_mode: "Markdown" });
});

bot.callbackQuery("toggle_summary", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;

    let settingsData = loadSettings();
    let settings = Array.isArray(settingsData) && settingsData.length > 0 ? settingsData[0] : { dailySummary: false };
    
    settings.dailySummary = !settings.dailySummary;
    
    saveSettings([settings]); // Save as an array with one object
    
    await ctx.answerCallbackQuery({ text: `تم ${settings.dailySummary ? 'تفعيل' : 'إيقاف'} الملخص اليومي ✅` });
    
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital")
        .text("📄 عرض التنبيهات", "view_alerts").row()
        .text("🗑️ حذف تنبيه", "delete_alert")
        .text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary");

    await ctx.editMessageReplyMarkup({ reply_markup: settingsKeyboard });
});


bot.callbackQuery("performance", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const history = loadHistory();
    
    if (history.length < 2) {
        return await ctx.reply("ℹ️ لا توجد بيانات كافية لعرض الأداء. يرجى الانتظار لمدة يومين على الأقل بعد تفعيل الملخص اليومي.");
    }

    const chartUrl = createChartUrl(history);
    const latest = history[history.length - 1]?.total || 0;
    const previous = history[history.length - 2]?.total || 0;
    const diff = latest - previous;
    const percent = previous > 0 ? (diff / previous) * 100 : 0;
    const summary = `*تغير آخر يوم:*\n${diff >= 0 ? '🟢' : '🔴'} $${diff.toFixed(2)} (${percent.toFixed(2)}%)`;

    await ctx.replyWithPhoto(chartUrl, {
        caption: `أداء محفظتك خلال الأيام الماضية.\n\n${summary}`,
        parse_mode: "Markdown"
    });
});


// ========== 🚀 تشغيل البوت (Bot Startup) =============
const app = express();
app.use(express.json());
app.use(webhookCallback(bot, "express"));

// دالة لبدء المهام بعد تشغيل السيرفر
async function startTasks() {
    console.log("🚀 Starting background tasks...");
    await runDailyJobs(); // تشغيل الملخص اليومي عند البدء
    alertsCheckInterval = setInterval(checkAlerts, 60000); // 🔔 تفقد التنبيهات كل دقيقة
    console.log("✅ Background tasks are now running.");
}

// تشغيل السيرفر والمهام
app.listen(8080, () => {
    console.log("✅ Bot server is running on port 8080");
    startTasks(); // استدعاء دالة المهام من هنا لضمان أن كل شيء تم تعريفه
});

// Handle graceful shutdown
process.once('SIGINT', () => {
    console.log("Stopping bot...");
    clearInterval(alertsCheckInterval);
    process.exit(0);
});
process.once('SIGTERM', () => {
    console.log("Stopping bot...");
    clearInterval(alertsCheckInterval);
    process.exit(0);
});

