"""
AI English Tutor Bot
- Python aiogram 3.x
- SQLite3 Database
- Channel Subscription Check
- Referral System with Premium Rewards
- Daily Request Limits
"""

import asyncio
import sqlite3
import os
import logging
from datetime import datetime, timedelta
from pathlib import Path

from aiogram import Bot, Dispatcher, types, F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import (
    InlineKeyboardMarkup, 
    InlineKeyboardButton, 
    ReplyKeyboardMarkup, 
    KeyboardButton,
    ChatMemberUpdated
)
from aiogram.enums import ChatMemberStatus
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from dotenv import load_dotenv
from openai import AsyncOpenAI

# ================= CONFIGURATION =================
load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ADMIN_ID = int(os.getenv("ADMIN_ID", "0"))
BOT_USERNAME = os.getenv("BOT_USERNAME", "").replace("@", "")

# Private channel invite link: https://t.me/+hDvXYLDh3EQ0MDIy
# The numeric chat ID for the private channel (you need to get this from @userinfobot or similar)
# For private channels, use the numeric ID (starts with -100)
CHANNEL_ID = -1002301829498  # Replace with actual channel ID
CHANNEL_INVITE_LINK = "https://t.me/+hDvXYLDh3EQ0MDIy"

# Limits
FREE_DAILY_LIMIT = 10
REFERRALS_FOR_PREMIUM = 5
PREMIUM_DAYS = 30

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ================= DATABASE =================
DB_PATH = Path(__file__).parent / "ai_tutor_bot.db"


def init_database():
    """Initialize SQLite database with users table"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            referrals_count INTEGER DEFAULT 0,
            daily_requests INTEGER DEFAULT 10,
            premium_end_date TEXT DEFAULT NULL,
            joined_at TEXT,
            last_request_date TEXT,
            referred_by INTEGER DEFAULT NULL
        )
    """)
    
    conn.commit()
    conn.close()
    logger.info("✅ Database initialized")


def get_user(user_id: int) -> dict | None:
    """Get user from database"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("SELECT * FROM users WHERE user_id = ?", (user_id,))
    row = cursor.fetchone()
    conn.close()
    
    return dict(row) if row else None


def create_user(user_id: int, username: str = None, first_name: str = None, referred_by: int = None):
    """Create new user in database"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    now = datetime.now().isoformat()
    
    cursor.execute("""
        INSERT OR IGNORE INTO users 
        (user_id, username, first_name, referrals_count, daily_requests, joined_at, last_request_date, referred_by)
        VALUES (?, ?, ?, 0, ?, ?, ?, ?)
    """, (user_id, username, first_name, FREE_DAILY_LIMIT, now, now, referred_by))
    
    conn.commit()
    conn.close()


def update_user(user_id: int, **kwargs):
    """Update user fields"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    set_clause = ", ".join([f"{k} = ?" for k in kwargs.keys()])
    values = list(kwargs.values()) + [user_id]
    
    cursor.execute(f"UPDATE users SET {set_clause} WHERE user_id = ?", values)
    conn.commit()
    conn.close()


def increment_referral(referrer_id: int) -> int:
    """Increment referral count and return new count"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute(
        "UPDATE users SET referrals_count = referrals_count + 1 WHERE user_id = ?",
        (referrer_id,)
    )
    conn.commit()
    
    cursor.execute("SELECT referrals_count FROM users WHERE user_id = ?", (referrer_id,))
    row = cursor.fetchone()
    conn.close()
    
    return row[0] if row else 0


def get_all_users_count() -> int:
    """Get total users count"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM users")
    count = cursor.fetchone()[0]
    conn.close()
    return count


def reset_all_daily_limits():
    """Reset daily requests for all non-premium users (call at midnight)"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    now = datetime.now().isoformat()
    
    # Reset for free users (premium_end_date is NULL or expired)
    cursor.execute("""
        UPDATE users 
        SET daily_requests = ? 
        WHERE premium_end_date IS NULL 
           OR premium_end_date < ?
    """, (FREE_DAILY_LIMIT, now))
    
    conn.commit()
    conn.close()
    logger.info("✅ Daily limits reset for all free users")


