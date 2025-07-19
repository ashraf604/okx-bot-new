// OKX Portfolio Bot with Full Monitoring (Trades & Price Alerts)
// ** تم إصلاح خطأ 'uuid' باستبداله بوظيفة crypto المدمجة **

const express = require("express");
const { Bot, Keyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto"); // سنستخدم crypto لإنشاء ID
const fs = require("fs");
require("dotenv").config();

const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

// ملفات لتخزين البيانات
const CAPITAL_FILE = "capital.json";
const ALERTS_FILE = "alerts.json";
const TRADES_FILE = "last_trades.json";

// متغيرات لتتبع حالة المحادثة
let waitingForCapital = false;
let waitingForPrice = false;
let waitingForAlert = false;
let waitingForAlertDeletion = false;

// متغيرات لتخزين المؤشرات
let tradeMonitoringInterval = null;
let alertsCheckInterval = null;

// === دوال مساعدة ===

function getEgyptTime() {
    return new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" });
}

function saveCapital(amount) {
    fs.writeFileSync(CAPITAL_FILE, JSON.stringify({ capital: amount }));
}

function loadCapital() {
    try {
        if (fs.existsSync(CAPITAL_FILE)) return JSON.parse(fs.readFileSync(CAPITAL_FILE)).capital;
        return 0;
    } catch { return 0; }
}

function loadAlerts() {
    try {
        if (fs.existsSync(ALERTS_FILE)) return JSON.parse(fs.readFileSync(ALERTS_FILE));
        return [];
    } catch { return []; }
}

function saveAlerts(alerts) {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
}

function loadLastTrades() {
    try {
        if (fs.existsSync(TRADES_FILE)) return JSON.parse(fs.readFileSync(TRADES_FILE));
        return {};
    } catch { return {}; }
}

function saveLastTrades(trades) {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
}

function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + path + (typeof body === 'object' ? JSON.stringify(body) : body);
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY)
        .update(prehash)
        .digest("base64");

    return {
        "OK-ACCESS-KEY": process.env.OKX_API_KEY,
        "OK-ACCESS-SIGN": sign,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
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

async function getTickerPrice(instId) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`);
        const json = await res.json();
        if (json.code !== '0' || !json.data[0]) return { error: `لم يتم العثور على العملة.` };
        return { price: parseFloat(json.data[0].last) };
    } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; }
}

// === دوال المراقبة والتنبيهات ===

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
    msg += `🕒 *آخر تحديث:* ${getEgyptTime()}`;
    return msg;
}

async function checkNewTrades() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/positions`, { headers: getHeaders("GET", "/api/v5/account/positions") });
        const json = await res.json();
        if (json.code !== '0') { console.error("OKX API Error (Positions):", json.msg); return; }
        const lastTrades = loadLastTrades();
        if (json.data) {
            json.data.forEach(async trade => {
                const id = trade.instId + trade.posId;
                if (!lastTrades[id] && parseFloat(trade.pos) > 0) {
                    lastTrades[id] = true;
                    await bot.api.sendMessage(AUTHORIZED_USER_ID, `🚨 *تم كشف صفقة جديدة: ${trade.instId}*\n\n🪙 *الكمية:* ${trade.pos}\n💰 *القيمة الاسمية:* $${parseFloat(trade.notionalUsd).toFixed(2)}\n📈 *الاتجاه:* ${trade.posSide}`, { parse_mode: "Markdown" });
                }
            });
            saveLastTrades(lastTrades);
        }
    } catch (e) { console.error("Error checking new trades:", e); }
}

