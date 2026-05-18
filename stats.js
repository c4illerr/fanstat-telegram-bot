const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const express = require('express');
const axios = require('axios');

// ====================================================================
// 🛡️ СИСТЕМА ЖЕЛЕЗОБЕТОННОЙ ЗАЩИТЫ ОТ КРАШЕЙ И ПАДЕНИЙ (АНТИ-КАПРИЗ)
// ====================================================================
process.on('uncaughtException', (err) => {
    console.error('🚨 [Критический перехват] Ошибка потока:', err.stack || err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 [Критический перехват] Необработанный Promise:', reason);
});

// Официальные глобальные ключи Telegram Desktop для обхода багов
const apiId = 2040;
const apiHash = "b18441a1ff607e10a989891a5462e627";
const stringSession = new StringSession(process.env.TELEGRAM_SESSION || "");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
    console.error("❌ ОШИБКА: Переменная TELEGRAM_TOKEN отсутствует в Environment!");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ====================================================================
// 📊 ИНИЦИАЛИЗАЦИЯ СУБД SQLITE С РАСШИРЕННЫМИ ПОЛЯМИ АНАЛИТИКИ
// ====================================================================
const dbPath = path.join(__dirname, 'global_telelog.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // Основная таблица логов сообщений
    db.run(`CREATE TABLE IF NOT EXISTS global_logs (
        chat_id TEXT,
        chat_title TEXT,
        user_id TEXT,
        username TEXT,
        first_name TEXT,
        msg_count INTEGER DEFAULT 0,
        sticker_count INTEGER DEFAULT 0,
        last_seen TEXT,
        last_hour INTEGER DEFAULT 0,
        PRIMARY KEY (chat_id, user_id)
    )`);

    // Дополнительная таблица системного кэша чатов для модуля мониторинга чатов
    db.run(`CREATE TABLE IF NOT EXISTS spy_chats (
        chat_id TEXT PRIMARY KEY,
        chat_title TEXT,
        total_captured INTEGER DEFAULT 0
    )`);
});

const client = new TelegramClient(stringSession, apiId, apiHash, { 
    connectionRetries: 10,
    useWSS: true
});

// ====================================================================
// 🛰️ МОДУЛЬ ЮЗЕРБОТА-ШПИОНА (С ГАРАНТИРОВАННЫМ СБОРОМ СОБЫТИЙ)
// ====================================================================
async function startUserbot() {
    if (!process.env.TELEGRAM_SESSION) {
        console.error("❌ КРИТИЧЕСКАЯ ОШИБКА: TELEGRAM_SESSION пуста! Юзербот отключен.");
        return;
    }
    try {
        console.log("🔄 Инициализация подключения к серверам Telegram...");
        await client.connect();
        
        const me = await client.getMe();
        console.log(`✅ [ЮЗЕРБОТ АВТОРИЗОВАН]: @${me.username} | Имя: ${me.firstName}`);

        // 🔥 ЖЕСТКИЙ ПИНГ ТЕЛЕГРАМА: подгружаем диалоги, чтобы GramJS начал слушать входящий поток
        console.log("📦 Синхронизация активных чатов и каналов...");
        await client.getDialogs({ limit: 30 });
        console.log("📡 Поток обновлений успешно захвачен. Шпион слушает сеть чатов...");

        client.addEventHandler(async (event) => {
            const message = event.message;
            if (!message) return;

            try {
                // Фильтруем только группы, супергруппы и каналы
                if (!message.isGroup && !message.isChannel) return;

                const sender = await message.getSender();
                if (!sender || sender.bot) return;

                const chat = await message.getChat();
                const chatTitle = chat.title || "Скрытая группа";
                
                const chatId = message.chatId ? message.chatId.toString() : "";
                const userId = sender.id.toString();
                const username = sender.username ? `@${sender.username}` : "Без ника";
                const firstName = sender.firstName || "Пользователь";
                
                // Проверяем тип контента
                const isSticker = message.media && message.media.className === 'MessageMediaDocument' ? 1 : 0;
                const isMsg = isSticker ? 0 : 1;
                
                // Таймштампы
                const moscowTime = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
                const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).getHours();

                console.log(`📥 [ПЕРЕХВАТ CHAT: ${chatTitle}] От: ${username} | Сообщение: "${message.message || '[Медиа]'}"`);

                // 1. Обновляем глобальные логи юзера
                db.run(`
                    INSERT INTO global_logs (chat_id, chat_title, user_id, username, first_name, msg_count, sticker_count, last_seen, last_hour)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET
                        chat_title = excluded.chat_title, username = excluded.username, first_name = excluded.first_name,
                        msg_count = msg_count + excluded.msg_count, sticker_count = sticker_count + excluded.sticker_count,
                        last_seen = excluded.last_seen, last_hour = excluded.last_hour
                `, [chatId, chatTitle, userId, username, firstName, isMsg, isSticker, moscowTime, currentHour]);

                // 2. Обновляем счетчик самого чата в модуле мониторинга
                db.run(`
                    INSERT INTO spy_chats (chat_id, chat_title, total_captured)
                    VALUES (?, ?, 1) ON CONFLICT(chat_id) DO UPDATE SET
                        chat_title = excluded.chat_title, total_captured = total_captured + 1
                `, [chatId, chatTitle]);

            } catch (err) {
                console.error("⚠️ Ошибка парсинга события внутри обработчика:", err.message);
            }
        }, new NewMessage({}));

    } catch (err) {
        console.error("❌ КРИТИЧЕСКАЯ ОШИБКА запуска юзербота:", err.message);
    }
}

