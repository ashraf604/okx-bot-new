// OKX Portfolio Bot (نهائي) // ✅ متوافق مع أزرار بوت فاذر + ضبط رأس المال + PnL + عرض النسبة المئوية لكل عملة + مراقبة الصفقات الجديدة تلقائيًا + متوافق مع توقيت مصر

const express = require("express"); const { Bot, webhookCallback } = require("grammy"); const fetch = require("node-fetch"); const crypto = require("crypto"); const fs = require("fs"); require("dotenv").config();

const app = express(); const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN); const PORT = process.env.PORT || 3000; const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID); const API_BASE_URL = "https://www.okx.com"; const CAPITAL_FILE = "capital.json"; let lastTrades = {};

function getEgyptTime() { return new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" }); }

function saveCapital(amount) { fs.writeFileSync(CAPITAL_FILE, JSON.stringify({ capital: amount })); }

function loadCapital() { try { const data = JSON.parse(fs.readFileSync(CAPITAL_FILE)); return data.capital; } catch { return 0; } }

function getHeaders(method, path, body = "") { const timestamp = new Date().toISOString(); const prehash = timestamp + method.toUpperCase() + path + body; const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64"); return { "OK-ACCESS-KEY": process.env.OKX_API_KEY, "OK-ACCESS-SIGN": sign, "OK-ACCESS-TIMESTAMP": timestamp, "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE, "Content-Type": "application/json", }; }

async function getPortfolio() { try { const res = await fetch(${API_BASE_URL}/api/v5/account/balance, { headers: getHeaders("GET", "/api/v5/account/balance") }); const json = await res.json();

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
                assets.push({ asset: asset.ccy, price, value, amount });
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

function formatPortfolioMsg(assets, total, capital) { let pnl = capital > 0 ? total - capital : 0; let pnlPercent = capital > 0 ? (pnl / capital) * 100 : 0; let msg = 📊 *ملخص المحفظة* 📊\n\n; msg += 💰 *القيمة الحالية:* $${total.toFixed(2)}\n; msg += 💼 *رأس المال الأساسي:* $${capital.toFixed(2)}\n; msg += 📈 *PnL:* ${pnl >= 0 ? '🟢' : '🔴'} ${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)\n; msg += ------------------------------------\n; assets.forEach(a => { let percent = ((a.value / total) * 100).toFixed(2); msg += 💎 *${a.asset}* (${percent}%)\n; if (a.asset !== "USDT") msg +=   السعر: $${a.price.toFixed(4)}\n; msg +=   القيمة: $${a.value.toFixed(2)}\n; msg +=   الكمية: ${a.amount}\n\n; }); msg += 🕒 *آخر تحديث:* ${getEgyptTime()}; return msg; }

async function checkNewTrades() { try { const res = await fetch(${API_BASE_URL}/api/v5/account/positions, { headers: getHeaders("GET", "/api/v5/account/positions") }); const json = await res.json();

json.data.forEach(async trade => {
        const id = trade.instId + trade.posId;
        if (!lastTrades[id]) {
            lastTrades[id] = true;
            await bot.api.sendMessage(AUTHORIZED_USER_ID,
                `🚨 *تم كشف صفقة جديدة:* ${trade.instId}\n🪙 كمية: ${trade.pos}\n💰 القيمة: ${trade.notional}\n📈 جانب: ${trade.posSide}`,
                { parse_mode: "Markdown" });
        }
    });
} catch (e) {
    console.error(e);
}

}

bot.command("start", async ctx => { if (ctx.from.id !== AUTHORIZED_USER_ID) return; await ctx.reply(🤖 *أهلاً بك في بوت مراقبة محفظة OKX*\n\nاستخدم الأوامر:\n/start - بدء البوت\n/balance - عرض رصيد المحفظة\n/setcapital 5000 - تعيين رأس المال\n/monitor - بدء مراقبة الصفقات\n/stop_monitor - إيقاف المراقبة, { parse_mode: "Markdown" }); });

bot.command("balance", async ctx => { if (ctx.from.id !== AUTHORIZED_USER_ID) return; const { assets, total } = await getPortfolio(); const capital = loadCapital(); const msg = formatPortfolioMsg(assets, total, capital); await ctx.reply(msg, { parse_mode: "Markdown" }); });

bot.command("setcapital", async ctx => { if (ctx.from.id !== AUTHORIZED_USER_ID) return; const parts = ctx.message.text.split(" "); if (parts.length === 2) { const amount = parseFloat(parts[1]); if (!isNaN(amount) && amount > 0) { saveCapital(amount); await ctx.reply(✅ تم تعيين رأس المال إلى: $${amount.toFixed(2)}); } else { await ctx.reply("❌ المبلغ غير صالح."); } } else { await ctx.reply("❌ استخدم الصيغة: /setcapital 5000"); } });

bot.command("monitor", async ctx => { if (ctx.from.id !== AUTHORIZED_USER_ID) return; if (!global.monitoring) { global.monitoring = setInterval(checkNewTrades, 60000); await ctx.reply("✅ تم تشغيل مراقبة الصفقات الجديدة."); } else { await ctx.reply("ℹ️ المراقبة تعمل بالفعل."); } });

bot.command("stop_monitor", async ctx => { if (ctx.from.id !== AUTHORIZED_USER_ID) return; if (global.monitoring) { clearInterval(global.monitoring); global.monitoring = null; await ctx.reply("🛑 تم إيقاف مراقبة الصفقات."); } else { await ctx.reply("ℹ️ المراقبة غير مفعلة."); } });

app.use(express.json()); app.use(webhookCallback(bot, "express"));

app.listen(PORT, async () => { console.log(✅ Bot running on port ${PORT}); const domain = process.env.RAILWAY_STATIC_URL; if (domain) { await bot.api.setWebhook(https://${domain}/${bot.token}); console.log(✅ Webhook set to: https://${domain}/${bot.token}); } });

                                                                                                                                                                 
