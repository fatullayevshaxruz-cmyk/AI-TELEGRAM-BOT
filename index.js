require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const gTTS = require("gtts");

/* ================= INIT ================= */
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ================= MONGODB ================= */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB ulandi"))
  .catch(err => console.error("❌ MongoDB xato:", err));

/* ================= USER SCHEMA ================= */
const userSchema = new mongoose.Schema({
  chatId: Number,
  score: { type: Number, default: 0 },
  level: { type: String, default: "A1" },
  sessions: { type: Number, default: 0 },
  badge: { type: String, default: "🔰 Starter" },
  streak: { type: Number, default: 0 },
  lastActive: String,
  achievements: [String],
  commonMistakes: Array,
  lastMilestone: { type: Number, default: 0 },
  imagesTranslated: { type: Number, default: 0 }
});
const User = mongoose.model("User", userSchema);

/* ================= MEMORY (CHEAP) ================= */
const chatHistory = {};   // faqat oxirgi 2 ta xabar
const userMode = {};      // chat | translate | speak

function pushHistory(chatId, role, content) {
  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  chatHistory[chatId].push({ role, content });
  if (chatHistory[chatId].length > 2) chatHistory[chatId].shift(); // 💸 TEJAM
}

/* ================= BADGE ================= */
function getBadge(score) {
  if (score >= 50) return "🏆 Fluent";
  if (score >= 30) return "🥇 Advanced";
  if (score >= 15) return "🥈 Intermediate";
  if (score >= 5) return "🥉 Beginner";
  return "🔰 Starter";
}

/* ================= /START ================= */
bot.onText(/\/start/, async msg => {
  const chatId = msg.chat.id;

  let user = await User.findOne({ chatId });
  if (!user) user = await User.create({ chatId });

  userMode[chatId] = "chat";
  chatHistory[chatId] = [];

  bot.sendMessage(chatId,
`👋 Salom!

🤖 AI English Learning Bot

🧠 Chat AI
📘 Tarjima (matn + rasm)
🗣 Speak English (ovoz bilan)
🏅 Progress, Level, Badge

👇 Rejimni tanlang`,
{
  reply_markup: {
    keyboard: [
      [{ text: "🧠 Chat AI" }, { text: "📘 Tarjima" }],
      [{ text: "🗣 Speak English" }],
      [{ text: "/help" }]
    ],
    resize_keyboard: true
  }
});
});

/* ================= HELP ================= */
bot.onText(/\/help/, msg => {
  bot.sendMessage(msg.chat.id,
`ℹ️ YORDAM

🧠 Chat AI — savol-javob
📘 Tarjima — matn yoki rasm
🗣 Speak English — gapirib o‘rganish

📸 Rasm yuborsangiz — tarjima qilinadi
🎤 Ovoz yuborsangiz — tekshiriladi`);
});

/* ================= MODE SWITCH ================= */
bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  if (text === "🧠 Chat AI") {
    userMode[chatId] = "chat";
    return bot.sendMessage(chatId, "🧠 Chat AI yoqildi.");
  }

  if (text === "📘 Tarjima") {
    userMode[chatId] = "translate";
    return bot.sendMessage(chatId, "📘 Tarjima rejimi yoqildi.");
  }

  if (text === "🗣 Speak English") {
    userMode[chatId] = "speak";
    return bot.sendMessage(chatId, "🗣 Speak English yoqildi. Ovoz yuboring!");
  }

  if (text.startsWith("/")) return;

  /* ================= TEXT AI (ARZON) ================= */
  let systemPrompt = "Answer clearly in user's language.";

  if (userMode[chatId] === "translate") {
    systemPrompt = "Translate the text to Uzbek clearly.";
  }

  if (userMode[chatId] === "speak") {
    systemPrompt = "Reply only in English. Correct mistakes briefly.";
  }

  pushHistory(chatId, "user", text);

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",       // 💸 ENG ARZON
      max_tokens: 180,            // 💸 CHEKLOV
      temperature: 0.6,
      messages: [
        { role: "system", content: systemPrompt },
        ...chatHistory[chatId]
      ]
    });
const answer = res.choices[0].message.content;
    pushHistory(chatId, "assistant", answer);
    bot.sendMessage(chatId, answer);

  } catch {
    bot.sendMessage(chatId, "❌ Xatolik yuz berdi.");
  }
});

/* ================= IMAGE TRANSLATION (LIMITED) ================= */
bot.on("photo", async msg => {
  const chatId = msg.chat.id;
  let user = await User.findOne({ chatId });

  if (user.imagesTranslated >= 2) {
    return bot.sendMessage(chatId,
      "📸 Rasm limiti tugadi (kuniga 2 ta).");
  }

  const photo = msg.photo.at(-1);
  const file = await bot.getFile(photo.file_id);
  const imageUrl =
    `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",     // ❌ gpt-4o emas → 💸
    max_tokens: 300,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Extract text and translate to Uzbek." },
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    }]
  });

  user.imagesTranslated += 1;
  user.score += 1;
  user.badge = getBadge(user.score);
  await user.save();

  bot.sendMessage(chatId, res.choices[0].message.content);
});

/* ================= VOICE (SPEAK MODE ONLY) ================= */
bot.on("voice", async msg => {
  const chatId = msg.chat.id;
  if (userMode[chatId] !== "speak") return;

  const file = await bot.getFile(msg.voice.file_id);
  const oggPath = path.join(__dirname, `${chatId}.ogg`);
  const mp3Path = path.join(__dirname, `${chatId}.mp3`);

  const stream = bot.getFileStream(file.file_id);
  stream.pipe(fs.createWriteStream(oggPath)).on("finish", async () => {

    const transcript = await openai.audio.transcriptions.create({
      file: fs.createReadStream(oggPath),
      model: "whisper-1"
    });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 120,
      messages: [
        { role: "system", content: "Correct the English shortly." },
        { role: "user", content: transcript.text }
      ]
    });

    const gtts = new gTTS(completion.choices[0].message.content, "en");
    gtts.save(mp3Path, async () => {
      await bot.sendVoice(chatId, mp3Path);
      fs.unlinkSync(mp3Path);
    });

    fs.unlinkSync(oggPath);
  });
});

console.log("🚀 BOT ISHGA TUSHDI (MongoDB + Cheap GPT)");