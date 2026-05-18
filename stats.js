const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const express = require('express');
const axios = require('axios');

const ADMIN_ID = 6583231440; // Твой ID
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; 

if (!TELEGRAM_TOKEN) {
    console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Нет токена в Environment!");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// База данных SQLite
const dbPath = path.join(__dirname, 'chat_stats.db');
const db = new sqlite3.Database(dbPath);

db.run(`CREATE TABLE IF NOT EXISTS user_stats (
    chat_id TEXT, user_id TEXT, username TEXT, first_name TEXT, msg_count INTEGER DEFAULT 0, sticker_count INTEGER DEFAULT 0, PRIMARY KEY (chat_id, user_id)
)`);

// Сбор статистики
bot.on('message', (msg) => {
    const chatId = msg.chat.id.toString(); const user = msg.from;
    if (!user || user.is_bot || (msg.text && msg.text.startsWith('/'))) return;

    const userId = user.id.toString();
    const username = user.username ? `@${user.username}` : 'Без ника';
    const firstName = user.first_name || 'Пользователь';
    const isSticker = msg.sticker ? 1 : 0; const isMsg = msg.sticker ? 0 : 1;

    db.run(`
        INSERT INTO user_stats (chat_id, user_id, username, first_name, msg_count, sticker_count)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET
            username = excluded.username, first_name = excluded.first_name,
            msg_count = msg_count + excluded.msg_count, sticker_count = sticker_count + excluded.sticker_count
    `, [chatId, userId, username, firstName, isMsg, isSticker]);
});

// Вывод ТОП-10
bot.onText(/\/top/, (msg) => {
    const chatId = msg.chat.id.toString();
    db.all(`SELECT first_name, username, msg_count, sticker_count FROM user_stats WHERE chat_id = ? ORDER BY msg_count DESC LIMIT 10`, [chatId], (err, rows) => {
        if (err || !rows || rows.length === 0) return bot.sendMessage(chatId, '📊 В этом чате еще нет собранной статистики.');
        let res = `🏆 *ТОП-10 ФЛУДЕРОВ ЧАТА* 🏆\n\n`;
        rows.forEach((row, i) => {
            const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
            res += `${medals[i] || '🔹'} *${row.first_name.replace(/[_*`\[\]]/g, '')}* (${row.username})\n      └ 💬 Сообщений: *${row.msg_count}* | 🏞 Стикеров: *${row.sticker_count}*\n\n`;
        });
        bot.sendMessage(chatId, res, { parse_mode: 'Markdown' });
    });
});

// Обнуление
bot.onText(/\/reset_stats/, (msg) => {
    if (msg.from.id !== ADMIN_ID) return;
    db.run(`DELETE FROM user_stats WHERE chat_id = ?`, [msg.chat.id.toString()], () => { bot.sendMessage(msg.chat.id, '🗑️ Статистика чата сброшена!'); });
});

// Веб-сервер и пинг (Защита от спячки)
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Fanstat Engine Online!'));
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    setInterval(async () => {
        try {
            const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
            await axios.get(url);
        } catch (e) {}
    }, 600000);
});
