const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const express = require('express');
const axios = require('axios');

// ==========================================
// ЗАЩИТА ОТ КРИТИЧЕСКИХ ПАДЕНИЙ (АНТИ-КРАШ)
// ==========================================
process.on('uncaughtException', (err) => {
    console.error('⚠️ Перехвачена критическая ошибка (Бот продолжает жить):', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Необработанное обещание заблокировано (Бот работает):', reason);
});

// Официальные ключи Telegram Desktop (вшиты, чтобы обойти баги сайта телеги)
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

// Стартуем юзербота
async function startUserbot() {
    if (!process.env.TELEGRAM_SESSION) {
        console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: Забыл указать TELEGRAM_SESSION в Render!");
        return;
    }
    try {
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
            } catch (e) {
                console.error("Ошибка при обработке сообщения юзерботом:", e.message);
            }
        });
    } catch (err) {
        console.error("Ошибка подключения юзербота:", err.message);
    }
}

// Меню
function getMainMenu() {
    return {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '❓ Как пользоваться', callback_data: 'help' }],
                [{ text: '🔄 Сбросить поиск / На главную', callback_data: 'reset' }]
            ]
        }
    };
}

// Поиск по БД
function searchUser(param, isUsername, callback) {
    let querySQL = isUsername 
        ? `SELECT * FROM global_logs WHERE LOWER(username) = LOWER(?)`
        : `SELECT * FROM global_logs WHERE user_id = ?`;

    db.all(querySQL, [param], (err, rows) => {
        if (err) {
            console.error("Ошибка БД:", err.message);
            return callback("⚠️ Ошибка при обращении к базе данных.");
        }
        if (!rows || rows.length === 0) {
            return callback(`❌ *Пользователь не найден*\n\nВ моей базе логов пусто. Он должен написать хоть что-то в чатах со шпионом, чтобы попасть в радар!`);
        }
        
        let totalMsg = 0, totalStickers = 0, chatsList = '';
        rows.forEach(row => {
            totalMsg += row.msg_count; totalStickers += row.sticker_count;
            chatsList += `• *${row.chat_title}*:\n   └ 💬 Сообщений: *${row.msg_count}* | 🏞 Стикеров: *${row.sticker_count}*\n`;
        });

        let response = `👤 *ДОСЬЕ ПОЛЬЗОВАТЕЛЯ* 👤\n\n• *Имя:* ${rows[0].first_name}\n• *Ник:* ${rows[0].username}\n• *ID:* \`${rows[0].user_id}\`\n\n📊 *Всего активности:*\n• Сообщений: *${totalMsg}*\n• Стикеров: *${totalStickers}*\n• Лог обновлен: _${rows[0].last_seen}_\n\n🏰 *Замечен в чатах:* \n${chatsList}`;
        callback(response);
    });
}

// Сообщения в ЛС
bot.on('message', (msg) => {
    if (msg.chat.type !== 'private') return;
    const chatId = msg.chat.id;
    let text = msg.text ? msg.text.trim() : '';

    if (text === '/start') {
        return bot.sendMessage(chatId, "📊 *Фанстат | Юзербот версия*\n\nОтправь мне `@username`, Telegram ID или просто перешли сообщение человека из группы сюда. Я выдам всю статистику активности!", getMainMenu());
    }

    let param = text;
    let isUsername = false;

    if (msg.forward_from) {
        param = msg.forward_from.id.toString();
    } else if (!msg.forward_from && text.startsWith('@')) {
        isUsername = true;
    } else if (!/^\d+$/.test(text)) {
        return bot.sendMessage(chatId, "⚠️ Неверный формат. Отправь ник с `@` или цифровой ID.");
    }

    searchUser(param, isUsername, (resultText) => {
        const opt = {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '🔄 Обновить данные', callback_data: `refresh:${isUsername ? 'u' : 'i'}:${param}` }]]
            }
        };
        bot.sendMessage(chatId, resultText, opt);
    });
});

// Кнопки (Редактирование сообщений)
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (data === 'help') {
        bot.editMessageText("📖 *Инструкция шпиона:*\n\n1. Добавь свой второй аккаунт в нужные группы.\n2. Как только цели напишут туда новое сообщение, бот внесет их в логи.\n3. Скидывай сюда их никнеймы и проверяй статистику!", {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'reset' }]] }
        }).catch(() => {});
    }

    if (data === 'reset') {
        bot.editMessageText("📊 *Фанстат | Юзербот версия*\n\nОтправь мне `@username`, Telegram ID или просто перешли сообщение человека из группы сюда. Я выдам всю статистику активности!", {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getMainMenu().reply_markup
        }).catch(() => {});
    }

    if (data.startsWith('refresh:')) {
        const [_, type, param] = data.split(':');
        const isUsername = type === 'u';

        searchUser(param, isUsername, (resultText) => {
            bot.editMessageText(resultText, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '🔄 Обновить данные', callback_data: data }]] }
            }).catch(() => {
                bot.answerCallbackQuery(query.id, { text: "⚡️ Новых сообщений в группах пока нет!" });
            });
        });
    }
    
    try { bot.answerCallbackQuery(query.id); } catch (e) {}
});

startUserbot();

// ==========================================
// ВЕБ-СЕРВЕР И АВТО-ПИНГ (АНТИ-СОН)
// ==========================================
const app = express();
app.get('/', (req, res) => res.send('Userbot UI Active and Running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    
    // Каждые 5 минут (300000 мс) пингуем внешний URL, чтобы Render не усыплял бота
    setInterval(() => {
        const url = process.env.RENDER_EXTERNAL_URL;
        if (url) {
            axios.get(url)
                .then(() => console.log('🚀 Авто-пинг прошел успешно, сервер бодрствует!'))
                .catch((e) => console.log('⚠️ Ошибка авто-пинга (но сервер живет):', e.message));
        } else {
            console.log('ℹ️ Авто-пинг пропущен: RENDER_EXTERNAL_URL не настроен (локальный запуск).');
        }
    }, 300000);
});
