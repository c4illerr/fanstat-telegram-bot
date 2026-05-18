const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const express = require('express');
const axios = require('axios');

// ==========================================
// АНТИ-КРАШ СИСТЕМА
// ==========================================
process.on('uncaughtException', (err) => {
    console.error('⚠️ Перехвачена ошибка:', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ Ошибка обещания заблокирована:', reason);
});

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

const client = new TelegramClient(stringSession, apiId, apiHash, { 
    connectionRetries: 5,
    useWSS: true // Стабильное соединение для серверов
});

// Стартуем юзербота с гарантированным приёмом событий
async function startUserbot() {
    if (!process.env.TELEGRAM_SESSION) {
        console.error("❌ TELEGRAM_SESSION пуста!");
        return;
    }
    try {
        await client.connect();
        console.log("✅ ЮЗЕРБОТ-ШПИОН УСПЕШНО ЗАПУЩЕН И ЧИТАЕТ ЧАТЫ!");
        
        // КРИТИЧЕСКИЙ ФИКС: заставляем GramJS слушать обновления в фоне
        client.getMe().then(me => console.log(`Авторизован под именем: ${me.firstName}`));

        client.addEventHandler(async (event) => {
            const message = event.message;
            if (!message || !message.peerId) return;
            
            try {
                // Ловим сообщения из групп и каналов
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
                
                console.log(`[Логгер] Зафиксировано сообщение от ${username} в чате "${chatTitle}"`);
            } catch (e) {
                // Тихий пропуск ошибок парсинга системных апдейтов
            }
        });
    } catch (err) {
        console.error("Ошибка юзербота:", err.message);
    }
}

// ==========================================
// ИНТЕРФЕЙС В СТИЛЕ POST AI (КНОПКИ И МЕНЮ)
// ==========================================

function getWelcomeMessage() {
    return "⚡️ *Добро пожаловать в панель Фанстат | telelog* \n\n" +
           "Я собираю глобальные логи активности пользователей в реальном времени.\n\n" +
           "📌 *Как искать:* Просто отправь мне `@username`, числовой `ID` или перешли сообщение человека сюда.";
}

function getMenuButtons() {
    return {
        inline_keyboard: [
            [
                { text: '📊 Моя статистика', callback_data: 'my_profile' },
                { text: 'ℹ️ Справка', callback_data: 'bot_info' }
            ],
            [
                { text: '⚙️ Статус Шпиона', callback_data: 'spy_status' },
                { text: '🔄 Обновить меню', callback_data: 'to_main' }
            ]
        ]
    };
}

// Поиск по локальной SQLite
function searchUser(param, isUsername, callback) {
    let querySQL = isUsername 
        ? `SELECT * FROM global_logs WHERE LOWER(username) = LOWER(?)`
        : `SELECT * FROM global_logs WHERE user_id = ?`;

    db.all(querySQL, [param], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return callback(`❌ *Пользователь не найден*\n\nПока логов по нему нет. Убедись, что юзербот сидит в чате и цель написала туда после запуска бота!`);
        }
        
        let totalMsg = 0, totalStickers = 0, chatsList = '';
        rows.forEach(row => {
            totalMsg += row.msg_count; totalStickers += row.sticker_count;
            chatsList += `• *${row.chat_title}*:\n   └ 💬 Сообщений: *${row.msg_count}* | 🏞 Стикеров: *${row.sticker_count}*\n`;
        });

        let response = `👤 *ДОСЬЕ ПОЛЬЗОВАТЕЛЯ* 👤\n\n` +
                       `• *Имя:* ${rows[0].first_name.replace(/[_*`\[\]]/g, '')}\n` +
                       `• *Ник:* ${rows[0].username}\n` +
                       `• *ID:* \`${rows[0].user_id}\`\n\n` +
                       `📈 *Активность во всех чатах:*\n` +
                       `• Всего сообщений: *${totalMsg}*\n` +
                       `• Всего стикеров: *${totalStickers}*\n` +
                       `• Последний раз замечен: _${rows[0].last_seen}_\n\n` +
                       `🏰 *Список замеченных чатов:* \n${chatsList}`;
        callback(response);
    });
}

