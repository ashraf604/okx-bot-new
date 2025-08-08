// botInstance.js
const { Bot } = require("grammy");
require("dotenv").config();

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

module.exports = { bot };
