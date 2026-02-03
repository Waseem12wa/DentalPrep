const express = require("express");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

router.post("/create-checkout-session", authMiddleware, async (req, res) => {
    // Mock logic: just return a "session" ID and the amount based on plan
    const { plan } = req.body;
    const price = plan === "annual" ? 1700 : 500;

    return res.json({
        sessionId: "mock_session_" + Date.now(),
        amount: price,
        currency: "PKR"
    });
});

router.post("/confirm-payment", authMiddleware, async (req, res) => {
    try {
        const { plan, paymentDetails } = req.body;

        // Simulate payment processing delay
        await new Promise(r => setTimeout(r, 1000));

        // Mock subscription confirmation (no database needed)
        return res.json({
            success: true,
            subscription: {
                plan,
                status: "active",
                startedAt: new Date(),
                paymentId: "pay_" + Date.now()
            }
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: "Payment failed" });
    }
});

module.exports = router;