// Приём текстовых запросов в ЛС
bot.on('message', (msg) => {
    if (msg.chat.type !== 'private') return;
    const chatId = msg.chat.id;
    let text = msg.text ? msg.text.trim() : '';

    if (text === '/start') {
        return bot.sendMessage(chatId, getWelcomeMessage(), { parse_mode: 'Markdown', reply_markup: getMenuButtons() });
    }

    let param = text;
    let isUsername = false;

    if (msg.forward_from) {
        param = msg.forward_from.id.toString();
    } else if (!msg.forward_from && text.startsWith('@')) {
        isUsername = true;
    } else if (!/^\d+$/.test(text)) {
        return bot.sendMessage(chatId, "⚠️ Неверный формат запроса. Введи ник с `@`, ID или перешли сообщение.");
    }

    searchUser(param, isUsername, (resultText) => {
        bot.sendMessage(chatId, resultText, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Обновить результаты', callback_data: `refresh:${isUsername ? 'u' : 'i'}:${param}` }],
                    [{ text: '⬅️ Вернуться в главное меню', callback_data: 'to_main' }]
                ]
            }
        });
    });
});

// Обработка кликов по кнопкам (Интерфейс без спама новыми сообщениями)
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (data === 'to_main') {
        bot.editMessageText(getWelcomeMessage(), {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getMenuButtons()
        }).catch(() => {});
    }

    if (data === 'bot_info') {
        bot.editMessageText("📖 *Справка по системе*\n\nБот работает в связке с твоим вторым аккаунтом (юзерботом). Тебе не нужны права администратора — просто добавь второй аккаунт в группы, логи из которых ты хочешь получать.", {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'to_main' }]] }
        }).catch(() => {});
    }

    if (data === 'spy_status') {
        const statusText = client.connected 
            ? "🟢 *Статус шпиона:* Подключен к Telegram API\n🤖 Логгер работает стабильно."
            : "🔴 *Статус шпиона:* Отключен. Проверь TELEGRAM_SESSION!";
        bot.editMessageText(statusText, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'to_main' }]] }
        }).catch(() => {});
    }

    if (data === 'my_profile') {
        searchUser(query.from.id.toString(), false, (resultText) => {
            bot.editMessageText(resultText, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'to_main' }]] }
            }).catch(() => {});
        });
    }

    if (data.startsWith('refresh:')) {
        const [_, type, param] = data.split(':');
        const isUsername = type === 'u';

        searchUser(param, isUsername, (resultText) => {
            bot.editMessageText(resultText, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Обновить результаты', callback_data: data }],
                        [{ text: '⬅️ Вернуться в главное меню', callback_data: 'to_main' }]
                    ]
                }
            }).catch(() => {
                bot.answerCallbackQuery(query.id, { text: "✨ Новой активности пока нет." });
            });
        });
    }

    try { bot.answerCallbackQuery(query.id); } catch(e) {}
});

startUserbot();

// ==========================================
// СЕРВЕР И АВТО-ПИНГ (АНТИ-СОН 24/7)
// ==========================================
const app = express();
app.get('/', (req, res) => res.send('Userbot System Alive'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Веб-сервер запущен на порту ${PORT}`);
    
    // Каждые 3 минуты пингуем сервер, чтобы Render не засыпал
    setInterval(() => {
        const url = process.env.RENDER_EXTERNAL_URL;
        if (url) {
            axios.get(url)
                .then(() => console.log('🚀 Сервер успешно пропингован, сон заблокирован!'))
                .catch((e) => console.log('⚠️ Ошибка пинга:', e.message));
        }
    }, 180000);
});
