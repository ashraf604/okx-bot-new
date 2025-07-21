// =================================================================
// OKX Advanced Analytics Bot - v3 (Syntax Fixed & Organized)
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

// --- ملفات تخزين البيانات (داخل مجلد data) ---
const DATA_DIR = "./data";
const CAPITAL_FILE = `${DATA_DIR}/data_capital.json`;
const ALERTS_FILE = `${DATA_DIR}/data_alerts.json`;
const TRADES_FILE = `${DATA_DIR}/data_trades.json`;
const HISTORY_FILE = `${DATA_DIR}/data_history.json`;
const SETTINGS_FILE = `${DATA_DIR}/data_settings.json`;

// --- متغيرات الحالة والمؤشرات ---
let waitingState = null;
let tradeMonitoringInterval = null;
let alertsCheckInterval = null;
let dailyJobsInterval = null;

// === دوال مساعدة وإدارة الملفات ===

function readJsonFile(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return defaultValue;
    } catch (error) { console.error(`Error reading ${filePath}:`, error); return defaultValue; }
}

function writeJsonFile(filePath, data) {
    try {
        // تأكد من أن المجلد موجود قبل الكتابة
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR);
        }
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
const loadSettings = () => readJsonFile(SETTINGS_FILE, { dailySummary: false });
const saveSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);

// === دوال API ===

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

async function checkNewTrades(isManualTrigger = false) {
    try {
        if (isManualTrigger) {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, "🔍 جار التحقق من وجود صفقات جديدة...");
        }

        const path = "/api/v5/trade/orders-history?instType=SPOT&state=filled";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();

        if (json.code !== '0') {
            const errorMessage = `❌ فشل جلب سجل الصفقات من OKX.\nالسبب: ${json.msg || 'استجابة غير معروفة'}`;
            console.error(errorMessage);
            if (isManualTrigger) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, errorMessage);
            }
            return;
        }

        if (!json.data || json.data.length === 0) {
            if (isManualTrigger) {
                await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ لا توجد أي صفقات جديدة مكتملة في السجل الحديث.");
            }
            return;
        }

        const lastTrades = loadLastTrades();
        let newTradesFound = false;
        let notificationsSent = 0;

        for (const trade of json.data.reverse()) {
            if (!lastTrades[trade.ordId]) {
                newTradesFound = true;
                console.log(`[Trade Found]: New trade detected with ID: ${trade.ordId}`);

                const instId = trade.instId;
                const ccy = instId.split('-')[0];
                let side = trade.side === 'buy' ? 'شراء 🟢' : 'بيع 🔴';
                const avgPx = parseFloat(trade.avgPx);
                const sz = parseFloat(trade.sz);
                const fee = parseFloat(trade.fee);

                if (trade.side === 'sell') {
                    const balancePath = `/api/v5/account/balance?ccy=${ccy}`;
                    try {
                        const balanceRes = await fetch(`${API_BASE_URL}${balancePath}`, { headers: getHeaders("GET", balancePath) });
                        const balanceJson = await balanceRes.json();
                        let currentBalance = 0;
                        if (balanceJson.code === '0' && balanceJson.data[0]?.details[0]) {
                            currentBalance = parseFloat(balanceJson.data[0].details[0].availBal);
                        }
                        if (currentBalance < 0.0001) { side = 'بيع كلي 🔴'; } 
                        else { side = 'بيع جزئي 🔴'; }
                    } catch (e) {
                         console.error(`Error checking balance for ${ccy}, defaulting to 'بيع' side.`, e);
                         side = 'بيع 🔴';
                    }
                }

                let message = `🔔 *صفقة جديدة!* 🔔\n\n` +
                              `*${side}* - *${instId}*\n\n` +
                              `- *الكمية:* \`${sz}\`\n` +
                              `- *متوسط السعر:* \`$${avgPx.toFixed(5)}\`\n` +
                              `- *قيمة الصفقة:* \`$${(sz * avgPx).toFixed(2)}\`\n` +
                              `- *الرسوم:* \`$${fee.toFixed(4)}\` (${trade.feeCcy})\n`;

                if (parseFloat(trade.pnl) !== 0) {
                    message += `- *الربح/الخسارة المحقق:* \`$${parseFloat(trade.pnl).toFixed(2)}\`\n`;
                }
                
                message += `\n*ID:* \`${trade.ordId}\``;

                await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
                notificationsSent++;
                lastTrades[trade.ordId] = true;
            }
        }

        if (newTradesFound) {
            console.log(`[Trades Processed]: ${notificationsSent} new trade notifications sent.`);
            saveLastTrades(lastTrades);
            if (isManualTrigger && notificationsSent === 0) {
                 await bot.api.sendMessage(AUTHORIZED_USER_ID, "ℹ️ تم العثور على صفقات في السجل، ولكن تم إرسال إشعارات بها مسبقاً. لا يوجد جديد.");
            }
        } else if (isManualTrigger) {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, "✅ سجل الصفقات محدّث، لا يوجد أي جديد.");
        }

    } catch (error) {
        console.error("Error in checkNewTrades:", error);
        if (isManualTrigger) {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, `🚨 حدث خطأ فني أثناء التحقق من الصفقات. يرجى مراجعة سجلات الخادم.`);
        }
    }
}

