require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const OpenAI = require("openai");

/* ===== BOT ===== */
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
  isPremium: { type: Boolean, default: false }
});
const User = mongoose.model("User", userSchema);

const today = () => new Date().toISOString().slice(0, 10);

/* ===== LIMIT ===== */
async function checkLimit(chatId) {
  let user = await User.findOne({ chatId });
  if (!user) user = await User.create({ chatId, date: today() });

  if (user.date !== today()) {
    user.daily = 0;
    user.date = today();
  }

  if (user.isPremium) return true;
  if (user.daily >= 10) return false;

  user.daily++;
  await user.save();
  return true;
}

/* ===== START ===== */
bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id;

  if (!await User.findOne({ chatId })) {
    await User.create({ chatId, date: today() });
  }

  bot.sendMessage(chatId,
`👋 Salom!

🤖 AI Telegram Bot
🧠 Savol bering
🖼 Rasm yuboring

⏳ Kuniga 10 bepul
⭐ Premium — cheksiz`,
{
  reply_markup: {
    keyboard: [
      [{ text: "/ai" }, { text: "/premium" }],
      [{ text: "/help" }]
    ],
    resize_keyboard: true
  }
});
});

/* ===== AI BUTTON ===== */
bot.onText(/\/ai/, msg => {
  bot.sendMessage(msg.chat.id,
`🤖 AI bo‘limi

Menga istalgan savol yozing ✍️
Men sizga yordam beraman 🙂`);
});

/* ===== PREMIUM BUTTON ===== */
bot.onText(/\/premium/, msg => {
  bot.sendMessage(msg.chat.id,
`⭐ PREMIUM TARIF

✅ Cheksiz AI javoblar
✅ Rasm tahlili
✅ Limit yo‘q

💳 30 kunlik premium
(pul ulash keyin qo‘shiladi)`);
});

/* ===== HELP ===== */
bot.onText(/\/help/, msg => {
  bot.sendMessage(msg.chat.id,
`ℹ️ Yordam

/ai — AI bilan suhbat
/premium — premium ma’lumot
/help — yordam

🧠 Savol yozing
🖼 Rasm yuboring`);
});

/* ===== TEXT MESSAGE ===== */
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
      { role: "system", content: "Answer in user's language clearly." },
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

console.log("🤖 BOT ISHGA TUSHDI");