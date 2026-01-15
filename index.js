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

/* ================= CONFIG ================= */
const ADMIN_ID = Number(process.env.ADMIN_ID);
const BOT_USERNAME = process.env.BOT_USERNAME?.replace("@", "") || "AIEnglishWorld_bot";

// Kanal sozlamalari (.env dan)
const CHANNEL_ID = process.env.CHANNEL_ID;
const CHANNEL_INVITE_LINK = process.env.CHANNEL_INVITE_LINK;

// Limitlar
const FREE_DAILY_LIMIT = 10;
const REFERRALS_FOR_PREMIUM = 5;
const PREMIUM_DAYS = 30;

/* ================= MONGODB ================= */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB ulandi"))
  .catch(err => console.error("❌ MongoDB xato:", err));

/* ================= USER SCHEMA (YANGILANGAN) ================= */
const userSchema = new mongoose.Schema({
  chatId: { type: Number, unique: true },
  username: String,
  firstName: String,
  score: { type: Number, default: 0 },
  level: { type: String, default: "A1" },
  sessions: { type: Number, default: 0 },
  badge: { type: String, default: "🔰 Starter" },
  streak: { type: Number, default: 0 },
  lastActive: String,
  achievements: [String],
  commonMistakes: Array,
  lastMilestone: { type: Number, default: 0 },
  imagesTranslated: { type: Number, default: 0 },
  // YANGI MAYDONLAR
  referralsCount: { type: Number, default: 0 },
  dailyRequests: { type: Number, default: FREE_DAILY_LIMIT },
  premiumEndDate: { type: Date, default: null },
  referredBy: { type: Number, default: null },
  lastRequestDate: { type: Date, default: null },
  joinedAt: { type: Date, default: Date.now }
});
const User = mongoose.model("User", userSchema);

/* ================= SUBSCRIBER SCHEMA (STATISTICS) ================= */
const subscriberSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, required: true },
  username: String,
  firstName: String,
  lastName: String,
  createdAt: { type: Date, default: Date.now },
  lastActiveAt: { type: Date, default: Date.now }
});
const Subscriber = mongoose.model("Subscriber", subscriberSchema);

/* ================= TRACK USER MIDDLEWARE ================= */
async function trackUser(msg) {
  if (!msg.from) return;
  const telegramId = msg.from.id;
  try {
    await Subscriber.findOneAndUpdate(
      { telegramId },
      {
        $setOnInsert: {
          username: msg.from.username,
          firstName: msg.from.first_name,
          lastName: msg.from.last_name,
          createdAt: new Date()
        },
        $set: { lastActiveAt: new Date() }
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error("TrackUser xato:", err);
  }
}

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

/* ================= KANAL A'ZOLIK TEKSHIRUVI ================= */
async function checkSubscription(userId) {
  try {
    const member = await bot.getChatMember(CHANNEL_ID, userId);
    return ["member", "administrator", "creator"].includes(member.status);
  } catch (err) {
    console.error("Kanal tekshiruvi xato:", err.message);
    return false;
  }
}

function getSubscribeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📢 Kanalga a'zo bo'lish", url: CHANNEL_INVITE_LINK }],
      [{ text: "✅ A'zo bo'ldim", callback_data: "check_subscription" }]
    ]
  };
}

async function requireSubscription(chatId, userId) {
  const isSubscribed = await checkSubscription(userId);
  if (isSubscribed) return true;

  await bot.sendMessage(chatId,
    "⚠️ <b>Botdan foydalanish uchun kanalimizga a'zo bo'ling!</b>\n\n" +
    "Kanalga a'zo bo'lgandan keyin \"✅ A'zo bo'ldim\" tugmasini bosing.",
    {
      parse_mode: "HTML",
      reply_markup: getSubscribeKeyboard()
    }
  );
  return false;
}

/* ================= PREMIUM & LIMIT TEKSHIRUVI ================= */
function isPremium(user) {
  if (!user || !user.premiumEndDate) return false;
  return new Date() < new Date(user.premiumEndDate);
}

async function checkAndResetDaily(user) {
  if (!user) return user;

  const lastDate = user.lastRequestDate;
  const today = new Date().toDateString();

  if (!lastDate || new Date(lastDate).toDateString() !== today) {
    // Yangi kun - limitni qayta tiklash
    user.dailyRequests = FREE_DAILY_LIMIT;
    user.lastRequestDate = new Date();
    await user.save();
  }

  return user;
}

