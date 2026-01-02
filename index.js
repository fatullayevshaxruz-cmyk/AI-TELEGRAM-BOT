/**** CLUSTER ****/
const cluster = require("cluster");
const os = require("os");

const CPU_COUNT = Math.min(os.cpus().length, 2);

if (cluster.isPrimary) {
  console.log(`🚀 MASTER ishga tushdi | CPU: ${CPU_COUNT}`);
  for (let i = 0; i < CPU_COUNT; i++) cluster.fork();

  cluster.on("exit", () => {
    console.log("⚠️ Worker o‘chdi, qayta ishga tushdi");
    cluster.fork();
  });
  return;
}

/**** INIT ****/
require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const OpenAI = require("openai");
const cron = require("node-cron");

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: cluster.worker.id === 1
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**** MONGO ****/
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB ulandi"))
  .catch(e => console.log("❌ Mongo error", e));

/**** USER MODEL ****/
const userSchema = new mongoose.Schema({
  chatId: { type: Number, unique: true },
  daily: { type: Number, default: 0 },
  date: String,
  isPremium: { type: Boolean, default: false },
  premiumUntil: Date,
  referredBy: Number
});

const User = mongoose.model("User", userSchema);

/**** HELPERS ****/
const today = () => new Date().toISOString().slice(0, 10);
const REF_DAYS = 3;

/**** CACHE ****/
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 30;

function getCache(key) {
  const c = cache.get(key);
  if (!c) return null;
  if (Date.now() > c.expire) {
    cache.delete(key);
    return null;
  }
  return c.value;
}
function setCache(key, value) {
  cache.set(key, { value, expire: Date.now() + CACHE_TTL });
}

/**** LIMIT ****/
async function checkLimit(chatId) {
  let u = await User.findOne({ chatId });
  if (!u) u = await User.create({ chatId, date: today() });

  if (u.date !== today()) {
    u.daily = 0;
    u.date = today();
  }

  if (u.isPremium && u.premiumUntil > new Date()) return true;
  if (u.daily >= 10) return false;

  u.daily++;
  await u.save();
  return true;
}

/**** /START + REF ****/
bot.onText(/\/start(?:\s+(\d+))?/, async (msg, match) => {
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
            ? new Date(refUser.premiumUntil.getTime() + REF_DAYS * 86400000)
            : new Date(now.getTime() + REF_DAYS * 86400000);
        await refUser.save();

        bot.sendMessage(refId, `🎉 +${REF_DAYS} kun PREMIUM berildi`);
      }
    }
  }

  bot.sendMessage(chatId,
`👋 Salom!

🤖 AI Premium Bot
⏳ Kuniga 10 bepul
⭐ Premium — kuchli va tez

Buyruqlar:
/ai
/premium
/ref
/help`,
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

/**** /AI ****/
bot.onText(/\/ai/, async msg => {
  const chatId = msg.chat.id;

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: "Detect the user's language and answer in that language."
      },
      {
        role: "user",
        content:
          "Write a short message saying: 'You are using the stronger and faster version of AI available in the premium plan.'"
      }
    ]
  });

  bot.sendMessage(
    chatId,
`🤖 AI tayyor. Savolingizni yozing ✍️

${res.choices[0].message.content}
  `);
});
/**** /HELP ****/
bot.onText(/\/help/, msg =>
  bot.sendMessage(msg.chat.id,
`ℹ️ Yordam:
/ai — AI suhbat
/premium — Premium
/ref — Do‘st chaqirish`)
);

/**** /REF ****/
bot.onText(/\/ref/, msg => {
  const link = `https://t.me/${process.env.BOT_USERNAME}?start=${msg.chat.id}`;
  bot.sendMessage(msg.chat.id,
`👥 Do‘st chaqiring
🎁 Har biri = ${REF_DAYS} kun premium

${link}`);
});

/**** /PREMIUM + STARS ****/
bot.onText(/\/premium/, msg => {
  bot.sendMessage(msg.chat.id,
`⭐ PREMIUM TARIFI (30 kun)

✅ AI ning kuchli va yanada tez versiyasi
✅ GPT-4.1 PRO
✅ Rasm tarjima va tahlil
✅ Limit yo‘q

Pastdagi tugma orqali to‘lov qiling 👇
  `);

  // ⭐ TELEGRAM STARS
  bot.sendInvoice(
    msg.chat.id,
    "⭐ Premium (30 kun)",
    "Cheksiz AI + tezkor javoblar",
    "premium_30_days",
    "",          // Stars uchun bo‘sh
    "XTR",       // Telegram Stars
    [{ label: "Premium 30 kun", amount: 100 }] // 100 ⭐
  );
});

/**** PAYMENT SUCCESS ****/
bot.on("successful_payment", async msg => {
  const chatId = msg.chat.id;
  const until = new Date(Date.now() + 30 * 86400000);

  await User.updateOne(
    { chatId },
    { isPremium: true, premiumUntil: until },
    { upsert: true }
  );

  bot.sendMessage(
    chatId,
    "⭐ To‘lov qabul qilindi!\nPremium 30 kunga yoqildi 🚀"
  );
});

/**** AI TEXT ****/
bot.on("message", async msg => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const key = text.toLowerCase();

  const ok = await checkLimit(chatId);
  if (!ok) return bot.sendMessage(chatId, "❌ Limit tugadi\n/premium");

  const cached = getCache(key);
  if (cached) return bot.sendMessage(chatId, cached);

  const user = await User.findOne({ chatId });
  const isPremium = user?.isPremium && user?.premiumUntil > new Date();

  const modelName = isPremium ? "gpt-4.1" : "gpt-4.1-mini";

  const res = await openai.chat.completions.create({
    model: modelName,
    temperature: isPremium ? 0.4 : 0.7,
    messages: [
      {
        role: "system",
        content: "Answer in the same language as the user's question."
      },
      { role: "user", content: text }
    ]
  });

  const answer = res.choices[0].message.content;
  setCache(key, answer);
  bot.sendMessage(chatId, answer);
});

/**** IMAGE ****/
bot.on("photo", async msg => {
  const chatId = msg.chat.id;

  const ok = await checkLimit(chatId);
  if (!ok) {
    return bot.sendMessage(
      chatId,
      "❌ Kunlik limit tugadi.\n⭐ Premium bilan cheksiz foydalaning"
    );
  }

  const photo = msg.photo.at(-1);
  const imageUrl = await bot.getFileLink(photo.file_id);

  await bot.sendChatAction(chatId, "typing");

  const res = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: 
`Rasmdagi barcha matnni foydalanuvchi tiliga tarjima qil.
So‘ng pastida qisqa va tushunarli qilib mazmunini tushuntir.`

`QOIDALAR:
- Avval: "📘 TARJIMA" sarlavhasi ostida tarjima
- Keyin: "📝 TUSHUNTIRISH" sarlavhasi ostida izoh
- Hech qanday grammatik tahlil yoki xato izlash yozma
- Sodda va tushunarli yoz`

          },
          {
            type: "input_image",
            image_url: imageUrl
          }
        ]
      }
    ]
  });

  bot.sendMessage(chatId, res.output_text);
});

/**** PREMIUM AUTO OFF ****/
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
    bot.sendMessage(u.chatId, "⏳ Premium muddati tugadi");
  }
});

console.log(`🤖 WORKER ${cluster.worker.id} ISHGA TUSHDI`);