async function checkAlerts() {
    const alerts = loadAlerts();
    if (alerts.length === 0) return;
    try {
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        if (tickersJson.code !== '0') return console.error("Failed to fetch tickers for alerts:", tickersJson.msg);
        const prices = {};
        tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last));
        const remainingAlerts = []; let alertsTriggered = false;
        for (const alert of alerts) {
            if (!alert.active || !prices[alert.instId]) { remainingAlerts.push(alert); continue; }
            const currentPrice = prices[alert.instId]; let triggered = false;
            if (alert.condition === '>' && currentPrice > alert.price) triggered = true;
            else if (alert.condition === '<' && currentPrice < alert.price) triggered = true;
            if (triggered) {
                const message = `🚨 *تنبيه سعر!* 🚨\n\n- العملة: *${alert.instId}*\n- الشرط: تحقق (${alert.condition} ${alert.price})\n- السعر الحالي: *${currentPrice}*`;
                await bot.api.sendMessage(AUTHORIZED_USER_ID, message, { parse_mode: "Markdown" });
                alertsTriggered = true;
            } else { remainingAlerts.push(alert); }
        }
        if (alertsTriggered) { saveAlerts(remainingAlerts); }
    } catch (error) { console.error("Error in checkAlerts:", error); }
}

async function runDailyJobs() {
    const settings = loadSettings();
    if (!settings.dailySummary) return;
    const { total, error } = await getPortfolio();
    if (error) return console.error("Daily Summary Error:", error);
    const history = loadHistory();
    const date = new Date().toISOString().slice(0, 10);
    if (history.length && history[history.length - 1].date === date) return;
    history.push({ date, total });
    if (history.length > 30) history.shift();
    saveHistory(history);
    console.log(`[✅ Daily Summary]: ${date} - $${total.toFixed(2)}`);
}

// === واجهة البوت والأوامر ===

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("🧮 حاسبة الربح والخسارة").row()
    .text("👁️ مراقبة الصفقات").text("⚙️ الإعدادات").resized();

bot.command("start", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    await ctx.reply("🤖 *بوت OKX التحليلي المتكامل*\n\n- أهلاً بك! الواجهة الرئيسية للوصول السريع، والإدارة الكاملة من قائمة /settings.", { parse_mode: "Markdown", reply_markup: mainKeyboard });
});

bot.command("settings", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const settings = loadSettings();
    const settingsKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").text("📄 عرض التنبيهات", "view_alerts").row()
        .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
        .text("🔥 حذف كل البيانات 🔥", "delete_all_data");
    await ctx.reply("⚙️ *لوحة التحكم والإعدادات*:", { parse_mode: "Markdown", reply_markup: settingsKeyboard });
});