async function canMakeRequest(user) {
  if (isPremium(user)) return { allowed: true };
  if (user.dailyRequests > 0) return { allowed: true };
  return { allowed: false, reason: "limit_reached" };
}

async function decrementDailyRequest(user) {
  if (!isPremium(user) && user.dailyRequests > 0) {
    user.dailyRequests -= 1;
    user.lastRequestDate = new Date();
    await user.save();
  }
}

async function grantPremium(userId) {
  const user = await User.findOne({ chatId: userId });
  if (!user) return null;

  let newEndDate;
  if (isPremium(user)) {
    // Mavjud premiumni uzaytirish
    newEndDate = new Date(user.premiumEndDate);
    newEndDate.setDate(newEndDate.getDate() + PREMIUM_DAYS);
  } else {
    // Yangi premium
    newEndDate = new Date();
    newEndDate.setDate(newEndDate.getDate() + PREMIUM_DAYS);
  }

  user.premiumEndDate = newEndDate;
  await user.save();

  return newEndDate.toLocaleDateString("uz-UZ");
}

/* ================= REFERAL LINK ================= */
function getReferralLink(userId) {
  return `https://t.me/${BOT_USERNAME}?start=${userId}`;
}

/* ================= LIMIT XABARI ================= */
async function sendLimitMessage(chatId, userId) {
  const referralLink = getReferralLink(userId);
  await bot.sendMessage(chatId,
    `⚠️ <b>Limitingiz tugadi!</b>\n\n` +
    `Kunlik limit: <b>0/${FREE_DAILY_LIMIT}</b>\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `🎁 <b>1 oy cheksiz ishlatish uchun</b>\n` +
    `5 ta do'stingizni taklif qiling!\n\n` +
    `📨 <b>Sizning havolangiz:</b>\n` +
    `<code>${referralLink}</code>\n\n` +
    `⏰ Yoki ertaga qaytib keling!`,
    { parse_mode: "HTML" }
  );
}

/* ================= CALLBACK HANDLER - KANAL TEKSHIRUVI ================= */
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;

  if (query.data === "check_subscription") {
    const isSubscribed = await checkSubscription(userId);

    if (isSubscribed) {
      await bot.editMessageText(
        "✅ <b>Rahmat!</b> Endi botdan foydalanishingiz mumkin.\n\n/start buyrug'ini bosing.",
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML"
        }
      );
      await bot.answerCallbackQuery(query.id, { text: "✅ A'zolik tasdiqlandi!" });
    } else {
      await bot.answerCallbackQuery(query.id, {
        text: "❌ Siz hali kanalga a'zo bo'lmadingiz!",
        show_alert: true
      });
    }
  }
});

