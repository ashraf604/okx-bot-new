const express = require("express");
const { Bot, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
require("dotenv").config();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const API_BASE_URL = "https://www.okx.com";
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID || "0");
const PORT = process.env.PORT || 3000;
const app = express();

let baseCapital = parseFloat(process.env.BASE_CAPITAL || "0"); // رأس المال الأساسي
let previousPortfolio = [];
let monitoring = false;
let monitoringInterval;

// توليد تواقيع OKX
function getHeaders(method, path, body = "") {
  const timestamp = new Date().toISOString();
  const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY)
    .update(timestamp + method.toUpperCase() + path + body)
    .digest("base64");
  return {
    "Content-Type": "application/json",
    "OK-ACCESS-KEY": process.env.OKX_API_KEY,
    "OK-ACCESS-SIGN": sign,
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE
  };
}

// الحصول على بيانات المحفظة
async function getPortfolio() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, {
      headers: getHeaders("GET", "/api/v5/account/balance")
    });
    const data = await res.json();
    if (data.code !== "0") return null;

    const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
    const tickersData = await tickersRes.json();
    const tickers = {};
    if (tickersData.code === "0") {
      tickersData.data.forEach(t => {
        tickers[t.instId] = parseFloat(t.last);
      });
    }

    const portfolio = [];
    let totalValue = 0;
    data.data[0].details.forEach(asset => {
      const amount = parseFloat(asset.eq);
      if (amount <= 0) return;
      const instId = `${asset.ccy}-USDT`;
      const price = asset.ccy === "USDT" ? 1 : (tickers[instId] || 0);
      const usdValue = amount * price;
      if (usdValue < 0.5) return;
      portfolio.push({ asset: asset.ccy, price, amount, usdValue });
      totalValue += usdValue;
    });

    portfolio.forEach(a => {
      a.percentage = totalValue > 0 ? (a.usdValue / totalValue) * 100 : 0;
    });
    portfolio.sort((a, b) => b.usdValue - a.usdValue);
    return { portfolio, totalValue };
  } catch (e) {
    console.error("Error fetching portfolio:", e);
    return null;
  }
}

// إرسال ملخص المحفظة
async function sendPortfolio(ctx) {
  const data = await getPortfolio();
  if (!data) return ctx.reply("❌ تعذر جلب بيانات المحفظة.");

  const { portfolio, totalValue } = data;
  const pnl = baseCapital ? ((totalValue - baseCapital) / baseCapital) * 100 : 0;

  let msg = `📊 *ملخص المحفظة*\n\n`;
  msg += `💰 *القيمة الحالية:* $${totalValue.toFixed(2)}\n`;
  if (baseCapital) {
    msg += `💼 *رأس المال الأساسي:* $${baseCapital.toFixed(2)}\n`;
    msg += `📈 *PnL:* ${pnl >= 0 ? "🟢" : "🔴"} ${pnl.toFixed(2)}%\n`;
  }
  msg += `------------------------------------\n`;

  portfolio.forEach(a => {
    msg += `💎 *${a.asset}*\n`;
    if (a.asset !== "USDT") msg += `  السعر: $${a.price.toFixed(4)}\n`;
    msg += `  القيمة: $${a.usdValue.toFixed(2)} (${a.percentage.toFixed(2)}%)\n`;
    msg += `  الكمية: ${a.amount.toFixed(6)}\n\n`;
  });

  msg += `_آخر تحديث: ${new Date().toLocaleString("ar-EG")}_`;
  ctx.reply(msg, { parse_mode: "Markdown" });
}

// مقارنة الصفقات القديمة والجديدة
function compareTrades(oldPortfolio, newPortfolio) {
  const oldMap = new Map(oldPortfolio.map(a => [a.asset, a]));
  const notifications = [];

  for (const current of newPortfolio) {
    const prev = oldMap.get(current.asset);
    if (!prev) {
      notifications.push(`🟢 *شراء جديد:* ${current.amount.toFixed(4)} ${current.asset}`);
    } else {
      const diff = current.amount - prev.amount;
      if (Math.abs(diff * current.price) > 1) {
        if (diff > 0) {
          notifications.push(`🔵 *شراء إضافي:* ${diff.toFixed(4)} ${current.asset}`);
        } else {
          notifications.push(`🟠 *بيع جزئي:* ${Math.abs(diff).toFixed(4)} ${current.asset}`);
        }
      }
      oldMap.delete(current.asset);
    }
  }
  for (const prev of oldMap.values()) {
    notifications.push(`🔴 *بيع كامل:* ${prev.amount.toFixed(4)} ${prev.asset}`);
  }
  return notifications;
}

// بدء المراقبة التلقائية
async function startMonitoring(ctx) {
  if (monitoring) return ctx.reply("⚠️ المراقبة مفعلة بالفعل.");
  monitoring = true;
  ctx.reply("✅ تم تشغيل مراقبة الصفقات.");

  const initial = await getPortfolio();
  if (!initial) {
    monitoring = false;
    return ctx.reply("❌ تعذر بدء المراقبة.");
  }
  previousPortfolio = initial.portfolio;

  monitoringInterval = setInterval(async () => {
    const current = await getPortfolio();
    if (!current) return;
    const changes = compareTrades(previousPortfolio, current.portfolio);
    if (changes.length > 0) {
      await bot.api.sendMessage(AUTHORIZED_USER_ID, `🔔 *حركة الصفقات:*\n\n${changes.join("\n")}`, { parse_mode: "Markdown" });
    }
    previousPortfolio = current.portfolio;
  }, 60000); // كل دقيقة
}

// إيقاف المراقبة
function stopMonitoring(ctx) {
  if (!monitoring) return ctx.reply("ℹ️ المراقبة متوقفة بالفعل.");
  clearInterval(monitoringInterval);
  monitoring = false;
  ctx.reply("🛑 تم إيقاف مراقبة الصفقات.");
}

// إعداد رأس المال عبر البوت
bot.command("setcapital", async (ctx) => {
  const parts = ctx.message.text.split(" ");
  if (parts.length !== 2) return ctx.reply("⚠️ الاستخدام: /setcapital 5000");
  const value = parseFloat(parts[1]);
  if (isNaN(value) || value <= 0) return ctx.reply("⚠️ أدخل قيمة صحيحة أكبر من الصفر.");
  baseCapital = value;
  ctx.reply(`✅ تم تحديث رأس المال الأساسي إلى: $${baseCapital.toFixed(2)}`);
});

// الأوامر
bot.command("start", (ctx) => ctx.reply("🤖 أهلاً بك في بوت مراقبة محفظة OKX.\n\n- /portfolio لعرض المحفظة.\n- /startmonitor لتفعيل المراقبة.\n- /stopmonitor لإيقاف المراقبة.\n- /setcapital 5000 لتحديد رأس المال لحساب PnL."));
bot.command("portfolio", sendPortfolio);
bot.command("startmonitor", startMonitoring);
bot.command("stopmonitor", stopMonitoring);

bot.use(async (ctx, next) => {
  if (ctx.from?.id !== AUTHORIZED_USER_ID) return;
  await next();
});

// التشغيل
app.use(express.json());
app.use(webhookCallback(bot, "express"));
app.listen(PORT, async () => {
  console.log(`🚀 Bot running on port ${PORT}`);
  const domain = process.env.RAILWAY_STATIC_URL;
  if (domain) {
    const webhookUrl = `https://${domain}/${bot.token}`;
    try {
      await bot.api.setWebhook(webhookUrl);
      console.log(`✅ Webhook set to: ${webhookUrl}`);
    } catch (e) {
      console.error("❌ Failed to set webhook:", e);
    }
  }
});
