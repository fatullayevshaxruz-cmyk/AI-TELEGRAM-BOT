require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const OpenAI = require("openai");
const cron = require("node-cron");

/* ================= INIT ================= */
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ================= MONGO ================= */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB ulandi"))
  .catch(err => console.log("❌ Mongo xato", err));

/* ================= USER MODEL ================= */
const userSchema = new mongoose.Schema({
  chatId: Number,
  daily: { type: Number, default: 0 },
  date: String,
  isPremium: { type: Boolean, default: false },
  premiumUntil: Date,
  referredBy: Number
});
const User = mongoose.model("User", userSchema);

/* ================= HELPERS ================= */
const today = () => new Date().toISOString().slice(0, 10);
const REF_BONUS_DAYS = 3;

/* ===== typing effekti ===== */
async function showTyping(chatId, duration) {
  const interval = setInterval(() => {
    bot.sendChatAction(chatId, "typing");
  }, 2500);

  setTimeout(() => clearInterval(interval), duration);
}

/* ===== CACHE ===== */
const aiCache = new Map();
const CACHE_TTL = 1000 * 60 * 30; // 30 daqiqa

function getCache(key) {
  const item = aiCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expire) {
    aiCache.delete(key);
    return null;
  }
  return item.value;
}
function setCache(key, value) {
  aiCache.set(key, { value, expire: Date.now() + CACHE_TTL });
}

/* ================= LIMIT ================= */
async function checkLimit(chatId) {
  let user = await User.findOne({ chatId });
  if (!user) user = await User.create({ chatId, date: today() });

  if (user.date !== today()) {
    user.daily = 0;
    user.date = today();
  }

  if (user.isPremium && user.premiumUntil > new Date()) return true;
  if (user.daily >= 10) return false;

  user.daily++;
  await user.save();
  return true;
}

/* ================= /START + REFERRAL ================= */
bot.onText(/\/start(?: (\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const refId = match?.[1] ? Number(match[1]) : null;

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
        refUser.isPremium = true;
        refUser.premiumUntil =
          refUser.premiumUntil && refUser.premiumUntil > now
            ? new Date(refUser.premiumUntil.getTime() + REF_BONUS_DAYS * 86400000)
            : new Date(now.getTime() + REF_BONUS_DAYS * 86400000);
        await refUser.save();

        bot.sendMessage(
          refId,
          `🎉 Do‘st taklif qilindi!\n+${REF_BONUS_DAYS} kun PREMIUM qo‘shildi ⭐`
        );
      }
    }
  }

  bot.sendMessage(
    chatId,
`👋 Salom!

🤖 AI Premium Bot
🧠 Savol bering
🖼 Rasm yuboring

⏳ Kuniga 10 bepul
⭐ Premium — tezroq va cheksiz`,
    {
      reply_markup: {
        keyboard: [
          [{ text: "/ai" }, { text: "/premium" }],
          [{ text: "/ref" }, { text: "/help" }]
        ],
        resize_keyboard: true
      }
    }
  );
});

/* ================= COMMANDS ================= */
bot.onText(/\/ai/, msg =>
  bot.sendMessage(msg.chat.id, "🤖 AI tayyor. Savolingizni yozing ✍️")
);

bot.onText(/\/premium/, msg => {
  bot.sendMessage(
    msg.chat.id,
`⭐ PREMIUM AFZALLIKLARI

⚡ Tezroq AI javoblar
🧠 Aniqroq javoblar
🖼 Rasm tahlili
⏳ Limit yo‘q

Premium bilan bot ancha tez ishlaydi 🚀`
  );

  // Agar Stars chiqsa, shu joyda sendInvoice ishlaydi
  // bot.sendInvoice(...)
  //Telegram stars (chiqganda ishklaydi) 
bot.sendInvoice(msg.chat.Id,
  "⭐ Premium (30 kun)",
    "Cheksiz AI + tezkor javoblar",
    "premium_30_days",
    "",          // Stars uchun bo‘sh qoladi
    "XTR",       // Telegram Stars
    [{
      label: "Premium 30 kun", amount:100
    }]
)
});

bot.onText(/\/ref/, msg => {
  const link = `https://t.me/${process.env.BOT_USERNAME}?start=${msg.chat.id}`;
  bot.sendMessage(
    msg.chat.id,
`👥 Do‘stlarni chaqiring!

🎁 Har 1 kishi = +${REF_BONUS_DAYS} kun PREMIUM🔗 Havola:
${link}`
  );
});

bot.onText(/\/help/, msg =>
  bot.sendMessage(
    msg.chat.id,
`ℹ️ Yordam

/ai — AI suhbat
/premium — Premium
/ref — Do‘st chaqirish

🧠 Matn yozing
🖼 Rasm yuboring
  `)
);

/* ================= AI TEXT (PREMIUM SPEED) ================= */
bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const questionKey = text.toLowerCase();

  const user = await User.findOne({ chatId });
  const isPremium = user?.isPremium && user?.premiumUntil > new Date();

  const ok = await checkLimit(chatId);
  if (!ok) {
    return bot.sendMessage(
      chatId,
      "❌ Kunlik limit tugadi\n⭐ Premium bilan tez va cheksiz foydalaning"
    );
  }

  // CACHE (premium ham, free ham)
  const cached = getCache(questionKey);
  if (cached) return bot.sendMessage(chatId, cached);

  // ⚡ typing tezligi
  await showTyping(chatId, isPremium ? 1500 : 4500);

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: isPremium ? 0.5 : 0.7,
    messages: [
      {
        role: "system",
        content: isPremium
          ? "You are a fast, professional assistant. Answer briefly and clearly."
          : "Answer clearly in user's language."
      },
      { role: "user", content: text }
    ]
  });

  const answer = res.choices[0].message.content;
  setCache(questionKey, answer);

  await bot.sendMessage(chatId, answer);
});

/* ================= IMAGE ================= */
bot.on("photo", async msg => {
  const chatId = msg.chat.id;
  const ok = await checkLimit(chatId);
  if (!ok) return bot.sendMessage(chatId, "❌ Limit tugadi");

  const photo = msg.photo.at(-1);
  const imageUrl = await bot.getFileLink(photo.file_id);

  await showTyping(chatId, 3000);

  const res = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Rasmni aniq tahlil qil" },
          { type: "input_image", image_url: imageUrl }
        ]
      }
    ]
  });

  bot.sendMessage(chatId, res.output_text);
});

/* ================= PREMIUM AUTO-O‘CHISH ================= */
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
    bot.sendMessage(
      u.chatId,
      "⏳ Premium muddati tugadi.\n/premium orqali qayta yoqing."
    );
  }
});

console.log("🚀 BOT TEZ, BARQAROR VA TAYYOR");