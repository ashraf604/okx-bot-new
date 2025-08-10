const express = require("express");
const { bot, connectDB } = require("./core.js"); // استيراد البوت من الملف المركزي

const app = express();
app.use(express.json());

// نقطة نهاية للتحقق من الصحة
app.get("/", (req, res) => {
  res.send("Bot is alive!");
});

// نقطة نهاية مخصصة لاستقبال تحديثات تيليجرام
app.post("/api/bot", async (req, res) => {
    try {
        await connectDB();
        await bot.handleUpdate(req.body, res);
    } catch (error) {
        console.error("Error handling update:", error);
        res.sendStatus(500);
    }
});

// قم بتصدير التطبيق كدالة serverless
module.exports = app;