# ================= PREMIUM & LIMITS =================

def is_premium(user: dict) -> bool:
    """Check if user has active premium"""
    if not user or not user.get("premium_end_date"):
        return False
    
    try:
        end_date = datetime.fromisoformat(user["premium_end_date"])
        return datetime.now() < end_date
    except:
        return False


def check_and_reset_daily(user: dict) -> dict:
    """Check if day changed and reset daily limit if needed"""
    if not user:
        return user
    
    last_date_str = user.get("last_request_date")
    if not last_date_str:
        return user
    
    try:
        last_date = datetime.fromisoformat(last_date_str).date()
        today = datetime.now().date()
        
        if last_date < today:
            # New day - reset daily requests
            update_user(
                user["user_id"],
                daily_requests=FREE_DAILY_LIMIT,
                last_request_date=datetime.now().isoformat()
            )
            user["daily_requests"] = FREE_DAILY_LIMIT
    except:
        pass
    
    return user


def can_make_request(user: dict) -> tuple[bool, str]:
    """Check if user can make a request. Returns (can_request, message)"""
    if not user:
        return False, "User not found"
    
    # Premium users have unlimited
    if is_premium(user):
        return True, ""
    
    # Check daily limit
    if user.get("daily_requests", 0) > 0:
        return True, ""
    
    return False, "limit_reached"


def decrement_daily_request(user_id: int):
    """Decrease daily request count by 1"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        UPDATE users 
        SET daily_requests = daily_requests - 1,
            last_request_date = ?
        WHERE user_id = ? AND daily_requests > 0
    """, (datetime.now().isoformat(), user_id))
    
    conn.commit()
    conn.close()


def grant_premium(user_id: int) -> str:
    """Grant 30 days of premium to user"""
    user = get_user(user_id)
    
    if is_premium(user):
        # Extend existing premium
        current_end = datetime.fromisoformat(user["premium_end_date"])
        new_end = current_end + timedelta(days=PREMIUM_DAYS)
    else:
        # New premium
        new_end = datetime.now() + timedelta(days=PREMIUM_DAYS)
    
    update_user(user_id, premium_end_date=new_end.isoformat())
    return new_end.strftime("%d.%m.%Y")


# ================= REFERRAL LINK =================

def get_referral_link(user_id: int) -> str:
    """Generate referral link for user"""
    return f"https://t.me/{BOT_USERNAME}?start={user_id}"


# ================= BOT SETUP =================

bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()
router = Router()
dp.include_router(router)

# OpenAI client
openai_client = AsyncOpenAI(api_key=OPENAI_API_KEY)

# User modes (in-memory)
user_modes = {}  # chat | translate | speak
chat_history = {}


# ================= CHANNEL SUBSCRIPTION CHECK =================

async def check_subscription(user_id: int) -> bool:
    """Check if user is subscribed to the required channel"""
    try:
        member = await bot.get_chat_member(chat_id=CHANNEL_ID, user_id=user_id)
        return member.status in [
            ChatMemberStatus.MEMBER,
            ChatMemberStatus.ADMINISTRATOR,
            ChatMemberStatus.CREATOR
        ]
    except Exception as e:
        logger.error(f"Error checking subscription: {e}")
        return False


def get_subscribe_keyboard() -> InlineKeyboardMarkup:
    """Get keyboard with subscribe button"""
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📢 Kanalga a'zo bo'lish", url=CHANNEL_INVITE_LINK)],
        [InlineKeyboardButton(text="✅ A'zo bo'ldim", callback_data="check_subscription")]
    ])


async def require_subscription(message: types.Message) -> bool:
    """Check subscription and send message if not subscribed. Returns True if subscribed."""
    user_id = message.from_user.id
    
    if await check_subscription(user_id):
        return True
    
    await message.answer(
        "⚠️ <b>Botdan foydalanish uchun kanalimizga a'zo bo'ling!</b>\n\n"
        "Kanalga a'zo bo'lgandan keyin \"✅ A'zo bo'ldim\" tugmasini bosing.",
        reply_markup=get_subscribe_keyboard(),
        parse_mode="HTML"
    )
    return False


