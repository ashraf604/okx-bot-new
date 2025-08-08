// utils/api.js

const fetch = require("node-fetch");
const crypto = require("crypto");
const { getHeaders } = require("../utils/helpers.js"); // We will move getHeaders here later, for now this is ok.

const API_BASE_URL = "https://www.okx.com";

async function getMarketPrices() {
    try {
        const tickersRes = await fetch(`${API_BASE_URL}/api/v5/market/tickers?instType=SPOT`);
        const tickersJson = await tickersRes.json();
        if (tickersJson.code !== '0') {
            console.error("Failed to fetch market prices (OKX Error):", tickersJson.msg);
            return null;
        }
        const prices = {};
        tickersJson.data.forEach(t => {
            const lastPrice = parseFloat(t.last);
            const openPrice = parseFloat(t.open24h);
            let change24h = 0;
            if (openPrice > 0) {
                change24h = (lastPrice - openPrice) / openPrice;
            }
            prices[t.instId] = { price: lastPrice, open24h: openPrice, change24h: change24h };
        });
        return prices;
    } catch (error) {
        console.error("Exception in getMarketPrices (Invalid Response):", error.message);
        return null;
    }
}

async function getPortfolio(prices) {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== '0') return { error: `فشل جلب المحفظة من OKX: ${json.msg}` };
        
        let assets = [], total = 0;
        json.data[0]?.details?.forEach(asset => {
            const amount = parseFloat(asset.eq);
            if (amount > 0) {
                const instId = `${asset.ccy}-USDT`;
                const priceData = prices[instId] || { price: (asset.ccy === "USDT" ? 1 : 0), change24h: 0 };
                const price = priceData.price;
                const value = amount * price;
                total += value;
                if (value >= 1) {
                    assets.push({ asset: asset.ccy, price: price, value: value, amount: amount, change24h: priceData.change24h });
                }
            }
        });
        
        const filteredAssets = assets.filter(a => a.value >= 1);
        filteredAssets.sort((a, b) => b.value - a.value);
        return { assets: filteredAssets, total };
    } catch (e) {
        console.error(e);
        return { error: "خطأ في الاتصال بالمنصة." };
    }
}

async function getBalanceForComparison() {
    try {
        const path = "/api/v5/account/balance";
        const res = await fetch(`${API_BASE_URL}${path}`, { headers: getHeaders("GET", path) });
        const json = await res.json();
        if (json.code !== '0') {
            console.error("Error fetching balance for comparison:", json.msg);
            return null;
        }
        const balanceMap = {};
        json.data[0]?.details?.forEach(asset => {
            const totalBalance = parseFloat(asset.eq);
            if (totalBalance > -1e-9) {
                balanceMap[asset.ccy] = totalBalance;
            }
        });
        return balanceMap;
    } catch (error) {
        console.error("Exception in getBalanceForComparison:", error);
        return null;
    }
}

async function getInstrumentDetails(instId) {
    try {
        const tickerRes = await fetch(`${API_BASE_URL}/api/v5/market/ticker?instId=${instId.toUpperCase()}`);
        const tickerJson = await tickerRes.json();
        if (tickerJson.code !== '0' || !tickerJson.data[0]) return { error: `لم يتم العثور على العملة.` };
        const tickerData = tickerJson.data[0];
        const candleRes = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId.toUpperCase()}&bar=1D&limit=7`);
        const candleJson = await candleRes.json();
        let weeklyData = { high: 0, low: 0 };
        if (candleJson.code === '0' && candleJson.data.length > 0) {
            const highs = candleJson.data.map(c => parseFloat(c[2]));
            const lows = candleJson.data.map(c => parseFloat(c[3]));
            weeklyData.high = Math.max(...highs);
            weeklyData.low = Math.min(...lows);
        }
        return {
            price: parseFloat(tickerData.last),
            high24h: parseFloat(tickerData.high24h),
            low24h: parseFloat(tickerData.low24h),
            vol24h: parseFloat(tickerData.volCcy24h),
            open24h: parseFloat(tickerData.open24h),
            weeklyHigh: weeklyData.high,
            weeklyLow: weeklyData.low
        };
    } catch (e) {
        console.error(e);
        return { error: "خطأ في الاتصال بالمنصة." };
    }
}

async function getHistoricalHighLow(instId, startDate, endDate) {
    try {
        const startMs = new Date(startDate).getTime();
        const endMs = new Date(endDate).getTime();
        const res = await fetch(`${API_BASE_URL}/api/v5/market/history-candles?instId=${instId}&bar=1D&after=${startMs}&limit=100`);
        const json = await res.json();
        if (json.code !== '0' || !json.data || json.data.length === 0) {
            console.error(`Could not fetch history for ${instId}:`, json.msg);
            return { high: 0 };
        }
        const relevantCandles = json.data.filter(c => parseInt(c[0]) <= endMs);
        if (relevantCandles.length === 0) return { high: 0 };

        const highs = relevantCandles.map(c => parseFloat(c[2]));
        return { high: Math.max(...highs) };
    } catch (e) {
        console.error(`Exception in getHistoricalHighLow for ${instId}:`, e);
        return { high: 0 };
    }
}

module.exports = {
    getMarketPrices,
    getPortfolio,
    getBalanceForComparison,
    getInstrumentDetails,
    getHistoricalHighLow
};