/* ================= /START (REFERAL BILAN) ================= */
bot.onText(/\/start(.*)/, async msg => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await trackUser(msg);

  // Kanal tekshiruvi
  if (!await requireSubscription(chatId, userId)) return;

  // Referal parametrini olish
  const args = msg.text.split(" ");
  let referredBy = null;

  if (args.length > 1) {
    const refId = parseInt(args[1]);
    if (!isNaN(refId) && refId !== userId) {
      referredBy = refId;
    }
  }

  // Foydalanuvchini topish yoki yaratish
  let user = await User.findOne({ chatId });
  const isNewUser = !user;

  if (!user) {
    user = await User.create({
      chatId,
      username: msg.from.username,
      firstName: msg.from.first_name,
      referredBy,
      dailyRequests: FREE_DAILY_LIMIT,
      joinedAt: new Date()
    });

    // Referalni qayta ishlash
    if (referredBy) {
      const referrer = await User.findOne({ chatId: referredBy });
      if (referrer) {
        referrer.referralsCount += 1;
        await referrer.save();

        // Refererni xabardor qilish
        try {
          await bot.sendMessage(referredBy,
            `🎉 <b>Yangi referal!</b>\n\n` +
            `👤 ${msg.from.first_name || "Foydalanuvchi"} sizning havolangiz orqali qo'shildi!\n` +
            `📊 Jami referallar: <b>${referrer.referralsCount}/5</b>`,
            { parse_mode: "HTML" }
          );
        } catch (e) { }

        // Premium tekshiruvi (har 5 ta referal uchun)
        if (referrer.referralsCount > 0 && referrer.referralsCount % REFERRALS_FOR_PREMIUM === 0) {
          const endDate = await grantPremium(referredBy);
          try {
            await bot.sendMessage(referredBy,
              `🏆 <b>TABRIKLAYMIZ!</b>\n\n` +
              `Siz 5 ta referal to'pladingiz va\n` +
              `🎁 <b>1 OY CHEKSIZ LIMIT</b> oldingiz!\n\n` +
              `📅 Premium muddat: <b>${endDate}</b> gacha\n\n` +
              `Yana 5 ta referal = yana 1 oy! 🚀`,
              { parse_mode: "HTML" }
            );
          } catch (e) { }
        }
      }
    }
  }

  userMode[chatId] = "chat";
  chatHistory[chatId] = [];

  await checkAndResetDaily(user);

  bot.sendMessage(chatId,
    `👋 <b>Salom, ${msg.from.first_name}!</b>\n\n` +
    `🤖 <b>AI English Learning Bot</b>\n\n` +
    `🧠 Chat AI — savol-javob\n` +
    `📘 Tarjima — matn tarjimasi\n` +
    `🗣 Speak English — gapirib o'rganish\n` +
    `👤 Profil — limit va premium\n` +
    `🔗 Referal — do'stlarni taklif qiling\n\n` +
    `👇 <b>Rejimni tanlang:</b>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        keyboard: [
          [{ text: "🧠 Chat AI" }, { text: "📘 Tarjima" }],
          [{ text: "🗣 Speak English" }],
          [{ text: "👤 Profil" }, { text: "🔗 Referal" }],
          [{ text: "/help" }]
        ],
        resize_keyboard: true
      }
    });
});

/* ================= HELP ================= */
bot.onText(/\/help/, async msg => {
  const chatId = msg.chat.id;
  await trackUser(msg);

  if (!await requireSubscription(chatId, msg.from.id)) return;

  bot.sendMessage(chatId,
    `ℹ️ <b>YORDAM</b>\n\n` +
    `🧠 <b>Chat AI</b> — ingliz tili bo'yicha savol-javob\n` +
    `📘 <b>Tarjima</b> — matnlarni tarjima qilish\n` +
    `🗣 <b>Speak English</b> — ovoz yuborib mashq qilish\n\n` +
    `📸 <b>Rasm</b> yuborsangiz — tarjima qilinadi\n` +
    `🎤 <b>Ovoz</b> yuborsangiz — tekshiriladi\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `💎 <b>PREMIUM OLISH:</b>\n` +
    `5 ta do'stingizni taklif qiling = 1 oy cheksiz!\n` +
    `🔗 /referal — referal havolangiz`,
    { parse_mode: "HTML" });
});

/* ================= REFERAL ================= */
bot.onText(/\/referal|🔗 Referal/, async msg => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await trackUser(msg);

  if (!await requireSubscription(chatId, userId)) return;

  let user = await User.findOne({ chatId });
  if (!user) {
    user = await User.create({
      chatId,
      username: msg.from.username,
      firstName: msg.from.first_name
    });
  }

  const referralLink = getReferralLink(userId);
  const referralsCount = user.referralsCount || 0;
  const remaining = REFERRALS_FOR_PREMIUM - (referralsCount % REFERRALS_FOR_PREMIUM);
  const status = isPremium(user) ? "💎 PREMIUM" : "🆓 FREE";

  bot.sendMessage(chatId,
    `🔗 <b>REFERAL DASTURI</b>\n\n` +
    `📊 Sizning referallaringiz: <b>${referralsCount}</b>\n` +
    `🎯 Premium uchun qoldi: <b>${remaining}</b> ta\n` +
    `📌 Status: ${status}\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `📨 <b>Sizning havolangiz:</b>\n` +
    `<code>${referralLink}</code>\n\n` +
    `☝️ Bu havolani do'stlaringizga yuboring!\n` +
    `5 ta odam qo'shilsa = <b>1 OY CHEKSIZ</b> 🎁`,
    { parse_mode: "HTML" });
});

