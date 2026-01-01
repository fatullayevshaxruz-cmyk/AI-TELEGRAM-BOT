require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const OpenAI = require("openai");
const cron = require("node-cron");

/* ================= INIT ================= */
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ADMIN_ID = Number(process.env.ADMIN_ID);

/* ================= MONGO ================= */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB ulandi"))
  .catch(e => console.log("❌ Mongo xato", e));

/* ================= USER MODEL ================= */
const userSchema = new mongoose.Schema({
  chatId: Number,
  daily: { type: Number, default: 0 },
  date: String,

  isPremium: { type: Boolean, default: false },
  premiumUntil: Date,

  referredBy: Number,
  referrals: { type: Number, default: 0 },

  totalMessages: { type: Number, default: 0 }
});

const User = mongoose.model("User", userSchema);

/* ================= HELPERS ================= */
const today = () => new Date().toISOString().slice(0, 10);
const BONUS_DAYS = 3;
const PREMIUM_DAYS = 30;

const addDays = (d, days) =>
  new Date(d.getTime() + days * 24 * 60 * 60 * 1000);

/* ================= LIMIT ================= */
async function checkLimit(chatId) {
  let u = await User.findOne({ chatId });
  if (!u) u = await User.create({ chatId, date: today() });

  if (u.date !== today()) {
    u.daily = 0;
    u.date = today();
  }

  if (u.isPremium && u.premiumUntil > new Date()) {
    u.totalMessages++;
    await u.save();
    return true;
  }

  if (u.daily >= 10) return false;

  u.daily++;
  u.totalMessages++;
  await u.save();
  return true;
}

/* ================= START + REF ================= */
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
        refUser.referrals++;

        const now = new Date();
        if (refUser.isPremium && refUser.premiumUntil > now) {
          refUser.premiumUntil = addDays(refUser.premiumUntil, BONUS_DAYS);
        } else {
          refUser.isPremium = true;
          refUser.premiumUntil = addDays(now, BONUS_DAYS);
        }

        await refUser.save();
        bot.sendMessage(refId,
`🎉 Referal ishladi!
+${BONUS_DAYS} kun PREMIUM qo‘shildi`);
      }
    }
  }

  bot.sendMessage(chatId,
`👋 Salom!

🤖 ULTRA AI BOT
🧠 GPT-4.1
🖼 Vision

⏳ Free: 10 / kun
⭐ Premium: Cheksiz`,
{
  reply_markup: {
    keyboard: [
      [{ text: "/ai" }, { text: "/premium" }],
      [{ text: "/ref" }, { text: "/stats" }],
      [{ text: "/help" }]
    ],
    resize_keyboard: true
  }
});
});

/* ================= COMMANDS ================= */
bot.onText(/\/ai/, msg =>
  bot.sendMessage(msg.chat.id,
"🤖 AI tayyor!\nSavolingizni yozing"));

bot.onText(/\/help/, msg =>
  bot.sendMessage(msg.chat.id,
"/ai — AI\n/premium — premium\n/ref — referal\n/stats — statistika"));

bot.onText(/\/ref/, msg => {
  const link = `https://t.me/${process.env.BOT_USERNAME}?start=${msg.chat.id}`;
  bot.sendMessage(msg.chat.id,
`👥 Referal havola:
${link}

🎁 Har do‘st = +3 kun premium`);
});

/* ================= PREMIUM INFO ================= */
bot.onText(/\/premium/, async msg => {
  const u = await User.findOne({ chatId: msg.chat.id });
  let status = "❌ Premium yo‘q";

  if (u?.isPremium && u.premiumUntil > new Date()) {
    status = `✅ Premium faol
⏳ Tugaydi: ${u.premiumUntil.toLocaleDateString()}`;
  }

  bot.sendMessage(msg.chat.id,
`⭐ PREMIUM (30 KUN)

${status}

✅ Cheksiz AI
✅ Vision
✅ Limit yo‘q

💳 To‘lov tizimi ulangan`);
});

/* ================= STATS (ADMIN) ================= */
bot.onText(/\/stats/, async msg => {
  if (msg.chat.id !== ADMIN_ID) return;
  const users = await User.countDocuments();
  const premium = await User.countDocuments({ isPremium: true });

  bot.sendMessage(msg.chat.id,
`📊 STATISTIKA

👥 Users: ${users}
⭐ Premium: ${premium}`);
});

/* ================= AI TEXT ================= */
bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const ok = await checkLimit(msg.chat.id);
  if (!ok)
    return bot.sendMessage(msg.chat.id,
"❌ Limit tugadi\n⭐ /premium yoki /ref");

  const res = await openai.chat.completions.create({
    model: "gpt-4.1",
    temperature: 0.7,
    messages: [
      {
        role: "system",
        content:
"Sen professional AI assistantsan. Foydalanuvchiga aniq, tushunarli va foydali javob ber."
      },
      { role: "user", content: msg.text }
    ]
  });

  bot.sendMessage(msg.chat.id, res.choices[0].message.content);
});

/* ================= IMAGE ================= */
bot.on("photo", async msg => {
  const ok = await checkLimit(msg.chat.id);
  if (!ok) return;

  const photo = msg.photo.at(-1);
  const imageUrl = await bot.getFileLink(photo.file_id);

  const res = await openai.responses.create({
    model: "gpt-4.1",
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: "Rasmni chuqur tahlil qil" },
        { type: "input_image", image_url: imageUrl }
      ]
    }]
  });

  bot.sendMessage(msg.chat.id, res.output_text);
});

/* ================= PREMIUM AUTO OFF ================= */
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
"⏳ Premium muddati tugadi");
  }
});

console.log("🚀 ULTRA AI BOT ISHGA TUSHDI");