bot.command("pnl", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const args = ctx.match.trim().split(/\s+/);

    if (args.length !== 3 || args[0] === '') {
        return await ctx.reply(
            "❌ *صيغة غير صحيحة.*\n\n" +
            "يرجى استخدام الصيغة التالية:\n" +
            "`/pnl <سعر الشراء> <سعر البيع> <الكمية>`\n\n" +
            "*مثال:*\n`/pnl 100 120 0.5`", { parse_mode: "Markdown" }
        );
    }

    const buyPrice = parseFloat(args[0]);
    const sellPrice = parseFloat(args[1]);
    const quantity = parseFloat(args[2]);

    if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) {
        return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم التي أدخلتها هي أرقام موجبة وصالحة.");
    }

    const totalInvestment = buyPrice * quantity;
    const totalSaleValue = sellPrice * quantity;
    const profitOrLoss = totalSaleValue - totalInvestment;
    const pnlPercentage = (profitOrLoss / totalInvestment) * 100;
    const resultStatus = profitOrLoss >= 0 ? "ربح ✅" : "خسارة 🔻";

    const responseMessage = `
*📊 نتيجة الحساب:*

- *إجمالي تكلفة الشراء:* \`$${totalInvestment.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\`
- *إجمالي قيمة البيع:* \`$${totalSaleValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\`

- *قيمة الربح/الخسارة:* \`$${profitOrLoss.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\`
- *نسبة الربح/الخسارة:* \`${pnlPercentage.toFixed(2)}%\`

*النتيجة النهائية: ${resultStatus}*
    `;
    await ctx.reply(responseMessage, { parse_mode: "Markdown" });
});

// === معالجات الأزرار المضمنة (Inline Keyboard) ===
bot.callbackQuery("set_capital", async (ctx) => { await ctx.answerCallbackQuery(); waitingState = 'set_capital'; await ctx.reply("💰 أرسل المبلغ الجديد لرأس المال."); });

