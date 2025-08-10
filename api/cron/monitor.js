// /api/cron/monitor.js

// استيراد الدوال اللازمة من ملفك الرئيسي
const { 
    connectDB, 
    monitorBalanceChanges, 
    trackPositionHighLow,
    checkPriceAlerts,
    checkPriceMovements,
    monitorVirtualTrades
} = require('../../index.js');

// هذه هي الدالة التي ستشغلها Vercel كل دقيقة
module.exports = async (req, res) => {
    try {
        await connectDB(); // تأكد من الاتصال بقاعدة البيانات
        
        // قم بتشغيل جميع وظائف المراقبة التي كانت في setInterval
        await Promise.all([
            monitorBalanceChanges(),
            trackPositionHighLow(),
            checkPriceAlerts(),
            checkPriceMovements(),
            monitorVirtualTrades()
        ]);
        
        res.status(200).send('Cron job for monitoring executed successfully.');
    } catch (error) {
        console.error('Error in cron job:', error);
        res.status(500).send('Error executing cron job.');
    }
};
