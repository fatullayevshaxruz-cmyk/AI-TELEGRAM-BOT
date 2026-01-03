require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const OpenAI = require("openai");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

/* ================= INIT ================= */
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini = genAI.getGenerativeModel({ model: "gemini-pro" });

/* ================= LOCAL DB ================= */
const DATA_FILE = path.join(__dirname, "data.json");
let userData = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE))
  : {};

function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(userData, null, 2));
}

/* ================= MEMORY ================= */
const chatHistory = {};
const userMode = {}; // chat | translate | speak

/* ================= CACHE ================= */
const aiCache = new Map();
const CACHE_TTL = 1000 * 60 * 30;

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

/* ================= PROMPTS (TOKEN TEJAMKOR) ================= */
const CHAT_PROMPT = 
`Answer in the user's language.
Be brief (max 3–4 sentences).
No repetition.`
;

const TRANSLATE_PROMPT = 
`Translate the text into Uzbek (Cyrillic).
Add only 1 short explanation if needed.`
;

const SPEAK_PROMPT = 
`You are an English teacher.
Correct mistakes briefly.
1 short explanation.
Speak only English.`
;

/* ================= GEMINI FALLBACK ================= */
async function askGemini(text) {
  const result = await gemini.generateContent(text);
  return result.response.text();
}

/* ================= START ================= */
bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;

  if (!userData[chatId]) {
    userData[chatId] = {
      score: 0,
      level: "A1",
      sessions: 0
    };
    saveData();
  }

  userMode[chatId] = "chat";
  chatHistory[chatId] = [];

  bot.sendMessage(
    chatId,
`👋 Salom!

🤖 AI SPEAKING BOT
🧠 Chat AI
📘 Tarjima
🗣 Speak English

👇 Rejimni tanlang`,
    {
      reply_markup: {
        keyboard: [
          [{ text: "🧠 Chat AI" }, { text: "📘 Tarjima" }],
          [{ text: "🗣 Speak English" }]
        ],
        resize_keyboard: true
      }
    }
  );
});

/* ================= MODE SWITCH ================= */
bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  if (text === "🧠 Chat AI") {
    userMode[chatId] = "chat";
    return bot.sendMessage(chatId, "🧠 Chat AI yoqildi. Savol yozing.");
  }

  if (text === "📘 Tarjima") {
    userMode[chatId] = "translate";
    return bot.sendMessage(chatId, "📘 Tarjima rejimi. Matn yuboring.");
  }

  if (text === "🗣 Speak English") {
    userMode[chatId] = "speak";
    return bot.sendMessage(chatId, "🗣 Speak English. Inglizcha yozing.");
  }

  if (text.startsWith("/")) return;

  /* ================= CHAT HISTORY ================= */
  if (!chatHistory[chatId]) chatHistory[chatId] = [];
  chatHistory[chatId].push({ role: "user", content: text });

  if (chatHistory[chatId].length > 6) {
    chatHistory[chatId].shift();
  }

  /* ================= CACHE ================= */
  const cacheKey = `${userMode[chatId]}:${text.toLowerCase()}`;
  const cached = getCache(cacheKey);
  if (cached) {
    return bot.sendMessage(chatId, cached);
  }

  /* ================= PROMPT SELECT ================= */
  let systemPrompt = CHAT_PROMPT;
  if (userMode[chatId] === "translate") systemPrompt = TRANSLATE_PROMPT;
  if (userMode[chatId] === "speak") systemPrompt = SPEAK_PROMPT;

  /* ================= AI REQUEST ================= */
  let answer;
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.4,
      max_tokens: 400,
      messages: [
        { role: "system", content: systemPrompt },
        ...chatHistory[chatId]
      ]
    });

    answer = res.choices[0].message.content;

  } catch (err) {
    console.log("⚠️ OpenAI ishlamadi → Gemini ishladi");
    answer = await askGemini(text);
  }

  chatHistory[chatId].push({ role: "assistant", content: answer });
  setCache(cacheKey, answer);

  bot.sendMessage(chatId, answer);
});

/* ================= READY ================= */
console.log("🚀 AI BOT ISHGA TUSHDI");
console.log("✅ OpenAI + Gemini fallback");
console.log("✅ Cache enabled");
console.log("✅ Token optimized (40–50%)");