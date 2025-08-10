// /api/monitor.js

const {
    connectDB,
    monitorBalanceChanges,
    trackPositionHighLow,
    checkPriceAlerts,
    checkPriceMovements,
    monitorVirtualTrades
} = require('../core.js'); // يستدعي من العقل مباشرة

module.exports = async (req, res) => {
    try {
        await connectDB();
        await Promise.all([
            monitorBalanceChanges(),
            trackPositionHighLow(),
            checkPriceAlerts(),
            checkPriceMovements(),
            monitorVirtualTrades()
        ]);
        res.status(200).send('Cron job executed successfully.');
    } catch (error) {
        console.error('Error in cron job:', error.message);
        res.status(500).send(`Error executing cron job: ${error.message}`);
    }
};
