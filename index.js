    require("dotenv").config();
    const TelegramBot = require("node-telegram-bot-api");
    const OpenAI = require("openai");
    const fs = require("fs");
    const path = require("path");
    const gTTS = require("gtts");

    /* ===== INIT ===== */
    const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    /* ===== DATA FILE (LOCAL DB) ===== */
    const DATA_FILE = path.join(__dirname, "data.json");
    let userData = fs.existsSync(DATA_FILE)
      ? JSON.parse(fs.readFileSync(DATA_FILE))
      : {};

    function saveData() {
      fs.writeFileSync(DATA_FILE, JSON.stringify(userData, null, 2));
    }

    /* ===== MEMORY ===== */
    const chatHistory = {};
    const userMode = {}; // chat | translate | speak

    /* ===== BADGE SYSTEM ===== */
    function getBadge(score) {
      if (score >= 50) return "🏆 Fluent";
      if (score >= 30) return "🥇 Advanced";
      if (score >= 15) return "🥈 Intermediate";
      if (score >= 5) return "🥉 Beginner";
      return "🔰 Starter";
    }

    /* ===== VOCABULARY ===== */
    const vocabulary = {
      A1: [
        { word: "hello", meaning: "salom" },
        { word: "thank you", meaning: "rahmat" },
        { word: "good morning", meaning: "xayrli tong" },
        { word: "friend", meaning: "do'st" },
        { word: "family", meaning: "oila" }
      ],
      A2: [
        { word: "appreciate", meaning: "qadrlamoq" },
        { word: "although", meaning: "garchi" },
        { word: "convenient", meaning: "qulay" },
        { word: "experience", meaning: "tajriba" },
        { word: "improve", meaning: "yaxshilamoq" }
      ],
      B1: [
        { word: "accomplish", meaning: "amalga oshirmoq" },
        { word: "anxious", meaning: "xavotirli" },
        { word: "benefit", meaning: "foyda" },
        { word: "challenge", meaning: "qiyinchilik" },
        { word: "determine", meaning: "aniqlash" }
      ],
      B2: [
        { word: "ambiguous", meaning: "noaniq" },
        { word: "comprehensive", meaning: "keng qamrovli" },
        { word: "dedicate", meaning: "bag'ishlamoq" },
        { word: "inevitable", meaning: "muqarrar" },
        { word: "sophisticated", meaning: "murakkab" }
      ]
    };

    /* ===== DAILY CHALLENGES ===== */
    const dailyChallenges = [
      "Introduce yourself in 30 seconds",
      "Describe your daily routine",
      "Talk about your favorite food",
      "Tell a short story about your weekend",
      "Describe your dream job",
      "Talk about your hobbies",
      "Explain how to make tea or coffee",
      "Describe your best friend"
    ];

    /* ===== GRAMMAR TIPS ===== */
    const grammarTips = [
      "Use 'have been' for Present Perfect Continuous: I have been studying English for 2 years.",
      "Don't forget 's' in 3rd person: He plays, She works, It runs.",
      "Use 'would' for polite requests: Would you help me?",
      "Past Simple vs Present Perfect: I saw him yesterday (specific time) vs I have seen him (experience).",
      "Use 'going to' for plans: I'm going to visit my friend tomorrow.",
      "Articles: Use 'a/an' for first mention, 'the' for specific things.",
      "Prepositions of time: at (at 5pm), on (on Monday), in (in January)."
    ];

    /* ===== CONVERSATION STARTERS ===== */
    const starters = [
      "What did you do last weekend?",
      "What's your favorite season and why?",
      "Tell me about your hometown",
      "What hobbies do you enjoy?",
      "Describe your perfect day",
      "What's your favorite book or movie?",
      "Tell me about your family",
      "What are your future goals?"
    ];

    /* ===== ACHIEVEMENTS ===== */
    const achievements = {
      first_voice: { name: "🎤 First Speaker", description: "Send your first voice message" },
      ten_sessions: { name: "🔟 10 Sessions", description: "Complete 10 speaking sessions" },
      week_streak: { name: "🔥 Week Warrior", description: "Practice 7 days in a row" },
      fifty_points: { name: "⭐ 50 Points Master", description: "Reach 50 points" },
      hundred_points: { name: "💯 Century!", description: "Reach 100 points" },
      level_b1: { name: "📚 B1 Achiever", description: "Reach B1 level" },
      first_image: { name: "📸 Image Explorer", description: "Translate your first image" }
    };
    /* ===== STREAK SYSTEM ===== */
    function updateStreak(chatId) {
      const user = userData[chatId];
      const today = new Date().toDateString();
      
      if (user.lastActive === today) return;
      
      const yesterday = new Date(Date.now() - 86400000).toDateString();
      
      if (user.lastActive === yesterday) {
        user.streak += 1;
      } else {
        user.streak = 1;
      }
      
      user.lastActive = today;
      
      if (user.streak % 7 === 0) {
        bot.sendMessage(chatId, 
    `🔥 ${user.streak} KUN KETMA-KET!

    🎁 Bonus: +10 ball
        `);
        user.score += 10;
      }
      
      saveData();
    }

    /* ===== ACHIEVEMENTS CHECK ===== */
    function checkAchievements(chatId) {
      const user = userData[chatId];
      if (!user.achievements) user.achievements = [];
      
      const unlocked = [];
      
      if (user.sessions === 1 && !user.achievements.includes("first_voice")) {
        unlocked.push("first_voice");
      }
      
      if (user.sessions === 10 && !user.achievements.includes("ten_sessions")) {
        unlocked.push("ten_sessions");
      }
      
      if (user.streak >= 7 && !user.achievements.includes("week_streak")) {
        unlocked.push("week_streak");
      }
      
      if (user.score >= 50 && !user.achievements.includes("fifty_points")) {
        unlocked.push("fifty_points");
      }
      
      if (user.score >= 100 && !user.achievements.includes("hundred_points")) {
        unlocked.push("hundred_points");
      }
      
      if (user.level === "B1" && !user.achievements.includes("level_b1")) {
        unlocked.push("level_b1");
      }
      
      unlocked.forEach(ach => {
        user.achievements.push(ach);
        const achievement = achievements[ach];
        bot.sendMessage(chatId, 
    `🎉 NEW ACHIEVEMENT UNLOCKED!

    ${achievement.name}
    ${achievement.description}

    🎁 Bonus: +5 points!`
        );
        user.score += 5;
      });
      
      if (unlocked.length > 0) saveData();
    }

    /* ===== MILESTONE REWARDS ===== */
    function checkMilestone(chatId) {
      const user = userData[chatId];
      
      if (user.score % 100 === 0 && user.score > 0 && user.lastMilestone !== user.score) {
        user.lastMilestone = user.score;
        bot.sendMessage(chatId, 
    `🎉 CONGRATULATIONS!

    🏆 ${user.score} POINTS MILESTONE!

    🎁 Reward: Premium tip unlocked!
    💡 "Watch English movies with subtitles to improve listening"`
        );
        saveData();
      }
    }

    /* ===== START ===== */
    bot.onText(/\/start/, msg => {
      const chatId = msg.chat.id;

      if (!userData[chatId]) {
        userData[chatId] = {
          score: 0,
          level: "A1",
          sessions: 0,
          badge: "🔰 Starter",
          streak: 0,
          lastActive: null,
          achievements: [],
          commonMistakes: [],
          lastMilestone: 0,
          imagesTranslated: 0
        };
        saveData();
      }

      userMode[chatId] = "chat";
      chatHistory[chatId] = [];

      bot.sendMessage(
        chatId,
    `👋 Salom!

    🤖 AI SPEAKING PRO BOT

    🧠 Chat AI
    📘 Tarjima (matn va rasm)
    🗣 Inglizcha gaplashib o'rganish
    🏅 Level, Badge, Progress

    📚 Commands:
    /daily - Kunlik vazifa
    /vocab - Yangi so'z o'rganish
    /grammar - Grammatika maslahat
    /topic - Suhbat mavzusi
    /pronounce [word] - Talaffuz eshitish
    /report - To'liq hisobot
    /top - Reyting
    /mistakes - Xatolarim
    /achievements - Yutuqlarim
    /help - Yordam

    📸 Rasm yuboring - tarjima qilamiz!

    👇 Rejimni tanlang`,
    {
      reply_markup: {
        keyboard: [
          [{ text: "🧠 Chat AI" }, { text: "📘 Tarjima" }],
          [{ text: "🗣 Speak English" }],
          [{ text: "📊 Report" }, { text: "🎯 Daily Challenge" }]
        ],
        resize_keyboard: true
      }
    });
    });

    /* ===== HELP ===== */
    bot.onText(/\/help/, msg => {
      const chatId = msg.chat.id;
      bot.sendMessage(chatId, 
    `📖 HELP & COMMANDS

    🎯 /daily - Kunlik vazifa
    📚 /vocab - Yangi so'z
    💡 /grammar - Grammatika
    💬 /topic - Suhbat mavzusi
    🔊 /pronounce [word] - Talaffuz
    📊 /report - Hisobot
    🏆 /top - Reyting jadvali
    ❌ /mistakes - Xatolarim
    🎉 /achievements - Yutuqlarim

    🗣 SPEAK MODE:
    Ovoz yuboring va:
    ✅ Xatolar to'g'rilanadi
    ✅ Level aniqlanadi
    ✅ Ball yig'iladi
    ✅ Javob ovoz bilan qaytadi

    📸 IMAGE TRANSLATION:
    Rasm yuboring va:
    ✅ Rasmdagi matn o'qiladi
    ✅ O'zbek tiliga tarjima qilinadi
    ✅ Har qanday til

    💪 Har kun mashq qiling va Fluent bo'ling!`
      );
    });
    /* ===== DAILY CHALLENGE ===== */
    bot.onText(/\/daily/, msg => {
      const chatId = msg.chat.id;
      const random = dailyChallenges[Math.floor(Math.random() * dailyChallenges.length)];
      
      bot.sendMessage(chatId, 
    `🎯 DAILY CHALLENGE

    "${random}"

    🎤 Ovoz yuboring va +5 bonus ball oling!
    🗣 Speak Mode yoqing va gapiring!`
      );
    });

    bot.on("message", msg => {
      if (msg.text === "🎯 Daily Challenge") {
        const chatId = msg.chat.id;
        const random = dailyChallenges[Math.floor(Math.random() * dailyChallenges.length)];
        
        bot.sendMessage(chatId, 
    `🎯 DAILY CHALLENGE

    "${random}"

    🎤 Ovoz yuboring va +5 bonus ball oling!
    🗣 Speak Mode yoqing va gapiring!`
        );
      }
    });

    /* ===== VOCABULARY ===== */
    bot.onText(/\/vocab/, msg => {
      const chatId = msg.chat.id;
      const level = userData[chatId]?.level || "A1";
      const words = vocabulary[level];
      const item = words[Math.floor(Math.random() * words.length)];
      
      bot.sendMessage(chatId, 
    `📚 NEW WORD (${level})

    🔤 ${item.word}
    🇺🇿 ${item.meaning}

    🎤 Use it in a sentence! (voice message)

    Example: "I want to say ${item.word}..."`
      );
    });

    /* ===== GRAMMAR ===== */
    bot.onText(/\/grammar/, msg => {
      const chatId = msg.chat.id;
      const tip = grammarTips[Math.floor(Math.random() * grammarTips.length)];
      
      bot.sendMessage(chatId, 
    `💡 GRAMMAR TIP

    ${tip}

    ✍️ Try making a sentence with this rule!`
      );
    });

    /* ===== CONVERSATION TOPIC ===== */
    bot.onText(/\/topic/, msg => {
      const chatId = msg.chat.id;
      const topic = starters[Math.floor(Math.random() * starters.length)];
      
      bot.sendMessage(chatId, 
    `💬 CONVERSATION STARTER

    "${topic}"

    🎤 Answer with voice message!
    🗣 Switch to Speak English mode first!`
      );
    });

    /* ===== PRONOUNCE ===== */
    bot.onText(/\/pronounce (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const word = match[1].trim();
      
      const gtts = new gTTS(word, "en");
      const audioPath = path.join(__dirname, `pronounce_${chatId}.mp3`);
      
      gtts.save(audioPath, () => {
        bot.sendVoice(chatId, audioPath, {
          caption: 
    `🔊 Correct pronunciation: "${word}"

    🎤 Now repeat it and send voice message!`
          
        });
        fs.unlinkSync(audioPath);
      });
    });

    /* ===== REPORT ===== */
    bot.onText(/\/report/, msg => {
      const chatId = msg.chat.id;
      const user = userData[chatId];
      
      if (!user) {
        return bot.sendMessage(chatId, "Avval /start bosing!");
      }
      
      let goal = "";
      if (user.score < 10) goal = "🎯 Goal: Reach 10 points for A2!";
      else if (user.score < 20) goal = "🎯 Goal: Reach 20 points for B1!";
      else if (user.score < 35) goal = "🎯 Goal: Reach 35 points for B2!";
      else goal = "🔥 You're doing amazing! Keep going!";
      
      bot.sendMessage(chatId, 
    `📊 YOUR PROGRESS REPORT

    🏅 Badge: ${user.badge}
    📈 Level: ${user.level}
    ⭐ Score: ${user.score}
    🎤 Sessions: ${user.sessions}
    🔥 Streak: ${user.streak || 0} days
    🏆 Achievements: ${user.achievements?.length || 0}
    📸 Images translated: ${user.imagesTranslated || 0}

    ${goal}

    💪 Keep practicing daily!`
      );
    });

    bot.on("message", msg => {
      if (msg.text === "📊 Report") {
        const chatId = msg.chat.id;
        const user = userData[chatId];
        
        if (!user) {
          return bot.sendMessage(chatId, "Avval /start bosing!");
        }
        
        let goal = "";
        if (user.score < 10) goal = "🎯 Goal: Reach 10 points for A2!";
        else if (user.score < 20) goal = "🎯 Goal: Reach 20 points for B1!";
        else if (user.score < 35) goal = "🎯 Goal: Reach 35 points for B2!";
        else goal = "🔥 You're doing amazing! Keep going!";
        
        bot.sendMessage(chatId, 
    `📊 YOUR PROGRESS REPORT

    🏅 Badge: ${user.badge}
    📈 Level: ${user.level}
    ⭐ Score: ${user.score}
    🎤 Sessions: ${user.sessions}
    🔥 Streak: ${user.streak || 0} days
    🏆 Achievements: ${user.achievements?.length || 0}
    📸 Images translated: ${user.imagesTranslated || 0}

    ${goal}

    💪 Keep practicing daily!`
        );
      }
    });
    /* ===== LEADERBOARD ===== */
    bot.onText(/\/top/, msg => {
      const chatId = msg.chat.id;
      
      const sorted = Object.entries(userData)
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, 10);
      
      let leaderboard = "🏆 TOP 10 SPEAKERS\n\n";
      
      sorted.forEach((entry, index) => {
        const [id, data] = entry;
        const position = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}.`;
        leaderboard += `${position} ${data.badge} - ${data.score} points (${data.level})\n`;
      });
      
      const userRank = sorted.findIndex(e => e[0] === chatId.toString()) + 1;
      if (userRank > 0) {
        leaderboard += `\n👤 Your rank: #${userRank}`;
      }
      
      bot.sendMessage(chatId, leaderboard);
    });

    /* ===== MISTAKES ===== */
    bot.onText(/\/mistakes/, msg => {
      const chatId = msg.chat.id;
      const mistakes = userData[chatId]?.commonMistakes || [];
      
      if (mistakes.length === 0) {
        return bot.sendMessage(chatId, "✅ No mistakes recorded yet! Keep practicing!");
      }
      
      let list = "📝 YOUR RECENT MISTAKES:\n\n";
      mistakes.slice(-5).forEach((m, i) => {
        list += `${i+1}. ${m.date}\n❌ "${m.mistake}"\n`;
      });
      
      list += "\n💡 Review these and improve!";
      
      bot.sendMessage(chatId, list);
    });

    /* ===== ACHIEVEMENTS ===== */
    bot.onText(/\/achievements/, msg => {
      const chatId = msg.chat.id;
      const user = userData[chatId];
      
      if (`!user  !user.achievements  user.achievements.length === 0`) {
        return bot.sendMessage(chatId, 
    `🏆 ACHIEVEMENTS

    You haven't unlocked any achievements yet!

    Available achievements:
    ${Object.entries(achievements).map(([key, val]) => `${val.name} - ${val.description}).join('\n'`)}

    Keep practicing to unlock them! 💪`
        );
      }
      
      let list = "🏆 YOUR ACHIEVEMENTS\n\n";
      user.achievements.forEach(ach => {
        const achievement = achievements[ach];
        list += `${achievement.name}\n${achievement.description}\n\n`;
      });
      
      list +=`\nUnlocked: ${user.achievements.length}/${Object.keys(achievements).length}`;
      
      bot.sendMessage(chatId, list);
    });

    /* ===== IMAGE TRANSLATION ===== */
    bot.on("photo", async msg => {
      const chatId = msg.chat.id;
      
      try {
        // Initialize user if not exists
        if (!userData[chatId]) {
          userData[chatId] = {
            score: 0,
            level: "A1",
            sessions: 0,
            badge: "🔰 Starter",
            streak: 0,
            lastActive: null,
            achievements: [],
            commonMistakes: [],
            lastMilestone: 0,
            imagesTranslated: 0
          };
          saveData();
        }
        
        bot.sendMessage(chatId, "📸 Rasm qabul qilindi. Tahlil qilinmoqda...");
        
        // Get the highest quality photo
        const photo = msg.photo[msg.photo.length - 1];
        const file = await bot.getFile(photo.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
        
        // OpenAI Vision API
        const response = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Analyze this image and:
    1. Extract ALL text visible in the image
    2. Translate the text to Uzbek (using Cyrillic script)
    3. If there's no text, describe what you see in the image

    Format your response as:
    📝 Original text:
    [extracted text or "No text found"]

    🇺🇿 O'zbekcha tarjima:
    [uzbek translation or image description]

    💡 Additional info:
    [any relevant context or explanation]`
                },
                {
                  type: "image_url",
                  image_url: {
                    url: fileUrl
                  }
                }
              ]
            }
          ],
          max_tokens: 1000
        });
        
        const result = response.choices[0].message.content;
        
        // Update user stats
        const user = userData[chatId];
        user.imagesTranslated = (user.imagesTranslated || 0) + 1;
        user.score += 1;
        
        // Check for first image achievement
        if (user.imagesTranslated === 1 && !user.achievements.includes("first_image")) {
          user.achievements.push("first_image");
          user.score += 5;
          saveData();
          
          bot.sendMessage(chatId, 
    ` 🎉 NEW ACHIEVEMENT UNLOCKED!

    📸 Image Explorer
    Translate your first image

    🎁 Bonus: +5 points!`
          );
        }
        
        saveData();
        
        bot.sendMessage(chatId, 
    `📸 RASM TAHLILI

    ${result}

    📊 Statistics:
    ⭐ Score: ${user.score} (+1)
    📸 Images translated: ${user.imagesTranslated}

    💡 Tip: Tarjima rejimida matn yoki rasmlarni yuboring!`
        );
        
      } catch (error) {
        console.error("Image translation error:", error);
        bot.sendMessage(chatId, 
    `❌ Rasmni tahlil qilishda xatolik yuz berdi.

    Sabablari:
    - Rasm juda katta (5MB dan kichik bo'lishi kerak)
    - Internet aloqasi zaif
    - Rasm formati noto'g'ri

    Qaytadan urinib ko'ring yoki boshqa rasm yuboring.`
        );
      }
    });

    /* ===== MODE SWITCH ===== */
    bot.on("message", async msg => {
      const chatId = msg.chat.id;
      const text = msg.text;
      if (!text) return;

      if (text === "🧠 Chat AI") {
        userMode[chatId] = "chat";
        return bot.sendMessage(chatId, "🧠 Chat AI yoqildi. Savolingizni yozing!");
      }

      if (text === "📘 Tarjima") {
        userMode[chatId] = "translate";
        return bot.sendMessage(chatId, 
    `📘 Tarjima rejimi yoqildi!

    ✍️ Matn yuboring - tarjima qilamiz
    📸 Rasm yuboring - rasmdagi matnni tarjima qilamiz

    Har qanday tildan o'zbek tiliga!`
        );
      }

      if (text === "🗣 Speak English") {
        userMode[chatId] = "speak";
        return bot.sendMessage(
          chatId,
    `🗣 SPEAKING MODE ON

    🎤 Ovoz yuboring
    🎯 Level aniqlanadi
    🏅 Badge beriladi
    🔊 Javob OVOZ bilan

    💡 Tips:
    - Speak clearly and naturally
    - Don't rush
    - Try to speak at least 20 seconds

    🚀 Start speaking now!`
        );
      }

      if (text.startsWith("/")) return;
      if (text === "🎯 Daily Challenge" || text === "📊 Report") return;

      /* ===== TEXT AI ===== */
      if (!chatHistory[chatId]) chatHistory[chatId] = [];
      chatHistory[chatId].push({ role: "user", content: text });
      if (chatHistory[chatId].length > 10) chatHistory[chatId].shift();

      let systemPrompt = "Answer clearly in user's language.";

      if (userMode[chatId] === "translate") {
        systemPrompt = "Translate the text to Uzbek (Cyrillic script) and provide a clear translation. Also give a brief explanation if needed.";
      }

      if (userMode[chatId] === "speak") {
        systemPrompt = "Speak only English. Correct mistakes politely. Give short feedback.";
      }

      try {
        const res = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            ...chatHistory[chatId]
          ]
        });

        const answer = res.choices[0].message.content;
        chatHistory[chatId].push({ role: "assistant", content: answer });

        bot.sendMessage(chatId, answer);
      } catch (error) {
        bot.sendMessage(chatId, "❌ Xatolik yuz berdi. Qaytadan urinib ko'ring.");
      }
    });

    /* ===== 🎤 VOICE SPEAKING PRO ===== */
    bot.on("voice", async msg => {
      const chatId = msg.chat.id;

      if (userMode[chatId] !== "speak") {
        return bot.sendMessage(chatId, "🗣 Avval 'Speak English' rejimini yoqing!");
      }

      const file = await bot.getFile(msg.voice.file_id);
      const oggPath = path.join(__dirname, `voice_${chatId}.ogg`);
      const mp3Path = path.join(__dirname, `reply_${chatId}.mp3`);

      const stream = bot.getFileStream(file.file_id);
      const write = fs.createWriteStream(oggPath);
      stream.pipe(write);

      write.on("finish", async () => {
        try {
          /* 1️⃣ Speech → Text */
          const transcript = await openai.audio.transcriptions.create({
            file: fs.createReadStream(oggPath),
            model: "whisper-1"
          });

          const userText = transcript.text;

          if (!userText || userText.length < 5) {
            bot.sendMessage(chatId, "❌ Ovoz aniq eshitilmadi. Qaytadan urinib ko'ring!");
            fs.unlinkSync(oggPath);
            return;
          }
          /* 2️⃣ AI correction + level */
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: 
    `You are an English speaking examiner.
    Analyze the text and provide:
    1. Corrections (if needed)
    2. Brief explanation
    3. CEFR level (A1, A2, B1, B2)
    4. Score 1-10

    Keep response SHORT and encouraging.
    Answer in English.`

              },
              { role: "user", content: userText }
            ]
          });

          const aiReply = completion.choices[0].message.content;

          /* 3️⃣ PROGRESS UPDATE */
          const user = userData[chatId];
          user.sessions += 1;
          user.score += 2; // +2 ball har gapirganida

          // Streak yangilash
          updateStreak(chatId);

          // Level yangilash
          if (user.score >= 10 && user.level === "A1") user.level = "A2";
          if (user.score >= 20 && user.level === "A2") user.level = "B1";
          if (user.score >= 35 && user.level === "B1") user.level = "B2";

          user.badge = getBadge(user.score);

          // Xatolarni saqlash
          if (aiReply.toLowerCase().includes("mistake") || aiReply.toLowerCase().includes("correction")) {
            if (!user.commonMistakes) user.commonMistakes = [];
            user.commonMistakes.push({
              mistake: userText.substring(0, 50),
              date: new Date().toLocaleDateString()
            });
            if (user.commonMistakes.length > 10) user.commonMistakes.shift();
          }

          saveData();

          // Achievement tekshirish
          checkAchievements(chatId);

          // Milestone tekshirish
          checkMilestone(chatId);

          /* 4️⃣ Speed Analysis */
          const audioLength = msg.voice.duration;
          const wordCount = userText.split(" ").length;
          const wpm = Math.round((wordCount / audioLength) * 60);

          let speedFeedback = "";
          if (wpm < 100) speedFeedback = "🐢 Try to speak a bit faster";
          else if (wpm > 180) speedFeedback = "🚀 Too fast! Slow down a bit";
          else speedFeedback = "✅ Perfect speed!";

          /* 5️⃣ TEXT → SPEECH */
          const cleanText = aiReply.replace(/\n+/g, ". ");
          const gtts = new gTTS(cleanText, "en");

          gtts.save(mp3Path, async () => {
            await bot.sendVoice(chatId, mp3Path, {
              caption:
    `🎤 You said:
    "${userText}"

    📊 Level: ${user.level}
    🏅 Badge: ${user.badge}
    ⭐ Score: ${user.score}
    🎤 Sessions: ${user.sessions}
    🔥 Streak: ${user.streak || 0} days
    🎵 Speed: ${wpm} WP
    M ${speedFeedback}

    Keep practicing! 💪`
            });

            fs.unlinkSync(mp3Path);
          });

        } catch (e) {
          console.error(e);
          bot.sendMessage(chatId, "❌ Xatolik yuz berdi. Qaytadan urinib ko'ring.");
        } finally {
          fs.unlinkSync(oggPath);
        }
      });
    });

    /* ===== DAILY REMINDER (24 soatda 1 marta) ===== */
    setInterval(() => {
      const now = new Date();
      const hour = now.getHours();
      
      // Faqat ertalab 9:00 da eslatma yuborish
      if (hour === 9) {
        Object.keys(userData).forEach(chatId => {
          const user = userData[chatId];
          const today = new Date().toDateString();
          
          if (user.lastActive !== today) {
            bot.sendMessage(chatId, 
    `👋 Good morning!

    🔥 Don't break your ${user.streak || 0} day streak!
    🎯 Practice English for 5 minutes today!

    /daily - Get today's challenge
    🗣 Or just send a voice message!
    📸 Or translate an image!

    You can do it! 💪
            `).catch(() => {});
          }
        });
      }
    }, 3600000); // Har soat tekshirish

    console.log("🚀 AI SPEAKING PRO BOT ISHGA TUSHDI!");
    console.log("✅ All features enabled:");
    console.log("   - Chat AI");
    console.log("   - Translation (text + image)");
    console.log("   - Voice Speaking with AI");
    console.log("   - Daily Challenges");
    console.log("   - Vocabulary Builder");
    console.log("   - Grammar Tips");
    console.log("   - Pronunciation");
    console.log("   - Progress Tracking");
    console.log("   - Leaderboard");
    console.log("   - Achievements");
    console.log("   - Streak System");
    console.log("   - Mistakes Tracker");
    console.log("   - Daily Reminders");
    console.log("   - 📸 IMAGE TRANSLATION (NEW!)");
    console.log("📊 Ready to help users learn English!");