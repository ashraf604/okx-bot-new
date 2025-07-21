// ✅ OKX Telegram Bot - Final Version (بعد التصحيح)

import { Bot, webhookCallback, InlineKeyboard } from "grammy"; import express from "express"; import fs from "fs"; import https from "https"; import { getPrices, getPortfolio } from "./utils/okx.js"; import { createChartUrl } from "./utils/chart.js";

const bot = new Bot(process.env.BOT_TOKEN); const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID); let alertsCheckInterval;

// ========== 📁 التخزين ============= const SETTINGS_PATH = "./data_settings.json"; const ALERTS_PATH = "./data_alerts.json"; const HISTORY_PATH = "./data_history.json"; const CAPITAL_PATH = "./data_capital.json";

function loadJSON(path) { if (!fs.existsSync(path)) return []; const raw = fs.readFileSync(path); return JSON.parse(raw); } function saveJSON(path, data) { fs.writeFileSync(path, JSON.stringify(data, null, 2)); } const loadSettings = () => loadJSON(SETTINGS_PATH); const saveSettings = (data) => saveJSON(SETTINGS_PATH, data); const loadAlerts = () => loadJSON(ALERTS_PATH); const saveAlerts = (data) => saveJSON(ALERTS_PATH, data); const loadHistory = () => loadJSON(HISTORY_PATH); const saveHistory = (data) => saveJSON(HISTORY_PATH, data); const loadCapital = () => { const data = loadJSON(CAPITAL_PATH); return data.length ? data[0].capital : 1000; }; const saveCapital = (amount) => saveJSON(CAPITAL_PATH, [{ capital: amount }]);

// ========== 🔔 التنبيهات ============= async function checkAlerts() { const alerts = loadAlerts(); const prices = await getPrices(); const notified = new Set();

for (const alert of alerts) {
    const currentPrice = prices[alert.symbol];
    if (!currentPrice) continue;

    const triggered = (
        (alert.condition === ">" && currentPrice > alert.price) ||
        (alert.condition === "<" && currentPrice < alert.price)
    );

    if (triggered && !notified.has(alert.id)) {
        notified.add(alert.id);
        await bot.api.sendMessage(
            AUTHORIZED_USER_ID,
            `🚨 *تنبيه سعر*\n${alert.symbol} ${alert.condition} ${alert.price}\n📉 السعر الحالي: $${currentPrice}`,
            { parse_mode: "Markdown" }
        );
    }
}

}

// ========== 📊 المهام اليومية ============= async function runDailyJobs() { const settings = loadSettings(); if (!settings.dailySummary) return; const { total, error } = await getPortfolio(); if (error) return console.error("Daily Summary Error:", error); const history = loadHistory(); const date = new Date().toISOString().slice(0, 10); if (history.length && history[history.length - 1].date === date) return; history.push({ date, total }); if (history.length > 30) history.shift(); saveHistory(history); console.log([✅ Daily Summary]: ${date} - $${total.toFixed(2)}); }

// ========== 🧠 الأوامر ============= bot.command("start", async (ctx) => { if (ctx.from.id !== AUTHORIZED_USER_ID) return; await ctx.reply("👋 مرحبًا بك في بوت OKX التحليلي. اختر أمرًا:", { reply_markup: new InlineKeyboard() .text("📊 المحفظة", "portfolio") .text("📈 أداء المحفظة", "performance").row() .text("🔔 ضبط تنبيه", "set_alert") .text("👁️ مراقبة الصفقات", "watch_trades").row() .text("⚙️ الإعدادات", "settings") }); });

bot.command("settings", async (ctx) => { if (ctx.from.id !== AUTHORIZED_USER_ID) return; const settings = loadSettings(); const settingsKeyboard = new InlineKeyboard() .text("💰 تعيين رأس المال", "set_capital") .text("📄 عرض التنبيهات", "view_alerts").row() .text("🗑️ حذف تنبيه", "delete_alert") .text(📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}, "toggle_summary"); await ctx.reply("⚙️ لوحة التحكم والإعدادات:", { reply_markup: settingsKeyboard }); });

bot.callbackQuery("toggle_summary", async (ctx) => { const settings = loadSettings(); settings.dailySummary = !settings.dailySummary; saveSettings(settings); await ctx.answerCallbackQuery({ text: تم ${settings.dailySummary ? 'تفعيل' : 'إيقاف'} الملخص اليومي ✅ }); await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() .text("💰 تعيين رأس المال", "set_capital") .text("📄 عرض التنبيهات", "view_alerts").row() .text("🗑️ حذف تنبيه", "delete_alert") .text(📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}, "toggle_summary") }); });

bot.callbackQuery("performance", async (ctx) => { const history = loadHistory(); const chartUrl = createChartUrl(history); if (chartUrl) { const latest = history[history.length - 1]?.total || 0; const previous = history[history.length - 2]?.total || 0; const diff = latest - previous; const percent = previous > 0 ? (diff / previous) * 100 : 0; const summary = 📈 *تغير اليوم الأخير:* ${diff >= 0 ? '🟢' : '🔴'} $${diff.toFixed(2)} (${percent.toFixed(2)}%); return await ctx.replyWithPhoto(chartUrl, { caption: أداء محفظتك خلال الأيام السبعة الماضية.\n\n${summary}, parse_mode: "Markdown" }); } else { return await ctx.reply("ℹ️ لا توجد بيانات كافية لعرض الرسم البياني. سيتم تجميع البيانات يوميًا."); } });

// ========== 🚀 تشغيل البوت ============= const app = express(); app.use(express.json()); app.use(webhookCallback(bot, "express"));

const server = app.listen(8080, () => { console.log("✅ Bot running on port 8080"); runDailyJobs(); alertsCheckInterval = setInterval(checkAlerts, 60000); // 🔔 تنبيهات كل دقيقة });
// ========== 🚀 تشغيل البوت =============
const app = express();
app.use(express.json());

// استخدام Webhook
app.use(webhookCallback(bot, "express"));

// دالة لبدء المهام بعد تشغيل السيرفر
async function startTasks() {
    console.log("🚀 Starting daily jobs and alert checks...");
    await runDailyJobs(); // تشغيل الملخص اليومي عند البدء
    alertsCheckInterval = setInterval(checkAlerts, 60000); // 🔔 تفقد التنبيهات كل دقيقة
    console.log("✅ Daily jobs and alerts are now running.");
}

// تشغيل السيرفر والمهام
app.listen(8080, () => {
    console.log("✅ Bot server is running on port 8080");
    startTasks(); // استدعاء دالة المهام من هنا
});
                                       
                          
