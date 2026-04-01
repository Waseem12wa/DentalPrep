const express = require("express");
const { Subscription, generateId } = require("../db");
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

        const normalizedPlan = String(plan || "monthly").toLowerCase() === "annual" ? "annual" : "monthly";
        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + (normalizedPlan === "annual" ? 365 : 30));

        const subscription = await Subscription.findOneAndUpdate(
            { userId: req.user.id, status: "active" },
            {
                _id: `sub_${generateId()}`,
                userId: req.user.id,
                plan: normalizedPlan,
                status: "active",
                startedAt: now,
                expiresAt,
                paymentId: paymentDetails?.paymentId || `pay_${Date.now()}`
            },
            { new: true, upsert: true }
        );

        return res.json({
            success: true,
            subscription: {
                id: subscription._id,
                plan: subscription.plan,
                status: subscription.status,
                startedAt: subscription.startedAt,
                expiresAt: subscription.expiresAt,
                paymentId: subscription.paymentId
            }
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: "Payment failed" });
    }
});

module.exports = router;
