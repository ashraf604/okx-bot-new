// =================================================================
// OKX Advanced Analytics Bot - Final Stable Architecture v2
// This version includes robust, diagnostic error handling for the
// getPortfolio function to solve the silent failure issue.
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
let waitingState = null;
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

// === دوال جلب البيانات من OKX (مع تشخيص أخطاء مُحسَّن) ===

async function getPortfolio() {
    try {
        // 1. جلب رصيد الحساب
        const balanceRes = await fetch(`${API_BASE_URL}/api/v5/account/balance`, { headers: getHeaders("GET", "/api/v5/account/balance") });
        if (!balanceRes.ok) {
            return { error: `فشل الاتصال بالمنصة (Balance API). Status: ${balanceRes.status}` };
        }
        const balanceJson = await balanceRes.json();
        console.log("OKX Balance API Response:", JSON.stringify(balanceJson)); // تسجيل الرد الخام للتشخيص
        if (balanceJson.code !== '0') {
            return { error: `خطأ من منصة OKX: ${balanceJson.msg}\n\n*تلميح:* تأكد من أن مفتاح API لديه صلاحية القراءة (Read).` };
        }
        if (!balanceJson.data || !balanceJson.data[0] || !balanceJson.data[0].details) {
            return { error: "رد غير متوقع من المنصة (بيانات الرصيد فارغة)." };
        }

        // 2. جلب أسعار العملات
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        if (!tickersRes.ok) {
            return { error: `فشل الاتصال بالمنصة (Tickers API). Status: ${tickersRes.status}` };
        }
        const tickersJson = await tickersRes.json();
        const prices = {};
        if (tickersJson.data) {
            tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last));
        }

        // 3. معالجة وتجميع البيانات
        let assets = [], total = 0;
        balanceJson.data[0].details.forEach(asset => {
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
        return { assets, total, error: null }; // إرجاع البيانات بنجاح

    } catch (e) {
        console.error("Critical Error in getPortfolio:", e);
        return { error: `حدث خطأ فني حرج أثناء جلب البيانات: ${e.message}` };
    }
}

// === دوال العرض والمهام المجدولة ===
function formatPortfolioMsg(assets, total, capital) {
    if (assets.length === 0) {
        return "ℹ️ لا توجد أصول في محفظتك حاليًا تزيد قيمتها عن 1$.";
    }
    // ... بقية الكود كما هو
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
// ... باقي الدوال كما هي

// === واجهة البوت والأوامر ===
// ... الكود كما هو

// === معالجات الأوامر المباشرة (من الأزرار) ===

bot.hears("📊 عرض المحفظة", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    try {
        await ctx.reply('⏳ لحظات... جار تحديث بيانات المحفظة.');
        const { assets, total, error } = await getPortfolio();
        
        if (error) {
            return await ctx.reply(`❌ *فشل تحديث المحفظة:*\n\n${error}`, { parse_mode: "Markdown" });
        }
        
        const capital = loadCapital();
        const msg = formatPortfolioMsg(assets, total, capital);
        await ctx.reply(msg, { parse_mode: "Markdown" });

    } catch (e) {
        console.error("Error in 'عرض المحفظة' handler:", e);
        await ctx.reply("❌ حدث خطأ غير متوقع أثناء معالجة طلبك.");
    }
});

// ... باقي المعالجات كما هي

// === بدء تشغيل الخادم والمهام المجدولة ===
// ... الكود كما هو