// ====================================================================
// 🧠 КОРПОРУТИВНЫЙ МОДУЛЬ ИНТЕРФЕЙСА (СТИЛИСТИКА POST AI / CHATGPT)
// ====================================================================

function getMainMenuText() {
    return "⚡️ *ИНФОРМАЦИОННО-АНАЛИТИЧЕСКИЙ ХАБ | ФАНСТАТ* ⚡️\n\n" +
           "Приветствую! Я функционирую в связке с твоим автономным юзерботом-логгером.\n\n" +
           "🕵️‍♂️ *Текущая задача:* Скрытый сбор логов активности пользователей во всех доступных чатах (без необходимости прав администратора).\n\n" +
           "📊 *Поисковый радар:* Чтобы запросить досье на цель, просто отправь мне её `@username`, числовой `ID` или перешли её сообщение из любой группы сюда.";
}

function getMainMenuButtons() {
    return {
        inline_keyboard: [
            [
                { text: '🏆 Топ-10 Флудеров', callback_data: 'global_top' },
                { text: '🏰 Мониторинг чатов', callback_data: 'chats_status' }
            ],
            [
                { text: '👤 Мой профиль', callback_data: 'my_profile' },
                { text: '⚙️ Статус Шпиона', callback_data: 'spy_status' }
            ],
            [
                { text: '📖 Инструкция', callback_data: 'bot_info' }
            ]
        ]
    };
}

// Аналитический генератор психологического портрета активности юзера
function generatePsychologicalProfile(totalMsg, totalStickers, lastHour) {
    let style = "Обычный пользователь";
    if (totalStickers > totalMsg) style = "🎨 Стикерный маньяк (предпочитает картинки словам)";
    else if (totalMsg > 200) style = "🗣 Глобальный Флудер (не остановить)";
    
    let timeHabit = "Дневная активность";
    if (lastHour >= 0 && lastHour <= 5) timeHabit = "🦉 Ночной призрак (активничает глубокой ночью)";
    else if (lastHour >= 6 && lastHour <= 11) timeHabit = "🌅 Ранняя птичка (пишет по утрам)";
    else if (lastHour >= 18 && lastHour <= 23) timeHabit = "🌆 Вечерний завсегдатай";

    return `• *Психотип:* _${style}_\n• *Биоритм:* _${timeHabit}_`;
}

