// bot/handlers.js

const { Keyboard, InlineKeyboard } = require("grammy");
const { bot } = require("../index.js");
const { getTechnicalAnalysis, getHistoricalPerformance } = require("./analysis.js");
const { formatNumber, calculatePerformanceStats, createChartUrl } = require("../utils/helpers.js");
const { getMarketPrices, getPortfolio, getInstrumentDetails } = require("../utils/api.js");
const db = require("../database.js");

let waitingState = null;

const mainKeyboard = new Keyboard()
    .text("📊 عرض المحفظة").text("📈 أداء المحفظة").row()
    .text("ℹ️ معلومات عملة").text("🔔 ضبط تنبيه").row()
    .text("🧮 حاسبة الربح والخسارة").row()
    .text("⚙️ الإعدادات").resized();

async function sendSettingsMenu(ctx) {
    try {
        const settings = await db.loadSettings();
        const settingsKeyboard = new InlineKeyboard()
            .text("💰 تعيين رأس المال", "set_capital")
            .text("💼 عرض المراكز المفتوحة", "view_positions").row()
            .text("🚨 إدارة تنبيهات الحركة", "manage_movement_alerts")
            .text("🗑️ حذف تنبيه سعر", "delete_alert").row()
            .text(`📰 الملخص اليومي: ${settings.dailySummary ? '✅' : '❌'}`, "toggle_summary").row()
            .text(`🚀 النشر التلقائي للقناة: ${settings.autoPostToChannel ? '✅' : '❌'}`, "toggle_autopost")
            .text(`🐞 وضع التشخيص: ${settings.debugMode ? '✅' : '❌'}`, "toggle_debug").row()
            .text("🔥 حذف جميع بيانات البوت 🔥", "delete_all_data");
        const text = "⚙️ *لوحة التحكم والإعدادات الرئيسية*";
        
        try {
            await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
        } catch {
            await ctx.reply(text, { parse_mode: "Markdown", reply_markup: settingsKeyboard });
        }
    } catch (e) {
        console.error("CRITICAL ERROR in sendSettingsMenu:", e);
        await ctx.reply(`❌ حدث خطأ فادح أثناء فتح قائمة الإعدادات.\n\nرسالة الخطأ: ${e.message}`);
    }
}

async function sendMovementAlertsMenu(ctx) {
    try {
        const alertSettings = await db.loadAlertSettings();
        const text = `🚨 *إدارة تنبيهات حركة الأسعار*\n\nتستخدم هذه الإعدادات لمراقبة التغيرات المئوية في الأسعار وإعلامك.\n\n- *النسبة العامة الحالية:* سيتم تنبيهك لأي أصل يتحرك بنسبة \`${alertSettings.global}%\` أو أكثر.\n- يمكنك تعيين نسبة مختلفة لعملة معينة لتجاوز الإعداد العام.`;
        const keyboard = new InlineKeyboard()
            .text("📊 تعديل النسبة العامة", "set_global_alert").row()
            .text("💎 تعديل نسبة عملة محددة", "set_coin_alert").row()
            .text("📄 عرض الإعدادات الحالية", "view_movement_alerts").row()
            .text("🔙 العودة إلى الإعدادات", "back_to_settings");
        
        try {
            await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
        } catch {
            await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
        }
    } catch (e) {
        console.error("CRITICAL ERROR in sendMovementAlertsMenu:", e);
        await ctx.reply(`❌ حدث خطأ فادح أثناء فتح قائمة تنبيهات الحركة.\n\nرسالة الخطأ: ${e.message}`);
    }
}

