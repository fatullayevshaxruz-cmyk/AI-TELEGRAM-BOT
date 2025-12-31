const express = require("express");
const Stripe = require("stripe");
const User = require("");

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.post("/webhook", express.raw({type: "application/json"}), async (req,res)=>{
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.sendStatus(400);
  }

  if (event.type === "checkout.session.completed") {
    const chatId = event.data.object.metadata.chatId;
    await User.updateOne({ chatId }, { isPremium: true });
  }

  res.sendStatus(200);
});

module.exports = router;