# ================= CALLBACK HANDLER =================

@router.callback_query(F.data == "check_subscription")
async def callback_check_subscription(callback: types.CallbackQuery):
    """Handle subscription check callback"""
    user_id = callback.from_user.id
    
    if await check_subscription(user_id):
        await callback.message.edit_text(
            "✅ <b>Rahmat!</b> Endi botdan foydalanishingiz mumkin.\n\n"
            "/start buyrug'ini bosing.",
            parse_mode="HTML"
        )
        await callback.answer("✅ A'zolik tasdiqlandi!")
    else:
        await callback.answer("❌ Siz hali kanalga a'zo bo'lmadingiz!", show_alert=True)


# ================= MAIN KEYBOARD =================

def get_main_keyboard() -> ReplyKeyboardMarkup:
    """Get main menu keyboard"""
    return ReplyKeyboardMarkup(
        keyboard=[
            [KeyboardButton(text="🧠 Chat AI"), KeyboardButton(text="📘 Tarjima")],
            [KeyboardButton(text="🗣 Speak English")],
            [KeyboardButton(text="👤 Profil"), KeyboardButton(text="🔗 Referal")],
            [KeyboardButton(text="/help")]
        ],
        resize_keyboard=True
    )


# ================= COMMAND HANDLERS =================

@router.message(CommandStart())
async def cmd_start(message: types.Message):
    """Handle /start command with referral support"""
    user_id = message.from_user.id
    username = message.from_user.username
    first_name = message.from_user.first_name
    
    # Check channel subscription first
    if not await require_subscription(message):
        return
    
    # Parse referral from start parameter
    args = message.text.split()
    referred_by = None
    
    if len(args) > 1:
        try:
            referred_by = int(args[1])
            # Don't allow self-referral
            if referred_by == user_id:
                referred_by = None
        except ValueError:
            referred_by = None
    
    # Check if user exists
    existing_user = get_user(user_id)
    
    if not existing_user:
        # New user
        create_user(user_id, username, first_name, referred_by)
        
        # Process referral
        if referred_by:
            referrer = get_user(referred_by)
            if referrer:
                new_count = increment_referral(referred_by)
                
                # Notify referrer
                try:
                    await bot.send_message(
                        referred_by,
                        f"🎉 <b>Yangi referal!</b>\n\n"
                        f"👤 {first_name or 'Foydalanuvchi'} sizning havolangiz orqali qo'shildi!\n"
                        f"📊 Jami referallar: <b>{new_count}/5</b>",
                        parse_mode="HTML"
                    )
                except:
                    pass
                
                # Check if earned premium (every 5 referrals)
                if new_count > 0 and new_count % REFERRALS_FOR_PREMIUM == 0:
                    end_date = grant_premium(referred_by)
                    try:
                        await bot.send_message(
                            referred_by,
                            f"🏆 <b>TABRIKLAYMIZ!</b>\n\n"
                            f"Siz 5 ta referal to'pladingiz va\n"
                            f"🎁 <b>1 OY CHEKSIZ LIMIT</b> oldingiz!\n\n"
                            f"📅 Premium muddat: <b>{end_date}</b> gacha\n\n"
                            f"Yana 5 ta referal = yana 1 oy! 🚀",
                            parse_mode="HTML"
                        )
                    except:
                        pass
    
    # Set default mode
    user_modes[user_id] = "chat"
    chat_history[user_id] = []
    
    await message.answer(
        f"👋 <b>Salom, {first_name}!</b>\n\n"
        f"🤖 <b>AI English Learning Bot</b>\n\n"
        f"🧠 Chat AI — savol-javob\n"
        f"📘 Tarjima — matn tarjimasi\n"
        f"🗣 Speak English — gapirib o'rganish\n"
        f"👤 Profil — limit va premium\n"
        f"🔗 Referal — do'stlarni taklif qiling\n\n"
        f"👇 <b>Rejimni tanlang:</b>",
        reply_markup=get_main_keyboard(),
        parse_mode="HTML"
    )