// Мощная функция генерации досье
function searchUser(param, isUsername, callback) {
    let querySQL = isUsername 
        ? `SELECT * FROM global_logs WHERE LOWER(username) = LOWER(?)`
        : `SELECT * FROM global_logs WHERE user_id = ?`;

    db.all(querySQL, [param], (err, rows) => {
        if (err) return callback("⚠️ Произошел системный сбой базы данных.");
        if (!rows || rows.length === 0) {
            return callback(`❌ *ПОЛЬЗОВАТЕЛЬ НЕ НАЙДЕН В БАЗЕ ЛОГОВ*\n\nНа данный момент шпион не перехватил ни одного сообщения от данного лица.\n\n*Причины:*\n1. Цель ещё ничего не писала в группах с момента старта скрипта.\n2. Твой второй аккаунт не состоит в чатах, где общается эта цель.`);
        }
        
        let totalMsg = 0, totalStickers = 0, chatsList = '';
        const baseUser = rows[0];

        rows.forEach(row => {
            totalMsg += row.msg_count;
            totalStickers += row.sticker_count;
            chatsList += `• *${row.chat_title}*:\n   └ 💬 Сообщений: *${row.msg_count}* | 🏞 Стикеров: *${row.sticker_count}*\n`;
        });

        const aiProfile = generatePsychologicalProfile(totalMsg, totalStickers, baseUser.last_hour);

        let response = `👤 *РАСШИРЕННОЕ ДОСЬЕ ПОЛЬЗОВАТЕЛЯ* 👤\n\n` +
                       `• *Имя профиля:* ${baseUser.first_name.replace(/[_*`\[\]]/g, '')}\n` +
                       `• *Юзернейм:* ${baseUser.username}\n` +
                       `• *Telegram ID:* \`${baseUser.user_id}\`\n\n` +
                       `🧠 *АНАЛИТИЧЕСКИЙ ПРОФИЛЬ (POST-AI):*\n${aiProfile}\n\n` +
                       `📈 *СВОДНЫЕ ПОКАЗАТЕЛИ АКТИВНОСТИ:*\n` +
                       `• Перехвачено сообщений: *${totalMsg}*\n` +
                       `• Сгенерировано стикеров: *${totalStickers}*\n` +
                       `• Последняя фиксация: _${baseUser.last_seen}_\n\n` +
                       ` Castle *ЛОКАЦИИ ОБЩЕНИЯ (ЗАМЕЧЕН В ЧАТАХ):*\n${chatsList}`;
        callback(response);
    });
}

// ====================================================================
// 📥 ОБРАБОТЧИК ДИАЛОГОВ В ЛС (ОСНОВНОЙ ИНТЕРФЕЙС БОТА)
// ====================================================================
bot.on('message', (msg) => {
    if (msg.chat.type !== 'private') return;
    const chatId = msg.chat.id;
    let text = msg.text ? msg.text.trim() : '';

    if (text === '/start') {
        return bot.sendMessage(chatId, getMainMenuText(), { parse_mode: 'Markdown', reply_markup: getMainMenuButtons() });
    }

    let param = text;
    let isUsername = false;

    if (msg.forward_from) {
        param = msg.forward_from.id.toString();
    } else if (!msg.forward_from && text.startsWith('@')) {
        isUsername = true;
    } else if (!/^\d+$/.test(text)) {
        return bot.sendMessage(chatId, "⚠️ *Ошибка формата.* Введите никнейм корректно (начиная с `@`), укажите ID цифрами, либо перешлите входящее сообщение цели.");
    }

    searchUser(param, isUsername, (resultText) => {
        bot.sendMessage(chatId, resultText, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Обновить досье', callback_data: `refresh:${isUsername ? 'u' : 'i'}:${param}` }],
                    [{ text: '⬅️ В главное меню', callback_data: 'to_main' }]
                ]
            }
        });
    });
});

