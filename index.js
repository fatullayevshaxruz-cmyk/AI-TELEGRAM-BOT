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
  .catch(e => console.log("❌ Mongo xato", e));

/* ===== USER MODEL ===== */
const userSchema = new mongoose.Schema({
  chatId: Number,
  daily: { type: Number, default: 0 },
  date: String,
  isPremium: { type: Boolean, default: false },
  premiumUntil: Date,
  referredBy: Number,
  referrals: { type: Number, default: 0 }
});
const User = mongoose.model("User", userSchema);

const today = () => new Date().toISOString().slice(0,10);
const BONUS_DAYS = 3;

/* ===== LIMIT ===== */
async function checkLimit(chatId) {
  let u = await User.findOne({ chatId });
  if (!u) u = await User.create({ chatId, date: today() });

  if (u.date !== today()) {
    u.daily = 0;
    u.date = today();
  }

  if (u.isPremium && u.premiumUntil > new Date()) return true;
  if (!u.isPremium && u.daily >= 10) return false;

  u.daily++;
  await u.save();
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

    // 🎁 Referral bonus
    if (refId && refId !== chatId) {
      const refUser = await User.findOne({ chatId: refId });
      if (refUser) {
        refUser.referrals += 1;

        const now = new Date();
        if (refUser.isPremium && refUser.premiumUntil > now) {
          refUser.premiumUntil = new Date(
            refUser.premiumUntil.getTime() + BONUS_DAYS*24*60*60*1000
          );
        } else {
          refUser.isPremium = true;
          refUser.premiumUntil = new Date(
            now.getTime() + BONUS_DAYS*24*60*60*1000
          );
        }

        await refUser.save();
        bot.sendMessage(refId,
          `🎉 Siz do‘st taklif qildingiz!\n+${BONUS_DAYS} kun PREMIUM qo‘shildi.`);
      }
    }
  }

  bot.sendMessage(chatId,
`👋 Salom!

🤖 AI Bot
🧠 Savol ber
🖼 Rasm yubor
⏳ Kuniga 10 bepul
⭐ Premium (30 kun)

/premium - Stars bilan olish
/ref - referal havola`);
});

/* ===== REF LINK ===== */
bot.onText(/\/ref/, msg => {
  const link = `https://t.me/${process.env.BOT_USERNAME}?start=${msg.chat.id}`;
  bot.sendMessage(msg.chat.id,
`👥 Do‘stlaringni chaqir!

🎁 Har 1 do‘st = +${BONUS_DAYS} kun premium

🔗 Havola:
${link}`);
});

/* ===== PREMIUM (STARS) ===== */
bot.onText(/\/premium/, async msg => {
  bot.sendInvoice(
    msg.chat.id,
    `"⭐ Premium (30 kun)",
    "Cheksiz AI + rasm",
    "premium_30_days",
    "",
    "XTR",
    [{ label: "Premium 30 kun", amount: 100 }]`
  );
});

/* ===== PAYMENT SUCCESS ===== */
bot.on("successful_payment", async msg => {
  const chatId = msg.chat.id;
  const until = new Date(Date.now() + 30*24*60*60*1000);

  await User.updateOne(
    { chatId },
    { isPremium: true, premiumUntil: until },
    { upsert: true }
  );

  bot.sendMessage(chatId,
    "⭐ To‘lov qabul qilindi!\nPremium 30 kunga yoqildi.");
});

/* ===== AI TEXT ===== */
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
        { type: "input_text", text: "Rasmni tarjima qil va xatolarni top" },
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
      "⏳ Premium muddati tugadi.\n/premium orqali qayta faollashtiring.");
  }
});

console.log("🤖 BOT (REFERRAL + PREMIUM) ISHGA TUSHDI");