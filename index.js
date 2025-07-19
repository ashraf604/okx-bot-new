// OKX Portfolio Bot with PnL, Alerts, Capital, Egypt TZ, Trade Notifications, Telegram Commands

const express = require("express");
const { Bot, webhookCallback } = require("grammy");
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
const ALERTS_FILE = "alerts.json";
let lastTrades = {};
let monitoring = false;
let waitingForCapital = false;

function getEgyptTime() {
    return new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" });
}

function saveCapital(amount) {
    fs.writeFileSync(CAPITAL_FILE, JSON.stringify({ capital: amount }));
}
function loadCapital() {
    try {
        const data = JSON.parse(fs.readFileSync(CAPITAL_FILE));
        return data.capital;
    } catch {
        return 0;
    }
}

function loadAlerts() {
    try {
        return JSON.parse(fs.readFileSync(ALERTS_FILE));
    } catch {
        return [];
    }
}
function saveAlerts(alerts) {
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts));
}

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

async function getPortfolio() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, {
            headers: getHeaders("GET", "/api/v5/account/balance"),
        });
        const json = await res.json();

        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();

        const prices = {};
        tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last));

        let assets = [];
        let total = 0;

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

        assets.sort((a, b) => b.value - a.value);
        return { assets, total };
    } catch (e) {
        console.error(e);
        return { assets: [], total: 0 };
    }
}

function formatPortfolioMsg(assets, total, capital) {
    let pnl = capital > 0 ? total - capital : 0;
    let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0;

    let msg = `📊 *ملخص المحفظة* 📊\n\n`;
    msg += `💰 *القيمة الحالية:* $${total.toFixed(2)}\n`;
    msg += `💼 *رأس المال الأساسي:* $${capital.toFixed(2)}\n`;
    msg += `📈 *PnL:* ${pnl >= 0 ? '🟢' : '🔴'} ${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\n`;
    msg += `------------------------------------\n`;

    assets.forEach(a => {
        let percent = ((a.value / total) * 100).toFixed(2);
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
        const res = await fetch(`${API_BASE_URL}/api/v5/account/positions`, {
            headers: getHeaders("GET", "/api/v5/account/positions"),
        });
        const json = await res.json();

        json.data.forEach(async trade => {
            const id = trade.instId + trade.posId;
            if (!lastTrades[id]) {
                lastTrades[id] = true;
                await bot.api.sendMessage(
                    AUTHORIZED_USER_ID,
                    `🚨 *صفقة جديدة: ${trade.instId}*\n🪙 كمية: ${trade.pos}\n💰 القيمة: ${trade.notional}\n📈 الجانب: ${trade.posSide}`,
                    { parse_mode: "Markdown" }
                );
            }
        });
    } catch (e) {
        console.error(e);
    }
}

async function checkAlerts() {
    const alerts = loadAlerts();
    if (alerts.length === 0) return;

    try {
        for (let alert of alerts) {
            const res = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${alert.symbol}-USDT`);
            const json = await res.json();
            const price = parseFloat(json.data[0].last);

            if ((alert.type === "above" && price >= alert.price) ||
                (alert.type === "below" && price <= alert.price)) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID,
                    `🔔 *تنبيه سعر*\n${alert.symbol}-USDT وصل إلى $${price} (${alert.type} $${alert.price})`,
                    { parse_mode: "Markdown" }
                );
                alerts.splice(alerts.indexOf(alert), 1);
                saveAlerts(alerts);
            }
        }
    } catch (e) {
        console.error(e);
    }
}

// الأوامر
bot.command("start", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply(
        `🤖 *أهلاً بك في بوت مراقبة محفظة OKX*\n\n` +
        `الأوامر المتاحة:\n` +
        `/balance - عرض المحفظة\n` +
        `/alert - إضافة تنبيه سعر\n` +
        `/view_alerts - عرض التنبيهات\n` +
        `/delete_alert - حذف تنبيه\n` +
        `/monitor - بدء مراقبة الصفقات\n` +
        `/stop_monitor - إيقاف المراقبة`,
        { parse_mode: "Markdown" }
    );
});

bot.command("balance", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const { assets, total } = await getPortfolio();
    const capital = loadCapital();
    const msg = formatPortfolioMsg(assets, total, capital);
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.command("alert", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply("🔔 أرسل التنبيه بالصيغ:\nBTC above 30000\nأو\nETH below 2500");
});

bot.command("view_alerts", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const alerts = loadAlerts();
    if (alerts.length === 0) return ctx.reply("🚫 لا يوجد تنبيهات حالية.");
    let msg = `📋 *قائمة التنبيهات:*\n`;
    alerts.forEach((a, i) => {
        msg += `${i + 1}. ${a.symbol} ${a.type} $${a.price}\n`;
    });
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.command("delete_alert", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply("✏️ أرسل رقم التنبيه الذي تريد حذفه.");
});

bot.command("monitor", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    if (!monitoring) {
        monitoring = setInterval(() => {
            checkNewTrades();
            checkAlerts();
        }, 60000);
        await ctx.reply("✅ تم تشغيل المراقبة التلقائية.");
    } else {
        await ctx.reply("✅ المراقبة تعمل بالفعل.");
    }
});

bot.command("stop_monitor", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    if (monitoring) {
        clearInterval(monitoring);
        monitoring = false;
        await ctx.reply("🛑 تم إيقاف المراقبة التلقائية.");
    } else {
        await ctx.reply("🛑 المراقبة غير مفعلة.");
    }
});

// التقاط رسائل لتعيين رأس المال أو إضافة التنبيهات
bot.on("message:text", async ctx => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;

    // تعيين رأس المال
    if (waitingForCapital) {
        const amount = parseFloat(ctx.message.text);
        if (!isNaN(amount) && amount > 0) {
            saveCapital(amount);
            waitingForCapital = false;
            await ctx.reply(`✅ تم تعيين رأس المال إلى: $${amount.toFixed(2)}`);
        } else {
            await ctx.reply("❌ المبلغ غير صالح، أرسل رقمًا مثل: 5000");
        }
        return;
    }

    // إضافة تنبيه
    const parts = ctx.message.text.split(" ");
    if (parts.length === 3) {
        const symbol = parts[0].toUpperCase();
        const type = parts[1].toLowerCase();
        const price = parseFloat(parts[2]);
        if ((type === "above" || type === "below") && !isNaN(price)) {
            const alerts = loadAlerts();
            alerts.push({ symbol, type, price });
            saveAlerts(alerts);
            await ctx.reply(`✅ تمت إضافة تنبيه: ${symbol} ${type} $${price}`);
        }
    }

    // حذف تنبيه
    if (!isNaN(ctx.message.text)) {
        const idx = parseInt(ctx.message.text) - 1;
        const alerts = loadAlerts();
        if (alerts[idx]) {
            alerts.splice(idx, 1);
            saveAlerts(alerts);
            await ctx.reply("✅ تم حذف التنبيه بنجاح.");
        } else {
            await ctx.reply("❌ رقم التنبيه غير صحيح.");
        }
    }
});

// تشغيل الخادم
app.use(express.json());
app.use(webhookCallback(bot, "express"));

app.listen(PORT, async () => {
    console.log(`✅ Bot running on port ${PORT}`);
    const domain = process.env.RAILWAY_STATIC_URL;
    if (domain) {
        await bot.api.setWebhook(`https://${domain}/${bot.token}`);
        console.log(`✅ Webhook set to: https://${domain}/${bot.token}`);
    }
});
