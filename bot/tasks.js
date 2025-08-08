// bot/tasks.js

const db = require("../database.js");
const api = require("../utils/api.js");
const helpers = require("../utils/helpers.js");
const { bot } = require("../index.js");

const AUTHORIZED_USER_ID = parseInt(process.env.AUTHORIZED_USER_ID);

async function monitorBalanceChanges() {
    // ... (Paste the full monitorBalanceChanges function here)
}

async function checkPriceAlerts() {
    // ... (Paste the full checkPriceAlerts function here)
}

async function runDailyJobs() {
    // ... (Paste the full runDailyJobs function here)
}

async function runHourlyJobs() {
    // ... (Paste the full runHourlyJobs function here)
}

async function checkPriceMovements() {
    // ... (Paste the full checkPriceMovements function here)
}

function startBackgroundTasks() {
    setInterval(monitorBalanceChanges, 60000);
    setInterval(checkPriceAlerts, 30000);
    setInterval(checkPriceMovements, 60000);
    setInterval(runHourlyJobs, 3600000);
    setInterval(runDailyJobs, 86400000);
    console.log("Background tasks started.");
}

module.exports = { startBackgroundTasks };
