// OKX Portfolio Bot with PnL, Capital Setting, Egypt TZ, Live Trade Notifications
// ** تم التعديل لاستخدام أزرار الرد الدائمة (ReplyKeyboard) **

const express = require("express");
// تم تغيير InlineKeyboard إلى Keyboard
const { Bot, Keyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();

const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";
const CAPITAL_FILE = "capital.json";
let lastTrades = {}; // لتتبع الصفقات وعدم التكرار
let waitingForCapital = false; // لتفعيل انتظار رأس المال بعد الضغط على الزر
let monitoringInterval = null; // لتخزين مؤشر المراقبة

// دالة للحصول على الوقت بتوقيت مصر
function getEgyptTime() {
    return new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" });
}

// دالة لحفظ رأس المال في ملف
function saveCapital(amount) {
    fs.writeFileSync(CAPITAL_FILE, JSON.stringify({ capital: amount }));
}

// دالة لتحميل رأس المال من ملف
function loadCapital() {
    try {
        if (fs.existsSync(CAPITAL_FILE)) {
            const data = JSON.parse(fs.readFileSync(CAPITAL_FILE));
            return data.capital;
        }
        return 0; // إذا لم يكن الملف موجودًا
    } catch {
        return 0;
    }
}

// دالة لإنشاء الترويسات المطلوبة لـ OKX API
function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + path + body;
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

// دالة لجلب بيانات المحفظة
async function getPortfolio() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, {
            headers: getHeaders("GET", "/api/v5/account/balance"),
        });
        const json = await res.json();

        if (json.code !== '0') {
             console.error("OKX API Error (Balance):", json.msg);
             return { assets: [], total: 0, error: `فشل جلب بيانات المحفظة: ${json.msg}` };
        }

        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();

        const prices = {};
        if (tickersJson.data) {
            tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last));
        }

        let assets = [];
        let total = 0;

        if (json.data && json.data[0] && json.data[0].details) {
            json.data[0].details.forEach(asset => {
                const amount = parseFloat(asset.eq);
                if (amount > 0) {
                    const instId = `${asset.ccy}-USDT`;
                    const price = prices[instId] || (asset.ccy === "USDT" ? 1 : 0);
                    const value = amount * price;
                    if (value >= 1) {
                        assets.push({
                            asset: asset.ccy,
                            price,
                            value,
                            amount,
                        });
                        total += value;
                    }
                }
            });
        }

        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (e) {
        console.error(e);
        return { assets: [], total: 0, error: "حدث خطأ غير متوقع عند الاتصال بالمنصة." };
    }
}

// دالة لتنسيق رسالة المحفظة
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

// دالة للتحقق من الصفقات الجديدة
async function checkNewTrades() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/positions`, {
            headers: getHeaders("GET", "/api/v5/account/positions"),
        });
        const json = await res.json();
        
        if (json.code !== '0') {
            console.error("OKX API Error (Positions):", json.msg);
            return;
        }

        if (json.data) {
            json.data.forEach(async trade => {
                const id = trade.instId + trade.posId;
                if (!lastTrades[id] && parseFloat(trade.pos) > 0) {
                    lastTrades[id] = true;
                    await bot.api.sendMessage(
                        AUTHORIZED_USER_ID,
                        `🚨 *تم كشف صفقة جديدة: ${trade.instId}*\n\n🪙 *الكمية:* ${trade.pos}\n💰 *القيمة الاسمية:* $${parseFloat(trade.notionalUsd).toFixed(2)}\n📈 *الاتجاه:* ${trade.posSide}`,
                        { parse_mode: "Markdown" }
                    );
                }
            });
        }
    } catch (e) {
        console.error("Error checking new trades:", e);
    }
}

// === الأوامر ومعالجات الأزرار ===

// الأمر /start لعرض لوحة المفاتيح الرئيسية
bot.command("start", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    
    // تم استخدام Keyboard هنا لإنشاء أزرار دائمة
    const mainKeyboard = new Keyboard()
        .text("📊 عرض المحفظة").row()
        .text("⚙️ تعيين رأس المال").row()
        .text("👁️ تشغيل مراقبة الصفقات")
        .text("🛑 إيقاف مراقبة الصفقات")
        .resized(); // .resized() يجعل الأزرار بحجم مناسب

    await ctx.reply(
        "🤖 *أهلاً بك في بوت مراقبة محفظة OKX*\n\n- اختر من الأزرار أدناه.",
        { 
            parse_mode: "Markdown",
            reply_markup: mainKeyboard 
        }
    );
});

// تم استبدال callbackQuery بـ hears لمعالجة ضغطات الأزرار
bot.hears("📊 عرض المحفظة", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply('⏳ لحظات... جار تحديث بيانات المحفظة.');
    const { assets, total, error } = await getPortfolio();
    if (error) {
        await ctx.reply(`❌ ${error}`);
        return;
    }
    const capital = loadCapital();
    const msg = formatPortfolioMsg(assets, total, capital);
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.hears("⚙️ تعيين رأس المال", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    waitingForCapital = true;
    await ctx.reply("💼 أرسل المبلغ الآن لتعيين رأس المال بالدولار، مثال: 5000");
});

bot.hears("👁️ تشغيل مراقبة الصفقات", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    if (!monitoringInterval) {
        await checkNewTrades(); // تحقق فوري عند التشغيل
        monitoringInterval = setInterval(checkNewTrades, 60000); // ثم كل دقيقة
        await ctx.reply("✅ تم تشغيل مراقبة الصفقات التلقائية.");
    } else {
        await ctx.reply("ℹ️ المراقبة تعمل بالفعل.");
    }
});

bot.hears("🛑 إيقاف مراقبة الصفقات", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
        await ctx.reply("🛑 تم إيقاف مراقبة الصفقات التلقائية.");
    } else {
        await ctx.reply("ℹ️ المراقبة متوقفة بالفعل.");
    }
});

// استقبال الرسائل العامة (فقط لتعيين رأس المال)
bot.on("message:text", async (ctx) => {
    // تجاهل إذا لم يكن المستخدم المصرح له أو إذا كانت رسالة من زر
    if (ctx.from.id !== AUTHORIZED_USER_ID || !waitingForCapital) {
        return;
    }

    const amount = parseFloat(ctx.message.text);
    if (!isNaN(amount) && amount > 0) {
        saveCapital(amount);
        waitingForCapital = false;
        await ctx.reply(`✅ تم تعيين رأس المال إلى: $${amount.toFixed(2)}`);
    } else {
        await ctx.reply("❌ المبلغ غير صالح. أرسل رقمًا موجبًا مثل: 5000");
    }
});

// === إعداد الخادم والويب هوك ===
app.use(express.json());
app.use(webhookCallback(bot, "express"));

app.listen(PORT, async () => {
    console.log(`✅ Bot running on port ${PORT}`);
    try {
        const domain = process.env.RAILWAY_STATIC_URL;
        if (domain) {
            const webhookUrl = `https://${domain}`;
            await bot.api.setWebhook(webhookUrl, {
                drop_pending_updates: true // لتجاهل الرسائل القديمة
            });
            console.log(`✅ Webhook set to: ${webhookUrl}`);
        } else {
            console.warn("RAILWAY_STATIC_URL not set. Webhook not configured. Bot might not work in serverless environment.");
        }
    } catch (e) {
        console.error("Failed to set webhook:", e);
    }
});