// ====================================================================
// 🎛️ СИСТЕМА ОБРАБОТКИ НАЖАТИЙ (ИНТЕРФЕЙС БЕЗ СПАМА С РЕДАКТИРОВАНИЕМ)
// ====================================================================
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (data === 'to_main') {
        bot.editMessageText(getMainMenuText(), {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getMainMenuButtons()
        }).catch(() => {});
    }

    else if (data === 'bot_info') {
        const info = "📖 *ИНСТРУКЦИЯ И СПРАВОЧНЫЕ МАТЕРИАЛЫ*\n\n" +
                     "Система разработана для тотального мониторинга активности без админ-прав.\n\n" +
                     "1️⃣ Помести свой второй аккаунт (юзербота) в любые интересующие чаты.\n" +
                     "2️⃣ Скрипт в реальном времени перехватывает сообщения, анализирует их структуру и заносит в локальную базу SQLite.\n" +
                     "3️⃣ Запрашивай отчеты через ЛС главного бота. Все данные обновляются динамически.";
        bot.editMessageText(info, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Вернуться назад', callback_data: 'to_main' }]] }
        }).catch(() => {});
    }

    else if (data === 'spy_status') {
        const statusText = client.connected 
            ? `🟢 *МОДУЛЬ ШПИОНА АКТИВЕН*\n\n• Подключение к API: *Стабильное*\n• База данных: *Онлайн*\n• Режим работы: *Скрытый логгер*`
            : `🔴 *МОДУЛЬ ШПИОНА ОТКЛЮЧЕН*\n\nСистеме не удалось верифицировать сессию на сервере Render. Проверь настройки токена сессии.`;
        bot.editMessageText(statusText, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Вернуться назад', callback_data: 'to_main' }]] }
        }).catch(() => {});
    }

    else if (data === 'my_profile') {
        searchUser(query.from.id.toString(), false, (resultText) => {
            bot.editMessageText(resultText, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Вернуться назад', callback_data: 'to_main' }]] }
            }).catch(() => {});
        });
    }

    // 🔥 МАСШТАБНЫЙ МОДУЛЬ: ТОП-10 ФЛУДЕРОВ СЕТИ
    else if (data === 'global_top') {
        db.all(`SELECT username, first_name, SUM(msg_count) as total FROM global_logs GROUP BY user_id ORDER BY total DESC LIMIT 10`, [], (err, rows) => {
            let topText = "🏆 *ТОП-10 САМЫХ АКТИВНЫХ ПОЛЬЗОВАТЕЛЕЙ СЕТИ* 🏆\n\n";
            if (err || !rows || rows.length === 0) {
                topText += "_В базе данных пока недостаточно логов для формирования рейтинга._";
            } else {
                rows.forEach((row, index) => {
                    topText += `${index + 1}. *${row.first_name}* (${row.username}) — 💬 *${row.total}* собщ.\n`;
                });
            }
            bot.editMessageText(topText, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Вернуться назад', callback_data: 'to_main' }]] }
            }).catch(() => {});
        });
    }

    // 🔥 МАСШТАБНЫЙ МОДУЛЬ: МОНИТОРИНГ ПОДКЛЮЧЕННЫХ ЧАТОВ
    else if (data === 'chats_status') {
        db.all(`SELECT * FROM spy_chats ORDER BY total_captured DESC`, [], (err, rows) => {
            let chatText = " Castle *СПИСОК ОТСЛЕЖИВАЕМЫХ ГРУПП И КАНАЛОВ* Castle\n\n";
            if (err || !rows || rows.length === 0) {
                chatText += "_Шпион пока не зафиксировал активности ни в одном групповом чате._";
            } else {
                chatText += `Всего групп под наблюдением: *${rows.length}*\n\n`;
                rows.forEach((row, index) => {
                    chatText += `${index + 1}. *${row.chat_title}*\n   └ Перехвачено: *${row.total_captured}* собщ.\n`;
                });
            }
            bot.editMessageText(chatText, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Вернуться назад', callback_data: 'to_main' }]] }
            }).catch(() => {});
        });
    }

    else if (data.startsWith('refresh:')) {
        const [_, type, param] = data.split(':');
        const isUsername = type === 'u';

        searchUser(param, isUsername, (resultText) => {
            bot.editMessageText(resultText, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Обновить досье', callback_data: data }],
                        [{ text: '⬅️ В главное меню', callback_data: 'to_main' }]
                    ]
                }
            }).catch(() => {
                bot.answerCallbackQuery(query.id, { text: "⚡️ Изменений нет. Данные досье актуальны." });
            });
        });
    }

    try { bot.answerCallbackQuery(query.id); } catch(e) {}
});

startUserbot();

// ====================================================================
// 🌐 СЕРВЕРНАЯ СИСТЕМА И АВТО-ПИНГ ДО КОНЦА ВРЕМЕН (АНТИ-СОН РЕНДЕРА)
// ====================================================================
const app = express();
app.get('/', (req, res) => res.send('Post AI Analytics Engine Active'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Executive Server] Запущен на порту: ${PORT}`);
    
    setInterval(() => {
        const url = process.env.RENDER_EXTERNAL_URL;
        if (url) {
            axios.get(url)
                .then(() => console.log('🚀 [Авто-Пинг] Сервер успешно пропингован. Сон заблокирован.'))
                .catch((e) => console.log('⚠️ [Авто-Пинг] Ошибка запроса:', e.message));
        }
    }, 180000);
});