/* ================= PROFIL ================= */
bot.onText(/👤 Profil/, async msg => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await trackUser(msg);

  if (!await requireSubscription(chatId, userId)) return;

  let user = await User.findOne({ chatId });
  if (!user) {
    user = await User.create({
      chatId,
      username: msg.from.username,
      firstName: msg.from.first_name
    });
  }

  user = await checkAndResetDaily(user);
  const premium = isPremium(user);

  let statusText, limitText;
  if (premium) {
    const endDate = new Date(user.premiumEndDate).toLocaleDateString("uz-UZ");
    statusText = `💎 <b>PREMIUM</b> (${endDate} gacha)`;
    limitText = "♾ <b>CHEKSIZ</b>";
  } else {
    statusText = "🆓 FREE";
    limitText = `📊 <b>${user.dailyRequests}/${FREE_DAILY_LIMIT}</b>`;
  }

  bot.sendMessage(chatId,
    `👤 <b>SIZNING PROFILINGIZ</b>\n\n` +
    `🆔 ID: <code>${userId}</code>\n` +
    `📌 Status: ${statusText}\n` +
    `📱 Kunlik limit: ${limitText}\n` +
    `🔗 Referallar: <b>${user.referralsCount || 0}</b>\n` +
    `🏅 Badge: ${user.badge}\n` +
    `⭐ Score: ${user.score}\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `💡 <b>PREMIUM OLISH:</b>\n` +
    `5 ta do'stni taklif qiling = 1 oy cheksiz!`,
    { parse_mode: "HTML" });
});

/* ================= STATS (ADMIN ONLY) ================= */
bot.onText(/\/stats/, async msg => {
  const chatId = msg.chat.id;
  await trackUser(msg);

  if (msg.from.id !== ADMIN_ID) {
    return bot.sendMessage(chatId, "⛔ Bu buyruq faqat admin uchun.");
  }

  const now = new Date();
  const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);

  const totalUsers = await Subscriber.countDocuments();
  const active24h = await Subscriber.countDocuments({ lastActiveAt: { $gte: oneDayAgo } });
  const active7d = await Subscriber.countDocuments({ lastActiveAt: { $gte: sevenDaysAgo } });
  const premiumUsers = await User.countDocuments({ premiumEndDate: { $gt: now } });

  bot.sendMessage(chatId,
    `📊 <b>BOT STATISTIKASI</b>\n\n` +
    `👥 Jami foydalanuvchilar: <b>${totalUsers}</b>\n` +
    `🟢 24 soatda faol: <b>${active24h}</b>\n` +
    `📅 7 kunda faol: <b>${active7d}</b>\n` +
    `💎 Premium foydalanuvchilar: <b>${premiumUsers}</b>`,
    { parse_mode: "HTML" });
});

/* ================= RESET LIMITS (ADMIN ONLY) ================= */
bot.onText(/\/reset_limits/, async msg => {
  const chatId = msg.chat.id;
  if (msg.from.id !== ADMIN_ID) {
    return bot.sendMessage(chatId, "⛔ Bu buyruq faqat admin uchun.");
  }

  const now = new Date();
  await User.updateMany(
    { $or: [{ premiumEndDate: null }, { premiumEndDate: { $lt: now } }] },
    { $set: { dailyRequests: FREE_DAILY_LIMIT } }
  );

  bot.sendMessage(chatId, "✅ Barcha foydalanuvchilar uchun kunlik limitlar qayta tiklandi.");
});