async function checkAlerts() {
    const alerts = loadAlerts().filter(a => a.active);
    if (alerts.length === 0) return;
    const uniqueInstIds = [...new Set(alerts.map(a => a.instId))];
    for (const instId of uniqueInstIds) {
        const { price: currentPrice, error } = await getTickerPrice(instId);
        if (error) continue;
        alerts.filter(a => a.instId === instId).forEach(async (alert) => {
            const targetPrice = alert.price;
            let conditionMet = false;
            if (alert.condition === '>' && currentPrice > targetPrice) conditionMet = true;
            else if (alert.condition === '<' && currentPrice < targetPrice) conditionMet = true;
            if (conditionMet) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, `🔔 *تنبيه سعر!* 🔔\n\n- العملة: *${alert.instId}*\n- الشرط: وصل السعر *${alert.condition === '>' ? 'أعلى من' : 'أقل من'} ${targetPrice}*\n- السعر الحالي: *${currentPrice}*`, { parse_mode: "Markdown" });
                const allAlerts = loadAlerts();
                const alertIndex = allAlerts.findIndex(a => a.id === alert.id);
                if (alertIndex !== -1) {
                    allAlerts[alertIndex].active = false;
                    saveAlerts(allAlerts);
                }
            }
        });
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

// === واجهة البوت والأوامر ===