@router.message(Command("help"))
async def cmd_help(message: types.Message):
    """Handle /help command"""
    if not await require_subscription(message):
        return
    
    await message.answer(
        "ℹ️ <b>YORDAM</b>\n\n"
        "🧠 <b>Chat AI</b> — ingliz tili bo'yicha savol-javob\n"
        "📘 <b>Tarjima</b> — matnlarni tarjima qilish\n"
        "🗣 <b>Speak English</b> — ovoz yuborib mashq qilish\n\n"
        "📸 <b>Rasm</b> yuborsangiz — tarjima qilinadi\n"
        "🎤 <b>Ovoz</b> yuborsangiz — tekshiriladi\n\n"
        "━━━━━━━━━━━━━━━━\n"
        "💎 <b>PREMIUM OLISH:</b>\n"
        "5 ta do'stingizni taklif qiling = 1 oy cheksiz!\n"
        "🔗 /referal — referal havolangiz",
        parse_mode="HTML"
    )


@router.message(Command("referal"))
async def cmd_referal(message: types.Message):
    """Handle /referal command"""
    if not await require_subscription(message):
        return
    
    user_id = message.from_user.id
    user = get_user(user_id)
    
    if not user:
        create_user(user_id, message.from_user.username, message.from_user.first_name)
        user = get_user(user_id)
    
    referral_link = get_referral_link(user_id)
    referrals_count = user.get("referrals_count", 0)
    remaining = REFERRALS_FOR_PREMIUM - (referrals_count % REFERRALS_FOR_PREMIUM)
    
    status = "💎 PREMIUM" if is_premium(user) else "🆓 FREE"
    
    await message.answer(
        f"🔗 <b>REFERAL DASTURI</b>\n\n"
        f"📊 Sizning referallaringiz: <b>{referrals_count}</b>\n"
        f"🎯 Premium uchun qoldi: <b>{remaining}</b> ta\n"
        f"📌 Status: {status}\n\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"📨 <b>Sizning havolangiz:</b>\n"
        f"<code>{referral_link}</code>\n\n"
        f"☝️ Bu havolani do'stlaringizga yuboring!\n"
        f"5 ta odam qo'shilsa = <b>1 OY CHEKSIZ</b> 🎁",
        parse_mode="HTML"
    )


@router.message(Command("stats"))
async def cmd_stats(message: types.Message):
    """Handle /stats command (admin only)"""
    if message.from_user.id != ADMIN_ID:
        await message.answer("⛔ Bu buyruq faqat admin uchun.")
        return
    
    total = get_all_users_count()
    
    await message.answer(
        f"📊 <b>BOT STATISTIKASI</b>\n\n"
        f"👥 Jami foydalanuvchilar: <b>{total}</b>",
        parse_mode="HTML"
    )


@router.message(Command("reset_limits"))
async def cmd_reset_limits(message: types.Message):
    """Manual reset of daily limits (admin only)"""
    if message.from_user.id != ADMIN_ID:
        await message.answer("⛔ Bu buyruq faqat admin uchun.")
        return
    
    reset_all_daily_limits()
    await message.answer("✅ Barcha foydalanuvchilar uchun kunlik limitlar qayta tiklandi.")


# ================= PROFILE & MENU HANDLERS =================

@router.message(F.text == "👤 Profil")
async def show_profile(message: types.Message):
    """Show user profile"""
    if not await require_subscription(message):
        return
    
    user_id = message.from_user.id
    user = get_user(user_id)
    
    if not user:
        create_user(user_id, message.from_user.username, message.from_user.first_name)
        user = get_user(user_id)
    
    # Check and reset daily if new day
    user = check_and_reset_daily(user)
    
    premium_status = is_premium(user)
    
    if premium_status:
        end_date = datetime.fromisoformat(user["premium_end_date"]).strftime("%d.%m.%Y")
        status_text = f"💎 <b>PREMIUM</b> ({end_date} gacha)"
        limit_text = "♾ <b>CHEKSIZ</b>"
    else:
        status_text = "🆓 FREE"
        limit_text = f"📊 <b>{user.get('daily_requests', 0)}/{FREE_DAILY_LIMIT}</b>"
    
    await message.answer(
        f"👤 <b>SIZNING PROFILINGIZ</b>\n\n"
        f"🆔 ID: <code>{user_id}</code>\n"
        f"📌 Status: {status_text}\n"
        f"📱 Kunlik limit: {limit_text}\n"
        f"🔗 Referallar: <b>{user.get('referrals_count', 0)}</b>\n\n"
        f"━━━━━━━━━━━━━━━━\n"
        f"💡 <b>PREMIUM OLISH:</b>\n"
        f"5 ta do'stni taklif qiling = 1 oy cheksiz!",
        parse_mode="HTML"
    )