bot.callbackQuery("view_alerts", async (ctx) => {
    await ctx.answerCallbackQuery();
    const alerts = loadAlerts();
    if (alerts.length === 0) return ctx.reply("ℹ️ لا توجد تنبيهات نشطة حاليًا.");
    let msg = "🔔 *قائمة التنبيهات النشطة:*\n\n";
    alerts.forEach(a => { msg += `- *ID:* \`${a.id}\`\n  العملة: ${a.instId}\n  الشرط: ${a.condition === '>' ? 'أعلى من' : 'أقل من'} ${a.price}\n\n`; });
    await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.callbackQuery("delete_alert", async (ctx) => { await ctx.answerCallbackQuery(); waitingState = 'delete_alert'; await ctx.reply("🗑️ أرسل ID التنبيه الذي تريد حذفه."); });

bot.callbackQuery("toggle_summary", async (ctx) => {
    const settings = loadSettings();
    settings.dailySummary = !settings.dailySummary;
    saveSettings(settings);
    await ctx.answerCallbackQuery({ text: `تم ${settings.dailySummary ? 'تفعيل' : 'إيقاف'} الملخص اليومي ✅` });
    const updatedKeyboard = new InlineKeyboard()
        .text("💰 تعيين رأس المال", "set_capital").text("📄 عرض التنبيهات", "view_alerts").row()
        .text("🗑️ حذف تنبيه", "delete_alert").text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
        .text("🔥 حذف كل البيانات 🔥", "delete_all_data");
    await ctx.editMessageReplyMarkup({ reply_markup: updatedKeyboard });
});

bot.callbackQuery("delete_all_data", async (ctx) => {
    await ctx.answerCallbackQuery();
    waitingState = 'confirm_delete_all';
    await ctx.reply("⚠️ هل أنت متأكد من حذف كل البيانات؟ هذا الإجراء لا يمكن التراجع عنه.\n\nأرسل كلمة `تأكيد` خلال 30 ثانية.", { parse_mode: "Markdown" });
    setTimeout(() => { if (waitingState === 'confirm_delete_all') { waitingState = null; } }, 30000);
});

// === المعالج الشامل للرسائل النصية ===
bot.on("message:text", async (ctx) => {
    if (ctx.from.id !== AUTHORIZED_USER_ID) return;
    const text = ctx.message.text.trim();

    // --- 1. التعامل مع الأوامر المباشرة (أزرار الواجهة الرئيسية) ---
    switch (text) {
        case "📊 عرض المحفظة":
            await ctx.reply('⏳ لحظات... جار تحديث بيانات المحفظة.');
            const { assets, total, error } = await getPortfolio();
            if (error) return await ctx.reply(`❌ ${error}`);
            const capital = loadCapital();
            const msg = formatPortfolioMsg(assets, total, capital);
            return await ctx.reply(msg, { parse_mode: "Markdown" });

        case "📈 أداء المحفظة":
            const history = loadHistory();
            if (history.length < 2) return await ctx.reply("ℹ️ لا توجد بيانات كافية. يرجى تفعيل الملخص اليومي والانتظار.");
            const chartUrl = createChartUrl(history);
            const latest = history[history.length - 1]?.total || 0;
            const previous = history[history.length - 2]?.total || 0;
            const diff = latest - previous;
            const percent = previous > 0 ? (diff / previous) * 100 : 0;
            const summary = `*تغير آخر يوم:*\n${diff >= 0 ? '🟢' : '🔴'} $${diff.toFixed(2)} (${percent.toFixed(2)}%)`;
            return await ctx.replyWithPhoto(chartUrl, { caption: `أداء محفظتك خلال الأيام السبعة الماضية.\n\n${summary}`, parse_mode: "Markdown" });

        case "ℹ️ معلومات عملة":
            waitingState = 'coin_info';
            return await ctx.reply("ℹ️ أرسل رمز العملة (مثال: BTC-USDT).");
        
        case "🧮 حاسبة الربح والخسارة":
            return await ctx.reply(
                "لحساب الربح أو الخسارة، استخدم الأمر `/pnl` بالشكل التالي:\n\n" +
                "`/pnl <سعر الشراء> <سعر البيع> <الكمية>`\n\n" +
                "*مثال:*\n`/pnl 100 120 0.5`",
                { parse_mode: "Markdown" }
            );

        case "🔔 ضبط تنبيه":
            waitingState = 'set_alert';
            return await ctx.reply("📝 *أرسل تفاصيل التنبيه:*\n`SYMBOL > PRICE` أو `SYMBOL < PRICE`", { parse_mode: "Markdown" });

        case "👁️ مراقبة الصفقات":
            if (!tradeMonitoringInterval) {
                await checkNewTrades(true); 
                tradeMonitoringInterval = setInterval(() => checkNewTrades(false), 60000); 
                return await ctx.reply("✅ تم تشغيل مراقبة الصفقات الجديدة. سيتم التحقق كل دقيقة.");
            } else {
                clearInterval(tradeMonitoringInterval);
                tradeMonitoringInterval = null;
                return await ctx.reply("🛑 تم إيقاف مراقبة الصفقات الجديدة.");
            }

        case "⚙️ الإعدادات":
            return bot.api.sendMessage(ctx.from.id, "/settings");
    }

    // --- 2. التعامل مع المدخلات بناءً على الحالة (waitingState) ---
    if (waitingState) {
        const state = waitingState;
        waitingState = null; 
        switch (state) {
            case 'set_capital':
                const amount = parseFloat(text);
                if (!isNaN(amount) && amount >= 0) {
                    saveCapital(amount); await ctx.reply(`✅ تم تحديث رأس المال إلى: $${amount.toFixed(2)}`);
                } else { await ctx.reply("❌ مبلغ غير صالح."); }
                break;
            case 'coin_info':
                const { error, ...details } = await getInstrumentDetails(text);
                if (error) { await ctx.reply(`❌ ${error}`); }
                else {
                    let msg = `*ℹ️ معلومات ${text.toUpperCase()}*\n\n`;
                    msg += `- *السعر الحالي:* \`$${details.price}\`\n`;
                    msg += `- *أعلى سعر (24س):* \`$${details.high24h}\`\n`;
                    msg += `- *أدنى سعر (24س):* \`$${details.low24h}\`\n`;
                    msg += `- *حجم التداول (24س):* \`${details.vol24h.toFixed(2)} ${text.split('-')[0]}\``;
                    await ctx.reply(msg, { parse_mode: "Markdown" });
                }
                break;
            case 'set_alert':
                const parts = text.trim().split(/\s+/);
                if (parts.length !== 3) {
                    await ctx.reply("❌ صيغة غير صحيحة. استخدم: `SYMBOL > PRICE`");
                    break;
                }

                const [instId, condition, priceStr] = parts;
                const price = parseFloat(priceStr);

                if (!['>', '<'].includes(condition) || isNaN(price)) {
                    await ctx.reply("❌ صيغة غير صحيحة. الشرط يجب أن يكون `>` أو `<` والسعر يجب أن يكون رقماً.");
                    break;
                }

                const alerts = loadAlerts();
                const newAlert = {
                    id: crypto.randomBytes(4).toString('hex'),
                    instId: instId.toUpperCase(),
                    condition: condition,
                    price: price,
                    active: true,
                    createdAt: new Date().toISOString()
                };
                alerts.push(newAlert);
                saveAlerts(alerts);
                await ctx.reply(`✅ تم ضبط التنبيه بنجاح!\nID: \`${newAlert.id}\`\nسيتم إعلامك عندما يصبح سعر ${newAlert.instId} ${newAlert.condition === '>' ? 'أعلى من' : 'أقل من'} ${newAlert.price}`);
                break;
            
            case 'delete_alert':
                const alertIdToDelete = text;
                const currentAlerts = loadAlerts();
                const filteredAlerts = currentAlerts.filter(a => a.id !== alertIdToDelete);
                if (currentAlerts.length === filteredAlerts.length) {
                    await ctx.reply(`❌ لم يتم العثور على تنبيه بالـ ID: \`${alertIdToDelete}\``);
                } else {
                    saveAlerts(filteredAlerts);
                    await ctx.reply(`✅ تم حذف التنبيه بالـ ID: \`${alertIdToDelete}\` بنجاح.`);
                }
                break;
            
            case 'confirm_delete_all':
                if (text.toLowerCase() === 'تأكيد') {
                    if (fs.existsSync(CAPITAL_FILE)) fs.unlinkSync(CAPITAL_FILE);
                    if (fs.existsSync(ALERTS_FILE)) fs.unlinkSync(ALERTS_FILE);
                    if (fs.existsSync(TRADES_FILE)) fs.unlinkSync(TRADES_FILE);
                    if (fs.existsSync(HISTORY_FILE)) fs.unlinkSync(HISTORY_FILE);
                    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
                    await ctx.reply("🔥 تم حذف جميع البيانات والإعدادات بنجاح.");
                } else {
                    await ctx.reply("🛑 تم إلغاء عملية الحذف.");
                }
                break;
        }
    }
});

// === بدء تشغيل البوت والمهام المجدولة ===
async function startBot() {
    try {
        console.log("Bot is starting...");
        
        // تأكد من وجود مجلد البيانات
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR);
            console.log("Created data directory.");
        }

        // بدء المهام المجدولة
        alertsCheckInterval = setInterval(checkAlerts, 60000); // كل دقيقة
        dailyJobsInterval = setInterval(runDailyJobs, 60 * 60 * 1000); // كل ساعة
        
        // بدء تشغيل الخادم لاستقبال الـ webhooks
        app.use(express.json());
        app.use(webhookCallback(bot, "express"));
        
        app.listen(PORT, () => {
            console.log(`Bot server listening on port ${PORT}`);
        });

        console.log("Bot started successfully.");
    } catch (error) {
        console.error("FATAL: Failed to start the bot.", error);
    }
}

startBot();