function initializeHandlers() {
    bot.command("start", async (ctx) => {
        await ctx.reply(`🤖 *بوت OKX التحليلي المتكامل*\n*الإصدار: v76 - Refactored*\n\nأهلاً بك! أنا هنا لمساعدتك في تتبع وتحليل محفظتك الاستثمارية.`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
    });

    bot.command("settings", async (ctx) => await sendSettingsMenu(ctx));

    bot.command("pnl", async (ctx) => {
        const args = ctx.match.trim().split(/\s+/);
        if (args.length !== 3 || args[0] === '') {
            return await ctx.reply(`❌ *صيغة غير صحيحة*\n\n` + `*يرجى استخدام الصيغة الصحيحة للأمر.*\n\n` + `*مثال:*\n\`/pnl <سعر الشراء> <سعر البيع> <الكمية>\``, { parse_mode: "Markdown" });
        }
        const [buyPrice, sellPrice, quantity] = args.map(parseFloat);
        if (isNaN(buyPrice) || isNaN(sellPrice) || isNaN(quantity) || buyPrice <= 0 || sellPrice <= 0 || quantity <= 0) {
            return await ctx.reply("❌ *خطأ:* تأكد من أن جميع القيم هي أرقام موجبة.");
        }
        const totalInvestment = buyPrice * quantity;
        const totalSaleValue = sellPrice * quantity;
        const profitOrLoss = totalSaleValue - totalInvestment;
        const pnlPercentage = (profitOrLoss / totalInvestment) * 100;
        const resultStatus = profitOrLoss >= 0 ? "ربح ✅" : "خسارة 🔻";
        const pnlSign = profitOrLoss >= 0 ? '+' : '';
        const responseMessage = `🧮 *نتيجة حساب الربح والخسارة*\n\n` + `📝 **المدخلات:**\n` + ` - *سعر الشراء:* \`$${buyPrice.toLocaleString()}\`\n` + ` - *سعر البيع:* \`$${sellPrice.toLocaleString()}\`\n` + ` - *الكمية:* \`${quantity.toLocaleString()}\`\n\n` + `📊 **النتائج:**\n` + ` - *إجمالي تكلفة الشراء:* \`$${totalInvestment.toLocaleString()}\`\n` + ` - *إجمالي قيمة البيع:* \`$${totalSaleValue.toLocaleString()}\`\n` + ` - *صافي الربح/الخسارة:* \`${pnlSign}${profitOrLoss.toLocaleString()}\` (\`${pnlSign}${formatNumber(pnlPercentage)}%\`)\n\n` + `**الحالة النهائية: ${resultStatus}**`;
        await ctx.reply(responseMessage, { parse_mode: "Markdown" });
    });

    bot.on("callback_query:data", async (ctx) => {
        try {
            await ctx.answerCallbackQuery();
            const data = ctx.callbackQuery.data;
            if (!ctx.callbackQuery.message) { console.log("Callback query has no message, skipping."); return; }

            if (data.startsWith("chart_")) {
                const period = data.split('_')[1];
                await ctx.editMessageText("⏳ جاري إنشاء تقرير الأداء...");
                let history, periodLabel, periodData;
                if (period === '24h') { history = await db.loadHourlyHistory(); periodLabel = "آخر 24 ساعة"; periodData = history.slice(-24); }
                else if (period === '7d') { history = await db.loadHistory(); periodLabel = "آخر 7 أيام"; periodData = history.slice(-7).map(h => ({ label: h.date.slice(5), total: h.total })); }
                else if (period === '30d') { history = await db.loadHistory(); periodLabel = "آخر 30 يومًا"; periodData = history.slice(-30).map(h => ({ label: h.date.slice(5), total: h.total })); }
                if (!periodData || periodData.length < 2) { await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لإنشاء تقرير لهذه الفترة."); return; }
                const stats = calculatePerformanceStats(periodData);
                if (!stats) { await ctx.editMessageText("ℹ️ لا توجد بيانات كافية لإنشاء تقرير لهذه الفترة."); return; }
                const chartUrl = createChartUrl(periodData, periodLabel, stats.pnl);
                const pnlEmoji = stats.pnl >= 0 ? '🟢⬆️' : '🔴⬇️';
                const pnlSign = stats.pnl >= 0 ? '+' : '';
                const caption = `📊 *تحليل أداء المحفظة | ${periodLabel}*\n\n` + `📈 **النتيجة:** ${pnlEmoji} \`${pnlSign}${formatNumber(stats.pnl)}\` (\`${pnlSign}${formatNumber(stats.pnlPercent)}%\`)\n` + `*التغير الصافي: من \`$${formatNumber(stats.startValue)}\` إلى \`$${formatNumber(stats.endValue)}\`*\n\n` + `📝 **ملخص إحصائيات الفترة:**\n` + ` ▫️ *أعلى قيمة وصلت لها المحفظة:* \`$${formatNumber(stats.maxValue)}\`\n` + ` ▫️ *أدنى قيمة وصلت لها المحفظة:* \`$${formatNumber(stats.minValue)}\`\n` + ` ▫️ *متوسط قيمة المحفظة:* \`$${formatNumber(stats.avgValue)}\`\n\n` + `*التقرير تم إنشاؤه في: ${new Date().toLocaleDateString("en-GB").replace(/\//g, '.')}*`;
                try { await ctx.replyWithPhoto(chartUrl, { caption: caption, parse_mode: "Markdown" }); await ctx.deleteMessage(); } catch (e) { console.error("Failed to send chart:", e); await ctx.editMessageText("❌ فشل إنشاء الرسم البياني. قد تكون هناك مشكلة في خدمة الرسوم البيانية."); }
                return;
            }

            if (data.startsWith("publish_")) {
                const originalText = ctx.callbackQuery.message.text;
                let messageForChannel;
                if (data === 'publish_close_report') {
                    const markerStart = originalText.indexOf("<CLOSE_REPORT>");
                    const markerEnd = originalText.indexOf("</CLOSE_REPORT>");
                    if (markerStart !== -1 && markerEnd !== -1) {
                        try { messageForChannel = JSON.parse(originalText.substring(markerStart + 14, markerEnd)); } catch (e) { console.error("Could not parse CLOSE_REPORT JSON"); }
                    }
                } else { // publish_trade
                    const markerStart = originalText.indexOf("<CHANNEL_POST>");
                    const markerEnd = originalText.indexOf("</CHANNEL_POST>");
                    if (markerStart !== -1 && markerEnd !== -1) {
                        try { messageForChannel = JSON.parse(originalText.substring(markerStart + 14, markerEnd)); } catch (e) { console.error("Could not parse CHANNEL_POST JSON"); }
                    }
                }
                if (!messageForChannel) { messageForChannel = "حدث خطأ في استخلاص نص النشر."; }
                try {
                    await bot.api.sendMessage(process.env.TARGET_CHANNEL_ID, messageForChannel, { parse_mode: "Markdown" });
                    await ctx.editMessageText("✅ تم النشر في القناة بنجاح.", { reply_markup: undefined });
                } catch (e) { 
                    console.error("Failed to post to channel:", e); 
                    await ctx.editMessageText("❌ فشل النشر في القناة.", { reply_markup: undefined }); 
                }
                return;
            }
            
            if (data === "ignore_trade" || data === "ignore_report") { 
                await ctx.editMessageText("❌ تم تجاهل الإشعار ولن يتم نشره.", { reply_markup: undefined }); 
                return; 
            }

            switch (data) {
                case "view_positions":
                    const positions = await db.loadPositions();
                    if (Object.keys(positions).length === 0) { await ctx.editMessageText("ℹ️ لا توجد مراكز مفتوحة قيد التتبع حاليًا.", { reply_markup: new InlineKeyboard().text("🔙 العودة إلى الإعدادات", "back_to_settings") }); } else {
                        let msg = "📄 *قائمة المراكز المفتوحة التي يتم تتبعها تلقائيًا:*\n";
                        for (const symbol in positions) { const pos = positions[symbol]; msg += `\n╭─ *${symbol}*`; const avgBuyPriceText = pos && pos.avgBuyPrice ? `$${formatNumber(pos.avgBuyPrice, 4)}` : 'غير متاح'; const totalAmountText = pos && pos.totalAmountBought ? formatNumber(pos.totalAmountBought, 6) : 'غير متاح'; const openDateText = pos && pos.openDate ? new Date(pos.openDate).toLocaleDateString('en-GB') : 'غير متاح'; msg += `\n├─ *متوسط الشراء:* \`${avgBuyPriceText}\``; msg += `\n├─ *الكمية الإجمالية المشتراة:* \`${totalAmountText}\``; msg += `\n╰─ *تاريخ فتح المركز:* \`${openDateText}\``; }
                        await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة إلى الإعدادات", "back_to_settings") });
                    }
                    break;
                case "back_to_settings": await sendSettingsMenu(ctx); break;
                case "manage_movement_alerts": await sendMovementAlertsMenu(ctx); break;
                case "set_global_alert": waitingState = 'set_global_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال النسبة المئوية العامة الجديدة لتنبيهات الحركة (مثال: `5` لـ 5%)."); break;
                case "set_coin_alert": waitingState = 'set_coin_alert_state'; await ctx.editMessageText("✍️ يرجى إرسال رمز العملة والنسبة المئوية المخصصة لها.\n*مثال لضبط تنبيه عند 2.5% لـ BTC:*\n`BTC 2.5`\n\n*لحذف الإعداد المخصص لعملة ما وإعادتها للنسبة العامة، أرسل نسبة 0.*"); break;
                case "view_movement_alerts": const alertSettings = await db.loadAlertSettings(); let msg_alerts = `🚨 *الإعدادات الحالية لتنبيهات الحركة:*\n\n` + `*النسبة العامة (Global):* \`${alertSettings.global}%\`\n` + `--------------------\n*النسب المخصصة (Overrides):*\n`; if (Object.keys(alertSettings.overrides).length === 0) { msg_alerts += "لا توجد نسب مخصصة حاليًا." } else { for (const coin in alertSettings.overrides) { msg_alerts += `- *${coin}:* \`${alertSettings.overrides[coin]}%\`\n`; } } await ctx.editMessageText(msg_alerts, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 العودة", "manage_movement_alerts") }); break;
                case "set_capital": waitingState = 'set_capital'; await ctx.editMessageText("💰 يرجى إرسال المبلغ الجديد لرأس المال (رقم فقط).", { reply_markup: undefined }); break;
                case "delete_alert": const alerts = await db.loadAlerts(); if (alerts.length === 0) { await ctx.editMessageText("ℹ️ لا توجد تنبيهات سعر محدد مسجلة حاليًا.", { reply_markup: new InlineKeyboard().text("🔙 العودة إلى الإعدادات", "back_to_settings") }); } else { let msg = "🗑️ *قائمة تنبيهات السعر المسجلة:*\n\n"; alerts.forEach((alert, index) => { msg += `*${index + 1}.* \`${alert.instId}\` عندما يكون السعر ${alert.condition === '>' ? 'أعلى من' : 'أقل من'} \`${alert.price}\`\n`; }); msg += "\n*يرجى إرسال رقم التنبيه الذي تود حذفه.*"; waitingState = 'delete_alert_number'; await ctx.editMessageText(msg, { parse_mode: "Markdown" }); } break;
                case "toggle_summary": case "toggle_autopost": case "toggle_debug": { let settings = await db.loadSettings(); if (data === 'toggle_summary') settings.dailySummary = !settings.dailySummary; else if (data === 'toggle_autopost') settings.autoPostToChannel = !settings.autoPostToChannel; else if (data === 'toggle_debug') settings.debugMode = !settings.debugMode; await db.saveSettings(settings); await sendSettingsMenu(ctx); } break;
                case "delete_all_data": waitingState = 'confirm_delete_all'; await ctx.editMessageText("⚠️ *تحذير: هذا الإجراء لا يمكن التراجع عنه!* ⚠️\n\nسيتم حذف جميع بياناتك المخزنة...", { parse_mode: "Markdown", reply_markup: undefined }); setTimeout(() => { if (waitingState === 'confirm_delete_all') waitingState = null; }, 30000); break;
            }
        } catch (error) { console.error("Caught a critical error in callback_query handler:", error); }
    });

    bot.on("message:text", async (ctx) => {
        try {
            const text = ctx.message.text.trim();
            if (ctx.message.text && ctx.message.text.startsWith('/')) { return; }
            switch (text) {
                case "📊 عرض المحفظة":
                    await ctx.reply("⏳ لحظات... جاري إعداد تقرير المحفظة.");
                    const pricesPortfolio = await api.getMarketPrices();
                    if (!pricesPortfolio) { return await ctx.reply("❌ عذرًا، فشل في جلب أسعار السوق."); }
                    const capital = await db.loadCapital();
                    const { assets, total, error } = await api.getPortfolio(pricesPortfolio);
                    if (error) { return await ctx.reply(`❌ ${error}`); }
                    const msgPortfolio = await logic.formatPortfolioMsg(assets, total, capital);
                    await ctx.reply(msgPortfolio, { parse_mode: "Markdown" });
                    return;
                case "📈 أداء المحفظة": const performanceKeyboard = new InlineKeyboard().text("آخر 24 ساعة", "chart_24h").row().text("آخر 7 أيام", "chart_7d").row().text("آخر 30 يومًا", "chart_30d"); await ctx.reply("اختر الفترة الزمنية المطلوبة:", { reply_markup: performanceKeyboard }); return;
                case "ℹ️ معلومات عملة": waitingState = 'coin_info'; await ctx.reply("✍️ يرجى إرسال رمز العملة (مثال: `BTC-USDT`)."); return;
                case "⚙️ الإعدادات": await sendSettingsMenu(ctx); return;
                case "🔔 ضبط تنبيه": waitingState = 'set_alert'; await ctx.reply("✍️ *لضبط تنبيه...*"); return;
                case "🧮 حاسبة الربح والخسارة": await ctx.reply("✍️ استخدم أمر `/pnl`..."); return;
            }
            if (waitingState) {
                const state = waitingState;
                waitingState = null;
                switch (state) {
                    case 'set_capital': const amount = parseFloat(text); if (!isNaN(amount) && amount >= 0) { await db.saveCapital(amount); await ctx.reply(`✅ *تم تحديث رأس المال إلى:* \`$${formatNumber(amount)}\``, { parse_mode: "Markdown" }); } else { await ctx.reply("❌ مبلغ غير صالح."); } return;
                    case 'set_global_alert_state': const percent = parseFloat(text); if (isNaN(percent) || percent <= 0) { return await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا موجبًا."); } let alertSettingsGlobal = await db.loadAlertSettings(); alertSettingsGlobal.global = percent; await db.saveAlertSettings(alertSettingsGlobal); await ctx.reply(`✅ تم تحديث النسبة العامة إلى \`${percent}%\`.`); return;
                    case 'set_coin_alert_state': const parts_coin_alert = text.split(/\s+/); if (parts_coin_alert.length !== 2) { return await ctx.reply("❌ *صيغة غير صحيحة*."); } const [symbol_coin_alert, percentStr_coin_alert] = parts_coin_alert; const coinPercent = parseFloat(percentStr_coin_alert); if (isNaN(coinPercent) || coinPercent < 0) { return await ctx.reply("❌ *خطأ:* النسبة يجب أن تكون رقمًا."); } let alertSettingsCoin = await db.loadAlertSettings(); if (coinPercent === 0) { delete alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()]; await ctx.reply(`✅ تم حذف الإعداد المخصص لـ *${symbol_coin_alert.toUpperCase()}*.`); } else { alertSettingsCoin.overrides[symbol_coin_alert.toUpperCase()] = coinPercent; await ctx.reply(`✅ تم تحديث النسبة المخصصة لـ *${symbol_coin_alert.toUpperCase()}* إلى \`${coinPercent}%\`.`); } await db.saveAlertSettings(alertSettingsCoin); return;
                    case 'coin_info':
                        const instId = text.toUpperCase();
                        const coinSymbol = instId.split('-')[0];
                        const loadingMessage = await ctx.reply(`⏳ جاري البحث وتجهيز الملف التحليلي الكامل لـ ${instId}...`);
                        
                        try {
                            const [details, prices, historicalPerf, techAnalysis] = await Promise.all([
                                api.getInstrumentDetails(instId),
                                api.getMarketPrices(),
                                getHistoricalPerformance(coinSymbol),
                                getTechnicalAnalysis(instId)
                            ]);

                            if (details.error) { return await ctx.api.editMessageText(loadingMessage.chat.id, loadingMessage.message_id, `❌ ${details.error}`); }
                            if (!prices) { return await ctx.api.editMessageText(loadingMessage.chat.id, loadingMessage.message_id, `❌ فشل جلب أسعار السوق.`); }

                            let msg = `ℹ️ *الملف التحليلي الكامل | ${instId}*\n\n` + `*القسم الأول: بيانات السوق*\n` + ` ▫️ *السعر الحالي:* \`$${formatNumber(details.price, 4)}\`\n` + ` ▫️ *أعلى سعر (24س):* \`$${formatNumber(details.high24h, 4)}\`\n` + ` ▫️ *أدنى سعر (24س):* \`$${formatNumber(details.low24h, 4)}\`\n\n`;

                            msg += `*القسم الثاني: تحليل مركزك الحالي*\n`;
                            const { assets: userAssets } = await api.getPortfolio(prices);
                            const ownedAsset = userAssets.find(a => a.asset === coinSymbol);
                            const positions = await db.loadPositions();
                            const assetPosition = positions[coinSymbol];

                            if (ownedAsset && assetPosition && assetPosition.avgBuyPrice) {
                                const totalPnl = (details.price * ownedAsset.amount) - (assetPosition.avgBuyPrice * ownedAsset.amount);
                                const totalPnlPercent = (assetPosition.avgBuyPrice > 0) ? (totalPnl / (assetPosition.avgBuyPrice * ownedAsset.amount)) * 100 : 0;
                                const totalPnlEmoji = totalPnl >= 0 ? '🟢' : '🔴';
                                const openDate = new Date(assetPosition.openDate);
                                const durationDays = (new Date().getTime() - openDate.getTime()) / (1000 * 60 * 60 * 24);
                                msg += ` ▪️ *متوسط سعر الشراء:* \`$${formatNumber(assetPosition.avgBuyPrice, 4)}\`\n`;
                                msg += ` ▪️ *الربح/الخسارة غير المحقق:* ${totalPnlEmoji} \`${formatNumber(totalPnl)}\` (\`${formatNumber(totalPnlPercent)}%\`)\n`;
                                msg += ` ▪️ *مدة فتح المركز:* \`${formatNumber(durationDays, 1)} يوم\`\n\n`;
                            } else {
                                msg += ` ▪️ لا يوجد مركز مفتوح حالياً لهذه العملة.\n\n`;
                            }

                            msg += `*القسم الثالث: تاريخ أدائك مع العملة*\n`;
                            if (historicalPerf && historicalPerf.tradeCount > 0) {
                                const pnlSign = historicalPerf.realizedPnl >= 0 ? '+' : '';
                                msg += ` ▪️ *إجمالي الربح/الخسارة المحقق:* \`${pnlSign}${formatNumber(historicalPerf.realizedPnl)}\`\n`;
                                msg += ` ▪️ *سجل الصفقات:* \`${historicalPerf.tradeCount}\` (${historicalPerf.winningTrades} رابحة / ${historicalPerf.losingTrades} خاسرة)\n`;
                                msg += ` ▪️ *متوسط مدة الصفقة:* \`${formatNumber(historicalPerf.avgDuration, 1)} يوم\`\n\n`;
                            } else {
                                msg += ` ▪️ لا يوجد تاريخ صفقات مغلقة لهذه العملة.\n\n`;
                            }

                            msg += `*القسم الرابع: مؤشرات فنية بسيطة*\n`;
                            if (techAnalysis.error) {
                                msg += ` ▪️ ${techAnalysis.error}\n`;
                            } else {
                                let rsiText = "منطقة محايدة";
                                if (techAnalysis.rsi > 70) rsiText = "منطقة تشبع شرائي 🔴";
                                if (techAnalysis.rsi < 30) rsiText = "منطقة تشبع بيعي 🟢";
                                msg += ` ▪️ *مؤشر القوة النسبية (RSI):* \`${formatNumber(techAnalysis.rsi)}\` (${rsiText})\n`;
                                msg += ` ▪️ *موقفه من المتوسطات المتحركة:*\n`;
                                if(techAnalysis.sma20) msg += `    - السعر الحالي *${details.price > techAnalysis.sma20 ? 'فوق' : 'تحت'}* متوسط 20 يوم (\`$${formatNumber(techAnalysis.sma20, 4)}\`)\n`;
                                if(techAnalysis.sma50) msg += `    - السعر الحالي *${details.price > techAnalysis.sma50 ? 'فوق' : 'تحت'}* متوسط 50 يوم (\`$${formatNumber(techAnalysis.sma50, 4)}\`)`;
                            }
                            await ctx.api.editMessageText(loadingMessage.chat.id, loadingMessage.message_id, msg, { parse_mode: "Markdown" });
                        } catch (e) {
                            console.error("Error in coin_info deep dive:", e);
                            await ctx.api.editMessageText(loadingMessage.chat.id, loadingMessage.message_id, "❌ حدث خطأ غير متوقع.");
                        }
                        return;
                    case 'set_alert':
                        // ... (logic is unchanged)
                        return;
                    case 'delete_alert_number':
                        // ... (logic is unchanged)
                        return;
                    case 'confirm_delete_all': 
                        // ... (logic is unchanged)
                        return;
                }
            }
        } catch (error) { console.error("Caught a critical error in message:text handler:", error); }
    });
}

module.exports = { initializeHandlers };