@router.message(F.text == "🔗 Referal")
async def show_referal(message: types.Message):
    """Show referral link"""
    await cmd_referal(message)


# ================= MODE SWITCH HANDLERS =================

@router.message(F.text == "🧠 Chat AI")
async def set_chat_mode(message: types.Message):
    """Switch to chat mode"""
    if not await require_subscription(message):
        return
    
    user_modes[message.from_user.id] = "chat"
    chat_history[message.from_user.id] = []
    await message.answer("🧠 <b>Chat AI</b> rejimi yoqildi.\n\nSavol bering!", parse_mode="HTML")


@router.message(F.text == "📘 Tarjima")
async def set_translate_mode(message: types.Message):
    """Switch to translate mode"""
    if not await require_subscription(message):
        return
    
    user_modes[message.from_user.id] = "translate"
    await message.answer("📘 <b>Tarjima</b> rejimi yoqildi.\n\nMatn yuboring!", parse_mode="HTML")


@router.message(F.text == "🗣 Speak English")
async def set_speak_mode(message: types.Message):
    """Switch to speak mode"""
    if not await require_subscription(message):
        return
    
    user_modes[message.from_user.id] = "speak"
    await message.answer(
        "🗣 <b>Speak English</b> rejimi yoqildi.\n\n"
        "Ovoz xabar yuboring, men tekshiraman!",
        parse_mode="HTML"
    )


# ================= LIMIT CHECK DECORATOR =================

async def check_limits_and_notify(message: types.Message) -> bool:
    """Check limits and send message if exceeded. Returns True if can proceed."""
    user_id = message.from_user.id
    user = get_user(user_id)
    
    if not user:
        create_user(user_id, message.from_user.username, message.from_user.first_name)
        user = get_user(user_id)
    
    # Check and reset if new day
    user = check_and_reset_daily(user)
    
    can_request, reason = can_make_request(user)
    
    if not can_request:
        referral_link = get_referral_link(user_id)
        await message.answer(
            f"⚠️ <b>Limitingiz tugadi!</b>\n\n"
            f"Kunlik limit: <b>0/{FREE_DAILY_LIMIT}</b>\n\n"
            f"━━━━━━━━━━━━━━━━\n"
            f"🎁 <b>1 oy cheksiz ishlatish uchun</b>\n"
            f"5 ta do'stingizni taklif qiling!\n\n"
            f"📨 <b>Sizning havolangiz:</b>\n"
            f"<code>{referral_link}</code>\n\n"
            f"⏰ Yoki ertaga qaytib keling!",
            parse_mode="HTML"
        )
        return False
    
    return True


# ================= TEXT MESSAGE HANDLER =================