bot.command("start", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const mainKeyboard = new Keyboard()
        .text("📊 عرض المحفظة").row()
        .text("👁️ تشغيل مراقبة الصفقات").text("🛑 إيقاف مراقبة الصفقات").row()
        .text("🔔 ضبط تنبيه سعر").text("📄 عرض التنبيهات").text("🗑️ حذف تنبيه").row()
        .text("📈 سعر عملة").text("⚙️ تعيين رأس المال").resized();
    await ctx.reply("🤖 *بوت OKX للمراقبة الشاملة*\n\n- تم إصلاح الخطأ وجاهز للعمل.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

// معالجات الأزرار
bot.hears("📊 عرض المحفظة", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply('⏳ لحظات... جار تحديث بيانات المحفظة.');
    const { assets, total, error } = await getPortfolio();
    if (error) return await ctx.reply(`❌ ${error}`);
    const capital = loadCapital();
    const msg = formatPortfolioMsg(assets, total, capital);
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.hears("⚙️ تعيين رأس المال", (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    waitingForCapital = true; waitingForPrice = waitingForAlert = waitingForAlertDeletion = false;
    ctx.reply("💼 أرسل المبلغ الآن لتعيين رأس المال.");
});

bot.hears("📈 سعر عملة", (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    waitingForPrice = true; waitingForCapital = waitingForAlert = waitingForAlertDeletion = false;
    ctx.reply("📈 أرسل رمز العملة (مثال: BTC-USDT).");
});

bot.hears("👁️ تشغيل مراقبة الصفقات", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    if (!tradeMonitoringInterval) {
        await checkNewTrades();
        tradeMonitoringInterval = setInterval(checkNewTrades, 60000);
        await ctx.reply("✅ تم تشغيل مراقبة الصفقات الجديدة.");
    } else {
        await ctx.reply("ℹ️ مراقبة الصفقات تعمل بالفعل.");
    }
});

bot.hears("🛑 إيقاف مراقبة الصفقات", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    if (tradeMonitoringInterval) {
        clearInterval(tradeMonitoringInterval);
        tradeMonitoringInterval = null;
        await ctx.reply("🛑 تم إيقاف مراقبة الصفقات الجديدة.");
    } else {
        await ctx.reply("ℹ️ مراقبة الصفقات متوقفة بالفعل.");
    }
});

bot.hears("🔔 ضبط تنبيه سعر", (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    waitingForAlert = true; waitingForCapital = waitingForPrice = waitingForAlertDeletion = false;
    ctx.reply("📝 *أرسل تفاصيل التنبيه بالصيغة التالية:*\n`SYMBOL > PRICE` أو `SYMBOL < PRICE`\n\n*أمثلة:*\n- `BTC-USDT > 65000`\n- `ETH-USDT < 3000`", { parse_mode: "Markdown" });
});

bot.hears("📄 عرض التنبيهات", (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const alerts = loadAlerts().filter(a => a.active);
    if (alerts.length === 0) return ctx.reply("ℹ️ لا توجد تنبيهات نشطة حاليًا.");
    let msg = "🔔 *قائمة التنبيهات النشطة:*\n\n";
    alerts.forEach(a => {
        msg += `- *ID:* \`${a.id}\`\n  العملة: ${a.instId}\n  الشرط: ${a.condition === '>' ? 'أعلى من' : 'أقل من'} ${a.price}\n\n`;
    });
    ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.hears("🗑️ حذف تنبيه", (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    waitingForAlertDeletion = true; waitingForCapital = waitingForPrice = waitingForAlert = false;
    ctx.reply("🗑️ أرسل `ID` التنبيه الذي تريد حذفه.");
});

// المعالج الرئيسي للرسائل النصية
bot.on("message:text", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const buttonCommands = ["📊 عرض المحفظة", "⚙️ تعيين رأس المال", "📈 سعر عملة", "🔔 ضبط تنبيه سعر", "📄 عرض التنبيهات", "🗑️ حذف تنبيه", "👁️ تشغيل مراقبة الصفقات", "🛑 إيقاف مراقبة الصفقات"];
    if (buttonCommands.includes(ctx.message.text)) return;

    if (waitingForCapital) {
        const amount = parseFloat(ctx.message.text);
        if (!isNaN(amount) && amount > 0) {
            saveCapital(amount); await ctx.reply(`✅ تم تعيين رأس المال إلى: $${amount.toFixed(2)}`);
        } else { await ctx.reply("❌ مبلغ غير صالح."); }
        waitingForCapital = false; return;
    }

    if (waitingForPrice) {
        const instId = ctx.message.text;
        const { price, error } = await getTickerPrice(instId);
        if (error) { await ctx.reply(`❌ ${error}`); }
        else { await ctx.reply(`📈 *السعر الحالي لـ ${instId.toUpperCase()}:* \`$${price}\``, { parse_mode: "Markdown" }); }
        waitingForPrice = false; return;
    }

    if (waitingForAlert) {
        const [instId, condition, priceStr] = ctx.message.text.split(" ");
        const price = parseFloat(priceStr);
        if (!instId || !condition || !priceStr || !['>', '<'].includes(condition) || isNaN(price)) {
            await ctx.reply("❌ صيغة غير صحيحة. يرجى استخدام الصيغة: `SYMBOL > PRICE`");
        } else {
            const alerts = loadAlerts();
            const newAlert = {
                id: crypto.randomUUID().split('-')[0], // ** هذا هو الإصلاح **
                instId: instId.toUpperCase(), condition, price, active: true, createdAt: new Date().toISOString()
            };
            alerts.push(newAlert);
            saveAlerts(alerts);
            await ctx.reply(`✅ تم ضبط التنبيه بنجاح!\nسأقوم بإعلامك عندما يصبح سعر ${newAlert.instId} ${condition} ${newAlert.price}.`);
        }
        waitingForAlert = false; return;
    }

    if (waitingForAlertDeletion) {
        const alertId = ctx.message.text.trim();
        const alerts = loadAlerts();
        const alertIndex = alerts.findIndex(a => a.id === alertId);
        if (alertIndex === -1) { await ctx.reply("❌ لم يتم العثور على تنبيه بهذا الـ ID."); }
        else {
            alerts.splice(alertIndex, 1);
            saveAlerts(alerts);
            await ctx.reply(`✅ تم حذف التنبيه \`${alertId}\` بنجاح.`);
        }
        waitingForAlertDeletion = false; return;
    }
});

// إعداد الخادم والويب هوك
app.use(express.json());
app.use(webhookCallback(bot, "express"));

app.listen(PORT, async () => {
    console.log(`✅ Bot running on port ${PORT}`);
    if (!alertsCheckInterval) {
        alertsCheckInterval = setInterval(checkAlerts, 60000);
        console.log("✅ Price alert checker started.");
    }
    try {
        const domain = process.env.RAILWAY_STATIC_URL || process.env.RENDER_EXTERNAL_URL;
        if (domain) {
            const webhookUrl = `https://${domain}`;
            await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
            console.log(`✅ Webhook set to: ${webhookUrl}`);
        } else { console.warn("Webhook URL not found."); }
    } catch (e) { console.error("Failed to set webhook:", e); }
});

                
