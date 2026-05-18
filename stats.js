const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const express = require('express');

// Официальные ключи Telegram Desktop (вшиты, чтобы не мучиться с сайтом)
const apiId = 2040;
const apiHash = "b18441a1ff607e10a989891a5462e627";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const dbPath = path.join(__dirname, 'global_telelog.db');
const db = new sqlite3.Database(dbPath);

db.run(`CREATE TABLE IF NOT EXISTS global_logs (
    chat_id TEXT, chat_title TEXT, user_id TEXT, username TEXT, first_name TEXT, msg_count INTEGER DEFAULT 0, sticker_count INTEGER DEFAULT 0, last_seen TEXT, PRIMARY KEY (chat_id, user_id)
)`);

const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });

async function startUserbot() {
    if (!process.env.TELEGRAM_SESSION) {
        console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Переменная TELEGRAM_SESSION пуста!");
        process.exit(1);
    }
    
    await client.connect();
    console.log("✅ ЮЗЕРБОТ-ШПИОН УСПЕШНО ЗАПУЩЕН И ЧИТАЕТ ЧАТЫ!");
    
    client.addEventHandler(async (event) => {
        const message = event.message;
        if (!message || !message.peerId) return;

        try {
            if (!message.isGroup && !message.isChannel) return;

            const sender = await message.getSender();
            if (!sender || sender.bot) return;

            const chat = await message.getChat();
            const chatTitle = chat.title || "Группа";

            const chatId = message.chatId ? message.chatId.toString() : "";
            const userId = sender.id.toString();
            const username = sender.username ? `@${sender.username}` : "Без ника";
            const firstName = sender.firstName || "Пользователь";
            
            const isSticker = message.media && message.media.className === 'MessageMediaDocument' ? 1 : 0;
            const isMsg = isSticker ? 0 : 1;
            const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

            db.run(`
                INSERT INTO global_logs (chat_id, chat_title, user_id, username, first_name, msg_count, sticker_count, last_seen)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET
                    chat_title = excluded.chat_title, username = excluded.username, first_name = excluded.first_name,
                    msg_count = msg_count + excluded.msg_count, sticker_count = sticker_count + excluded.sticker_count, last_seen = excluded.last_seen
            `, [chatId, chatTitle, userId, username, firstName, isMsg, isSticker, now]);

        } catch (e) {}
    });
}

// Поиск в ЛС у главного бота
bot.on('message', (msg) => {
    if (msg.chat.type !== 'private') return;
    const chatId = msg.chat.id;
    let text = msg.text ? msg.text.trim() : '';

    if (!text.startsWith('@') && !/^\d+$/.test(text) && !msg.forward_from) {
        return bot.sendMessage(chatId, "📊 *Фанстат | Юзербот версия*\n\nОтправь мне `@username`, ID или перешли сообщение человека. Я выдам логи из всех чатов, где сидит мой аккаунт-шпион!", { parse_mode: 'Markdown' });
    }

    let querySQL = `SELECT * FROM global_logs WHERE user_id = ?`;
    let param = text;

    if (msg.forward_from) param = msg.forward_from.id.toString();
    if (!msg.forward_from && text.startsWith('@')) {
        querySQL = `SELECT * FROM global_logs WHERE LOWER(username) = LOWER(?)`;
    }

    db.all(querySQL, [param], (err, rows) => {
        if (err || !rows || rows.length === 0) return bot.sendMessage(chatId, "❌ Этот пользователь пока не писал в чатах, где находится юзербот.");
        
        let totalMsg = 0, totalStickers = 0, chatsList = '';
        rows.forEach(row => {
            totalMsg += row.msg_count; totalStickers += row.sticker_count;
            chatsList += `• *${row.chat_title}*:\n   └ 💬 Сообщений: *${row.msg_count}* | 🏞 Стикеров: *${row.sticker_count}*\n`;
        });

        let response = `👤 *ДОСЬЕ ПОЛЬЗОВАТЕЛЯ* 👤\n\n• *Имя:* ${rows[0].first_name}\n• *Ник:* ${rows[0].username}\n• *ID:* \`${rows[0].user_id}\`\n\n📊 *Всего активности:*\n• Сообщений: *${totalMsg}*\n• Стикеров: *${totalStickers}*\n• Лог обновлен: _${rows[0].last_seen}_\n\n🏰 *Замечен в чатах:* \n${chatsList}`;
        bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    });
});

startUserbot();

const app = express();
app.get('/', (req, res) => res.send('Userbot Active'));
app.listen(process.env.PORT || 3000);