@router.message(F.text)
async def handle_text(message: types.Message):
    """Handle text messages"""
    # Skip commands
    if message.text.startswith("/"):
        return
    
    # Check subscription
    if not await require_subscription(message):
        return
    
    # Check limits
    if not await check_limits_and_notify(message):
        return
    
    user_id = message.from_user.id
    mode = user_modes.get(user_id, "chat")
    
    # Set system prompt based on mode
    if mode == "translate":
        system_prompt = "You are a translator. Translate the text to Uzbek clearly and accurately."
    elif mode == "speak":
        system_prompt = "You are an English teacher. Reply only in English. Correct any mistakes briefly and encourage the learner."
    else:
        system_prompt = "You are a helpful English tutor. Answer questions clearly in the user's language (Uzbek or English)."
    
    # Manage chat history (keep last 2 messages to save tokens)
    if user_id not in chat_history:
        chat_history[user_id] = []
    
    chat_history[user_id].append({"role": "user", "content": message.text})
    if len(chat_history[user_id]) > 2:
        chat_history[user_id].pop(0)
    
    try:
        # Call OpenAI
        response = await openai_client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=180,
            temperature=0.6,
            messages=[
                {"role": "system", "content": system_prompt},
                *chat_history[user_id]
            ]
        )
        
        answer = response.choices[0].message.content
        chat_history[user_id].append({"role": "assistant", "content": answer})
        
        # Decrement daily request (only for free users)
        user = get_user(user_id)
        if not is_premium(user):
            decrement_daily_request(user_id)
        
        await message.answer(answer)
        
    except Exception as e:
        logger.error(f"OpenAI error: {e}")
        await message.answer("❌ Xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.")


# ================= PHOTO HANDLER =================

@router.message(F.photo)
async def handle_photo(message: types.Message):
    """Handle photo messages for translation"""
    if not await require_subscription(message):
        return
    
    if not await check_limits_and_notify(message):
        return
    
    user_id = message.from_user.id
    
    try:
        # Get the largest photo
        photo = message.photo[-1]
        file = await bot.get_file(photo.file_id)
        image_url = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file.file_path}"
        
        # Call OpenAI Vision
        response = await openai_client.chat.completions.create(
            model="gpt-4o-mini",
            max_tokens=300,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": "Extract any text from this image and translate it to Uzbek."},
                    {"type": "image_url", "image_url": {"url": image_url}}
                ]
            }]
        )
        
        answer = response.choices[0].message.content
        
        # Decrement limit
        user = get_user(user_id)
        if not is_premium(user):
            decrement_daily_request(user_id)
        
        await message.answer(answer)
        
    except Exception as e:
        logger.error(f"Photo processing error: {e}")
        await message.answer("❌ Rasmni qayta ishlashda xatolik yuz berdi.")


# ================= VOICE HANDLER =================

@router.message(F.voice)
async def handle_voice(message: types.Message):
    """Handle voice messages"""
    if not await require_subscription(message):
        return
    
    user_id = message.from_user.id
    mode = user_modes.get(user_id, "chat")
    
    if mode != "speak":
        await message.answer("🗣 Avval \"Speak English\" rejimini tanlang!")
        return
    
    if not await check_limits_and_notify(message):
        return
    
    try:
        # Download voice file
        file = await bot.get_file(message.voice.file_id)
        file_path = f"https://api.telegram.org/file/bot{BOT_TOKEN}/{file.file_path}"
        
        # For voice transcription, we need to download the file first
        # This is a simplified version - in production you'd download and process
        await message.answer(
            "🎤 Ovozingiz qabul qilindi!\n\n"
            "💡 Hozircha ovoz xabarlarni to'liq qo'llab-quvvatlash ustida ishlamoqdamiz.\n"
            "Matn yozib yuboring yoki \"Chat AI\" rejimidan foydalaning!"
        )
        
    except Exception as e:
        logger.error(f"Voice processing error: {e}")
        await message.answer("❌ Ovozni qayta ishlashda xatolik yuz berdi.")


# ================= SCHEDULER FOR DAILY RESET =================

async def daily_reset_scheduler():
    """Background task to reset daily limits at midnight"""
    while True:
        now = datetime.now()
        # Calculate seconds until midnight
        tomorrow = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        seconds_until_midnight = (tomorrow - now).total_seconds()
        
        logger.info(f"⏰ Next daily reset in {seconds_until_midnight/3600:.1f} hours")
        
        await asyncio.sleep(seconds_until_midnight)
        
        reset_all_daily_limits()
        logger.info("✅ Daily limits reset at midnight")


# ================= MAIN =================

async def main():
    """Main function to start the bot"""
    # Initialize database
    init_database()
    
    # Start daily reset scheduler in background
    asyncio.create_task(daily_reset_scheduler())
    
    logger.info("🚀 Bot ishga tushdi!")
    
    # Start polling
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
