const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const express = require('express');

const apiId = 2040;
const apiHash = "b18441a1ff607e10a989891a5462e627";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? process.env.ADMIN_ID.toString() : "";

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const authStates = {};
const activeSpyClients = [];
let primaryClient = null;

const db = new sqlite3.Database(path.join(__dirname, 'global_telelog.db'));

// Инициализация таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS global_logs (chat_id TEXT, chat_title TEXT, user_id TEXT, username TEXT, first_name TEXT, PRIMARY KEY (chat_id, user_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS spy_chats (chat_id TEXT PRIMARY KEY, chat_title TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS spy_nodes (user_id TEXT PRIMARY KEY, session_string TEXT)`);
});

// Логика регистрации сообщений
async function registerSpyHandlers(client) {
    client.addEventHandler(async (event) => {
        const message = event.message;
        if (!message || (!message.isGroup && !message.isChannel)) return;
        try {
            const sender = await message.getSender();
            const chat = await message.getChat();
            if (!sender || sender.bot) return;

            db.run(`INSERT OR IGNORE INTO global_logs (chat_id, chat_title, user_id, username, first_name) VALUES (?, ?, ?, ?, ?)`, 
                [message.chatId.toString(), chat.title || "Group", sender.id.toString(), sender.username ? `@${sender.username}` : "none", sender.firstName || "User"]);
            
            db.run(`INSERT OR IGNORE INTO spy_chats (chat_id, chat_title) VALUES (?, ?)`, [message.chatId.toString(), chat.title || "Group"]);
        } catch (e) {}
    }, new NewMessage({}));
}

// Меню (Админ видит кнопку панели)
function getMainButtons(userId) {
    const keyboard = [
        [{ text: '🔍 Поиск юзера (OSINT)', callback_data: 'osint_search' }],
        [{ text: '🤝 Стать Добровольцем', callback_data: 'join_network' }]
    ];
    if (userId === ADMIN_ID) {
        keyboard.push([{ text: '⚡️ АДМИН-ПАНЕЛЬ', callback_data: 'admin_panel' }]);
    }
    return { inline_keyboard: keyboard };
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text || '';
    const state = authStates[chatId];

    if (text === '/start') {
        return bot.sendMessage(chatId, "🚀 *ФАНСТАТ OSINT | ГЛАВНОЕ МЕНЮ*", { 
            parse_mode: 'Markdown', reply_markup: getMainButtons(chatId) 
        });
    }

    // Обработка OSINT-поиска
    if (state && state.step === 'OSINT_SEARCH') {
        const username = text.replace('@', '').toLowerCase();
        db.all(`SELECT DISTINCT chat_title FROM global_logs WHERE LOWER(username) = ?`, [username], (err, rows) => {
            if (rows && rows.length > 0) {
                let list = rows.map((r, i) => `${i+1}. ${r.chat_title}`).join('\n');
                bot.sendMessage(chatId, `🎯 *Найден в чатах:*\n\n${list}`, { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, "❌ Юзер не найден в базе шпионажа.");
            }
        });
        delete authStates[chatId];
    }
    
    // Админ: Авто-вступление
    if (state && state.step === 'JOIN_CHATS' && chatId === ADMIN_ID) {
        const links = text.match(/(?:t\.me\/|@)[A-Za-z0-9_+-]+/g);
        if (links) {
            bot.sendMessage(chatId, `⏳ Начинаю внедрение в ${links.length} чатов...`);
            for (let link of links) {
                try {
                    let target = link.replace('t.me/', '').replace('@', '');
                    await primaryClient.invoke(new Api.channels.JoinChannelRequest({ channel: target }));
                } catch (e) { console.log("Skip:", link); }
            }
            bot.sendMessage(chatId, "✅ Операция завершена.");
        }
        delete authStates[chatId];
    }
});

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id.toString();
    const data = query.data;

    if (data === 'osint_search') {
        authStates[chatId] = { step: 'OSINT_SEARCH' };
        bot.sendMessage(chatId, "Введите `@username` для поиска по истории чатов:");
    }
    
    if (data === 'admin_panel' && chatId === ADMIN_ID) {
        bot.editMessageText("🛡 *АДМИН-ПАНЕЛЬ*\n\n1. [Авто-вступление] — Вбей список ссылок.\n2. [Статус] — Мониторинг сети.", {
            chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '➕ Авто-вступление', callback_data: 'join_mode' }], [{ text: '⬅️ Назад', callback_data: 'back' }]] }
        });
    }

    if (data === 'join_mode' && chatId === ADMIN_ID) {
        authStates[chatId] = { step: 'JOIN_CHATS' };
        bot.sendMessage(chatId, "Пришли список ссылок для вступления:");
    }

    if (data === 'back') {
        bot.editMessageText("🚀 *ФАНСТАТ OSINT | ГЛАВНОЕ МЕНЮ*", {
            chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown',
            reply_markup: getMainButtons(chatId)
        });
    }
});

// Запуск (логика аналогична предыдущей)
(async () => {
    if (process.env.TELEGRAM_SESSION) {
        primaryClient = new TelegramClient(new StringSession(process.env.TELEGRAM_SESSION), apiId, apiHash, {});
        await primaryClient.connect();
        activeSpyClients.push(primaryClient);
        registerSpyHandlers(primaryClient);
    }
    console.log("OSINT Бот запущен!");
})();

const app = express();
app.listen(3000);
