// bot/analysis.js

const fetch = require("node-fetch");
const { formatNumber } = require("../utils/helpers.js");
const { getCollection } = require("../database.js");

const API_BASE_URL = "https://www.okx.com";

async function getHistoricalCandles(instId, limit = 100) {
    try {
        const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&limit=${limit}`);
        const json = await res.json();
        if (json.code !== '0' || !json.data || json.data.length === 0) {
            console.error(`Could not fetch candle history for ${instId}:`, json.msg);
            return [];
        }
        return json.data.map(c => parseFloat(c[4])).reverse();
    } catch (e) {
        console.error(`Exception in getHistoricalCandles for ${instId}:`, e);
        return [];
    }
}

function calculateSMA(closes, period) {
    if (closes.length < period) return null;
    const relevantCloses = closes.slice(-period);
    const sum = relevantCloses.reduce((acc, val) => acc + val, 0);
    return sum / period;
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) {
            gains += diff;
        } else {
            losses -= diff;
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgLoss = (avgLoss * (period - 1) - diff) / period;
            avgGain = (avgGain * (period - 1)) / period;
        }
    }
    
    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

async function getTechnicalAnalysis(instId) {
    const closes = await getHistoricalCandles(instId, 51);
    if (closes.length < 51) {
        return { error: "بيانات الشموع غير كافية للتحليل الفني." };
    }

    const rsi = calculateRSI(closes);
    const sma20 = calculateSMA(closes, 20);
    const sma50 = calculateSMA(closes, 50);

    return {
        rsi: rsi,
        sma20: sma20,
        sma50: sma50,
    };
}

async function getHistoricalPerformance(asset) {
    try {
        const history = await getCollection("tradeHistory").find({ asset: asset }).toArray();
        if (history.length === 0) {
            return {
                realizedPnl: 0,
                tradeCount: 0,
                winningTrades: 0,
                losingTrades: 0,
                avgDuration: 0
            };
        }
        
        const realizedPnl = history.reduce((sum, trade) => sum + trade.pnl, 0);
        const winningTrades = history.filter(trade => trade.pnl > 0).length;
        const losingTrades = history.filter(trade => trade.pnl <= 0).length;
        const totalDuration = history.reduce((sum, trade) => sum + trade.durationDays, 0);
        const avgDuration = totalDuration / history.length;

        return {
            realizedPnl,
            tradeCount: history.length,
            winningTrades,
            losingTrades,
            avgDuration
        };
    } catch (e) {
        console.error(`Error fetching historical performance for ${asset}:`, e);
        return null;
    }
}

module.exports = {
    getTechnicalAnalysis,
    getHistoricalPerformance
};
