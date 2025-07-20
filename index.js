// OKX Advanced Analytics Bot - Final Version with Reviewed Fixes and Features

const express = require("express");
const { Bot, Keyboard, InlineKeyboard, webhookCallback } = require("grammy");
const fetch = require("node-fetch");
const crypto = require("crypto");
const fs = require("fs");
require("dotenv").config();

const app = express();
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const PORT = process.env.PORT || 3000;
const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);
const API_BASE_URL = "https://www.okx.com";

const CAPITAL_FILE = "data_capital.json";
const ALERTS_FILE = "data_alerts.json";
const TRADES_FILE = "data_trades.json";
const HISTORY_FILE = "data_history.json";
const SETTINGS_FILE = "data_settings.json";

let waitingState = null;
let tradeMonitoringInterval = null;
let alertsCheckInterval = null;
let dailyJobsInterval = null;

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
const loadSettings = () => readJsonFile(SETTINGS_FILE, { dailySummary: false });
const saveSettings = (settings) => writeJsonFile(SETTINGS_FILE, settings);

function getHeaders(method, path, body = "") {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method.toUpperCase() + path + (body ? JSON.stringify(body) : '');
    const sign = crypto.createHmac("sha256", process.env.OKX_API_SECRET_KEY).update(prehash).digest("base64");
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
        const res = await fetch(`${API_BASE_URL}/api/v5/account/balance`, { headers: getHeaders("GET", "/api/v5/account/balance") });
        const json = await res.json();
        if (!json.data || !json.data[0] || !json.data[0].details) {
            return { error: "بيانات المحفظة غير متوفرة من OKX." };
        }
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        const prices = {};
        if (tickersJson.data) tickersJson.data.forEach(t => prices[t.instId] = parseFloat(t.last));
        let assets = [], total = 0;
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
    } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; }
}

async function getInstrumentDetails(instId) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`);
        const json = await res.json();
        if (json.code !== '0' || !json.data[0]) return { error: `لم يتم العثور على العملة.` };
        const data = json.data[0];
        return {
            price: parseFloat(data.last),
            high24h: parseFloat(data.high24h),
            low24h: parseFloat(data.low24h),
            vol24h: parseFloat(data.volCcy24h),
        };
    } catch (e) { console.error(e); return { error: "خطأ في الاتصال بالمنصة." }; }
}

async function checkNewTrades() {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/account/trade-history?instType=SPOT`, {
            headers: getHeaders("GET", "/api/v5/account/trade-history?instType=SPOT")
        });
        const json = await res.json();
        if (json.code !== '0') return;

        const newTrades = json.data;
        const lastTrades = loadLastTrades();
        const unseenTrades = newTrades.filter(t => !lastTrades[t.tradeId]);

        if (unseenTrades.length > 0) {
            unseenTrades.forEach(trade => {
                const msg = `💹 *صفقة جديدة*\n\n🔸 العملة: ${trade.instId}\n🔹 الحجم: ${trade.sz}\n💲 السعر: $${trade.fillPx}\n📅 الوقت: ${new Date(parseInt(trade.ts)).toLocaleString("ar-EG")}`;
                bot.api.sendMessage(AUTHORIZED_USER_ID, msg, { parse_mode: "Markdown" });
                lastTrades[trade.tradeId] = true;
            });
            saveLastTrades(lastTrades);
        }
    } catch (e) {
        console.error("❌ Error in checkNewTrades:", e);
    }
}

async function checkAlerts() {
    const alerts = loadAlerts();
    for (const alert of alerts) {
        if (!alert.active || alert.notified) continue;
        const { error, price } = await getInstrumentDetails(alert.instId);
        if (error || !price) continue;
        if ((alert.condition === '>' && price > alert.price) || (alert.condition === '<' && price < alert.price)) {
            await bot.api.sendMessage(AUTHORIZED_USER_ID, `🔔 *تنبيه سعر*\n\n${alert.instId} ${alert.condition} ${alert.price}\n🔹 السعر الحالي: $${price}`, { parse_mode: "Markdown" });
            alert.notified = true;
        }
    }
    saveAlerts(alerts);
}

async function runDailyJobs() {
    const { assets, total, error } = await getPortfolio();
    if (error) return;

    const history = loadHistory();
    const today = new Date().toISOString().split("T")[0];
    const alreadyExists = history.some(h => h.date === today);

    if (!alreadyExists) {
        history.push({ date: today, total: parseFloat(total.toFixed(2)) });
        saveHistory(history);
    }

    const settings = loadSettings();
    if (settings.dailySummary) {
        const capital = loadCapital();
        const msg = formatPortfolioMsg(assets, total, capital);
        await bot.api.sendMessage(AUTHORIZED_USER_ID, `📰 *الملخص اليومي للمحفظة:*\n\n${msg}`, { parse_mode: "Markdown" });
    }
}

// تمت إزالة زر "🔥 حذف كل البيانات 🔥" من لوحة الإعدادات والمعالج الخاص به كما طلبت
