require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const OpenAI = require("openai");
const cron = require("node-cron");

/* ===== INIT ===== */
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ===== MONGO ===== */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB ulandi"))
  .catch(err => console.log("❌ Mongo xato", err));

/* ===== USER MODEL ===== */
const userSchema = new mongoose.Schema({
  chatId: Number,
  daily: { type: Number, default: 0 },
  date: String,
  isPremium: { type: Boolean, default: false },
  premiumUntil: Date,
  referredBy: Number
});
const User = mongoose.model("User", userSchema);

const today = () => new Date().toISOString().slice(0, 10);
const REF_BONUS_DAYS = 3;

/* ===== LIMIT ===== */
async function checkLimit(chatId) {
  let user = await User.findOne({ chatId });
  if (!user) user = await User.create({ chatId, date: today() });

  if (user.date !== today()) {
    user.daily = 0;
    user.date = today();
  }

  if (user.isPremium && user.premiumUntil > new Date()) return true;
  if (!user.isPremium && user.daily >= 10) return false;

  user.daily++;
  await user.save();
  return true;
}

/* ===== START + REFERRAL ===== */
bot.onText(/\/start(?: (\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const refId = match && match[1] ? Number(match[1]) : null;

  let user = await User.findOne({ chatId });
  if (!user) {
    user = await User.create({
      chatId,
      date: today(),
      referredBy: refId || null
    });

    if (refId && refId !== chatId) {
      const refUser = await User.findOne({ chatId: refId });
      if (refUser) {
        const now = new Date();
        if (refUser.isPremium && refUser.premiumUntil > now) {
          refUser.premiumUntil = new Date(
            refUser.premiumUntil.getTime() + REF_BONUS_DAYS * 86400000
          );
        } else {
          refUser.isPremium = true;
          refUser.premiumUntil = new Date(
            now.getTime() + REF_BONUS_DAYS * 86400000
          );
        }
        await refUser.save();

        bot.sendMessage(refId,
          `🎉 Siz do‘st chaqirdingiz!\n+${REF_BONUS_DAYS} kun PREMIUM qo‘shildi ⭐`);
      }
    }
  }

  bot.sendMessage(chatId,
`👋 Salom!

🤖 AI English Bot
🧠 Savol bering
🖼 Rasm yuboring

⏳ Kuniga 10 bepul
⭐ Premium — cheksiz

Buyruqlar:
/ai /premium /ref /help`,
{
  reply_markup: {
    keyboard: [
      [{ text: "/ai" }, { text: "/premium" }],
      [{ text: "/ref" }, { text: "/help" }]
    ],
    resize_keyboard: true
  }
});
});

/* ===== AI ===== */
bot.onText(/\/ai/, msg => {
  bot.sendMessage(msg.chat.id,
`🤖 AI bo‘limi

Savolingizni yozing ✍️
Men yordam beraman 🙂`);
});

/* ===== PREMIUM ===== */
bot.onText(/\/premium/, msg => {
  bot.sendInvoice(
    msg.chat.id,
    "⭐ Premium (30 kun)",
    "Cheksiz AI va rasm tahlili",
    "premium_30_days",
    "",
    "XTR",
    [{ label: "Premium 30 kun", amount: 100 }]
  );
});

/* ===== REF ===== */
bot.onText(/\/ref/, msg => {
  const link = `https://t.me/${process.env.BOT_USERNAME}?start=${msg.chat.id}`;
  bot.sendMessage(msg.chat.id,
`👥 Do‘stlaringni taklif qil!

🎁 Har 1 odam = +${REF_BONUS_DAYS} kun PREMIUM

🔗 Havola:
${link}`);
});

/* ===== HELP ===== */
bot.onText(/\/help/, msg => {
  bot.sendMessage(msg.chat.id,
`ℹ️ Yordam

/ai — AI bilan suhbat
/premium — Premium olish
/ref — Do‘st chaqirish

🧠 Matn yozing
🖼 Rasm yuboring`);
});

/* ===== PAYMENT SUCCESS ===== */
bot.on("successful_payment", async msg => {
  const chatId = msg.chat.id;
  const until = new Date(Date.now() + 30 * 86400000);

  await User.updateOne(
    { chatId },
    { isPremium: true, premiumUntil: until },
    { upsert: true }
  );

  bot.sendMessage(chatId,
    "⭐ To‘lov qabul qilindi!\nPremium 30 kunga yoqildi ✅");
});

/* ===== TEXT ===== */
bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;


const ok = await checkLimit(msg.chat.id);
  if (!ok) {
    return bot.sendMessage(msg.chat.id,
      "❌ Kunlik limit tugadi\n⭐ /premium orqali oling");
  }

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: "Answer in the user's language clearly." },
      { role: "user", content: msg.text }
    ]
  });

  bot.sendMessage(msg.chat.id, res.choices[0].message.content);
});

/* ===== IMAGE ===== */
bot.on("photo", async msg => {
  const ok = await checkLimit(msg.chat.id);
  if (!ok) return bot.sendMessage(msg.chat.id, "❌ Limit tugadi");

  const photo = msg.photo.at(-1);
  const imageUrl = await bot.getFileLink(photo.file_id);

  const res = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Rasmni tahlil qil va tushuntir" },
        { type: "input_image", image_url: imageUrl }
      ]
    }]
  });

  bot.sendMessage(msg.chat.id, res.output_text);
});

/* ===== PREMIUM AUTO-O‘CHISH ===== */
cron.schedule("0 * * * *", async () => {
  const now = new Date();
  const expired = await User.find({
    isPremium: true,
    premiumUntil: { $lt: now }
  });

  for (const u of expired) {
    u.isPremium = false;
    u.premiumUntil = null;
    await u.save();
    bot.sendMessage(u.chatId,
      "⏳ Premium muddati tugadi.\n/premium orqali qayta yoqing.");
  }
});

console.log("🤖 BOT ISHGA TUSHDI");