/* ================= MODE SWITCH ================= */
bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await trackUser(msg);
  const text = msg.text;
  if (!text) return;

  // Buyruqlarni o'tkazib yuborish
  if (text.startsWith("/")) return;

  // Maxsus tugmalarni tekshirish
  if (text === "🧠 Chat AI" || text === "📘 Tarjima" || text === "🗣 Speak English" ||
    text === "👤 Profil" || text === "🔗 Referal") {

    // Kanal tekshiruvi
    if (!await requireSubscription(chatId, userId)) return;

    if (text === "🧠 Chat AI") {
      userMode[chatId] = "chat";
      return bot.sendMessage(chatId, "🧠 <b>Chat AI</b> rejimi yoqildi.\n\nSavol bering!", { parse_mode: "HTML" });
    }

    if (text === "📘 Tarjima") {
      userMode[chatId] = "translate";
      return bot.sendMessage(chatId, "📘 <b>Tarjima</b> rejimi yoqildi.\n\nMatn yuboring!", { parse_mode: "HTML" });
    }

    if (text === "🗣 Speak English") {
      userMode[chatId] = "speak";
      return bot.sendMessage(chatId, "🗣 <b>Speak English</b> rejimi yoqildi.\n\nOvoz xabar yuboring!", { parse_mode: "HTML" });
    }

    // Profil va Referal alohida handler larda
    return;
  }

  // Kanal tekshiruvi
  if (!await requireSubscription(chatId, userId)) return;

  // Foydalanuvchini olish va limitni tekshirish
  let user = await User.findOne({ chatId });
  if (!user) {
    user = await User.create({
      chatId,
      username: msg.from.username,
      firstName: msg.from.first_name
    });
  }

  user = await checkAndResetDaily(user);
  const { allowed } = await canMakeRequest(user);

  if (!allowed) {
    return sendLimitMessage(chatId, userId);
  }

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

    // Limitni kamaytirish
    await decrementDailyRequest(user);

    bot.sendMessage(chatId, answer);

  } catch (err) {
    console.error("OpenAI xato:", err);
    bot.sendMessage(chatId, "❌ Xatolik yuz berdi.");
  }
});

/* ================= IMAGE TRANSLATION (LIMITED) ================= */
bot.on("photo", async msg => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await trackUser(msg);

  // Kanal tekshiruvi
  if (!await requireSubscription(chatId, userId)) return;

  let user = await User.findOne({ chatId });
  if (!user) {
    user = await User.create({
      chatId,
      username: msg.from.username,
      firstName: msg.from.first_name
    });
  }

  user = await checkAndResetDaily(user);
  const { allowed } = await canMakeRequest(user);

  if (!allowed) {
    return sendLimitMessage(chatId, userId);
  }

  const photo = msg.photo.at(-1);
  const file = await bot.getFile(photo.file_id);
  const imageUrl =
    `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
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
    await decrementDailyRequest(user);
    await user.save();

    bot.sendMessage(chatId, res.choices[0].message.content);
  } catch (err) {
    console.error("Rasm xato:", err);
    bot.sendMessage(chatId, "❌ Rasmni qayta ishlashda xatolik yuz berdi.");
  }
});

/* ================= VOICE (SPEAK MODE ONLY) ================= */
bot.on("voice", async msg => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  await trackUser(msg);

  // Kanal tekshiruvi
  if (!await requireSubscription(chatId, userId)) return;

  if (userMode[chatId] !== "speak") {
    return bot.sendMessage(chatId, "🗣 Avval \"Speak English\" rejimini tanlang!");
  }

  let user = await User.findOne({ chatId });
  if (!user) {
    user = await User.create({
      chatId,
      username: msg.from.username,
      firstName: msg.from.first_name
    });
  }

  user = await checkAndResetDaily(user);
  const { allowed } = await canMakeRequest(user);

  if (!allowed) {
    return sendLimitMessage(chatId, userId);
  }

  const file = await bot.getFile(msg.voice.file_id);
  const oggPath = path.join(__dirname, `${chatId}.ogg`);
  const mp3Path = path.join(__dirname, `${chatId}.mp3`);

  const stream = bot.getFileStream(file.file_id);
  stream.pipe(fs.createWriteStream(oggPath)).on("finish", async () => {

    try {
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

      await decrementDailyRequest(user);

      const gtts = new gTTS(completion.choices[0].message.content, "en");
      gtts.save(mp3Path, async () => {
        await bot.sendVoice(chatId, mp3Path);
        fs.unlinkSync(mp3Path);
      });

      fs.unlinkSync(oggPath);
    } catch (err) {
      console.error("Ovoz xato:", err);
      bot.sendMessage(chatId, "❌ Ovozni qayta ishlashda xatolik yuz berdi.");
      if (fs.existsSync(oggPath)) fs.unlinkSync(oggPath);
    }
  });
});

console.log("🚀 BOT ISHGA TUSHDI (MongoDB + Force Join + Referal + Limits)");