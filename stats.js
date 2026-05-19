#!/usr/bin/env node
/**
 * ФАНСТАТ PRO - Refactored Version
 * Based on your existing stats.js with FloodWait Manager & Resilience
 * 
 * Key improvements:
 * - FloodWait Manager for rate limiting
 * - Better error handling & recovery
 * - Graceful shutdown
 * - Self-ping for Render.com
 * - Production-grade logging
 */

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const axios = require('axios');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  // Telegram API
  API_ID: parseInt(process.env.API_ID || '0'),
  API_HASH: process.env.API_HASH || '',
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  TELEGRAM_SESSION: process.env.TELEGRAM_SESSION || '',
  
  // Admin
  ADMIN_ID: parseInt(process.env.ADMIN_ID || '0'),
  
  // Server
  PORT: process.env.PORT || 3000,
  RENDER_URL: process.env.RENDER_URL || 'https://fanstat-pro.onrender.com',
  
  // Database
  DB_PATH: process.env.DB_PATH || './osint_pro.db',
};

const FLOODWAIT_CONFIG = {
  BASE_DELAY: 100, // ms
  MAX_RETRIES: 3,
  BACKOFF_MULTIPLIER: 2,
  FLOOD_CODES: [429, 420, 'FLOOD_WAIT', 'RATE_LIMIT_EXCEEDED'],
};

// ============================================================================
// FLOODWAIT MANAGER
// ============================================================================

class FloodWaitManager {
  constructor(baseDelay = 100, maxRetries = 3) {
    this.baseDelay = baseDelay;
    this.maxRetries = maxRetries;
    this.floodWaitUntil = 0;
    this.consecutiveErrors = 0;
    this.stats = {
      totalRequests: 0,
      totalBackoffs: 0,
      lastBackoffTime: 0,
    };
  }

  async execute(fn, retries = 0, label = 'Operation') {
    this.stats.totalRequests++;
    const now = Date.now();
    const waitTime = Math.max(0, this.floodWaitUntil - now);

    if (waitTime > 0) {
      console.log(`[FloodWait] Waiting ${waitTime}ms before ${label} (attempt ${retries + 1}/${this.maxRetries + 1})`);
      await this.sleep(waitTime);
    }

    try {
      const result = await fn();
      this.consecutiveErrors = 0;
      return result;
    } catch (error) {
      const isFloodWait = this.isFloodWaitError(error);

      if (isFloodWait && retries < this.maxRetries) {
        const backoffDelay = this.baseDelay * Math.pow(2, retries + 1);
        this.stats.totalBackoffs++;
        this.stats.lastBackoffTime = backoffDelay;
        this.floodWaitUntil = Date.now() + backoffDelay;
        
        console.warn(
          `[FloodWait] ${label} hit rate limit. Backoff: ${backoffDelay}ms (attempt ${retries + 1}/${this.maxRetries})`
        );
        
        await this.sleep(backoffDelay);
        return this.execute(fn, retries + 1, label);
      }

      this.consecutiveErrors++;
      throw error;
    }
  }

  isFloodWaitError(error) {
    if (!error) return false;
    const msg = error.message || '';
    const code = error.code;
    
    return FLOODWAIT_CONFIG.FLOOD_CODES.some(c => 
      msg.includes(c) || code === c
    );
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      ...this.stats,
      floodWaitUntil: this.floodWaitUntil,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  reset() {
    this.consecutiveErrors = 0;
    this.floodWaitUntil = 0;
  }
}

// ============================================================================
// DATABASE MANAGER
// ============================================================================

class DatabaseManager {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, async (err) => {
        if (err) {
          reject(err);
        } else {
          try {
            await this.initializeTables();
            resolve();
          } catch (e) {
            reject(e);
          }
        }
      });
    });
  }

  async initializeTables() {
    const tables = [
      `CREATE TABLE IF NOT EXISTS global_logs (
        chat_id TEXT PRIMARY KEY,
        chat_title TEXT,
        user_id TEXT,
        username TEXT,
        first_name TEXT,
        indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS spy_chats (
        chat_id TEXT PRIMARY KEY,
        chat_title TEXT,
        indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS spy_nodes (
        user_id TEXT PRIMARY KEY,
        session_string TEXT,
        indexed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS admin_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id INTEGER,
        action TEXT,
        query TEXT,
        result TEXT,
        logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_global_logs_user ON global_logs(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_global_logs_username ON global_logs(username)`,
      `CREATE INDEX IF NOT EXISTS idx_spy_chats_title ON spy_chats(chat_title)`,
    ];

    for (const sql of tables) {
      await this.run(sql);
    }

    console.log('[DB] Tables initialized');
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  close() {
    return new Promise((resolve, reject) => {
      this.db?.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// ============================================================================
// TELEGRAM CLIENT WRAPPER
// ============================================================================

class TelegramClientWrapper {
  constructor(apiId, apiHash, session, floodWaitManager) {
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.session = session;
    this.floodWaitManager = floodWaitManager;
    this.client = null;
    this.isConnected = false;
  }

  async initialize() {
    try {
      const stringSession = new StringSession(this.session || '');
      this.client = new TelegramClient(stringSession, this.apiId, this.apiHash, {
        connectionRetries: 5,
        requestRetries: 3,
        autoReconnect: true,
      });

      await this.client.connect();
      this.isConnected = true;
      console.log('[Telegram] Client connected');
      
      return this;
    } catch (error) {
      console.error('[Telegram] Connection failed:', error.message);
      throw error;
    }
  }

  async getEntity(entity) {
    return this.floodWaitManager.execute(
      () => this.client.getEntity(entity),
      0,
      `getEntity(${entity})`
    );
  }

  async getChat(chatId) {
    return this.floodWaitManager.execute(
      () => this.client.getEntity(chatId),
      0,
      `getChat(${chatId})`
    );
  }

  async getMessages(chatId, options = {}) {
    return this.floodWaitManager.execute(
      () => this.client.getMessages(chatId, options),
      0,
      `getMessages(${chatId})`
    );
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      this.isConnected = false;
    }
  }

  getMe() {
    return this.floodWaitManager.execute(
      () => this.client.getMe(),
      0,
      'getMe'
    );
  }
}

// ============================================================================
// OSINT OPERATIONS (YOUR EXISTING LOGIC)
// ============================================================================

class OSINTOperations {
  constructor(db, telegramClient, bot, floodWaitManager) {
    this.db = db;
    this.telegramClient = telegramClient;
    this.bot = bot;
    this.floodWaitManager = floodWaitManager;
  }

  /**
   * OSINT Search - find user activity history
   */
  async osintSearch(username, chatId) {
    try {
      const cleanUsername = username.replace('@', '').toLowerCase();
      
      const rows = await this.db.all(
        `SELECT DISTINCT chat_title FROM global_logs WHERE LOWER(username) = ? OR LOWER(first_name) = ?`,
        [cleanUsername, cleanUsername]
      );

      if (rows && rows.length > 0) {
        const list = rows.map((r, i) => `${i + 1}. ${r.chat_title}`).join('\n');
        const message = `🔎 Найден в чатах:\n\n${list}`;
        
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        
        // Log action
        await this.db.run(
          `INSERT INTO admin_actions (admin_id, action, query, result) VALUES (?, ?, ?, ?)`,
          [CONFIG.ADMIN_ID, 'osint_search', username, JSON.stringify({ found: rows.length })]
        );
      } else {
        await this.bot.sendMessage(chatId, '❌ Пользователь не найден в базе шпионах.');
      }
    } catch (error) {
      console.error('[OSINT] Search error:', error.message);
      await this.bot.sendMessage(chatId, `⚠️ Ошибка поиска: ${error.message}`);
    }
  }

  /**
   * Join chats from list
   */
  async joinChats(links, chatId) {
    const results = { success: [], failed: [] };

    await this.bot.sendMessage(chatId, `🚀 Начинаем вступление в ${links.length} чатов...`);

    for (let i = 0; i < links.length; i++) {
      try {
        const link = links[i].replace(/[`]/g, '').replace('t.me/', '').replace('https://', '');
        
        const result = await this.floodWaitManager.execute(
          () => this.telegramClient.client.invoke(
            new Api.channels.JoinChannelRequest({
              channel: link,
            })
          ),
          0,
          `joinChannel(${link})`
        );

        results.success.push(link);
        console.log(`[Join] ✅ Вступили в: ${link}`);
      } catch (error) {
        results.failed.push({ link: links[i], error: error.message });
        console.warn(`[Join] ❌ Ошибка: ${links[i]} - ${error.message}`);
      }

      // Progress update every 5 chats
      if ((i + 1) % 5 === 0) {
        await this.bot.sendMessage(
          chatId,
          `⏳ Прогресс: ${i + 1}/${links.length} (успешно: ${results.success.length})`
        );
      }
    }

    const summary = `
✅ Успешно: ${results.success.length}
❌ Ошибок: ${results.failed.length}
📊 Всего: ${links.length}
    `.trim();

    await this.bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
    
    // Log action
    await this.db.run(
      `INSERT INTO admin_actions (admin_id, action, query, result) VALUES (?, ?, ?, ?)`,
      [
        CONFIG.ADMIN_ID,
        'join_chats',
        links.length.toString(),
        JSON.stringify(results)
      ]
    );
  }

  /**
   * Get DB statistics
   */
  async getStats(chatId) {
    try {
      const logs = await this.db.get(`SELECT COUNT(*) as count FROM global_logs`);
      const chats = await this.db.get(`SELECT COUNT(*) as count FROM spy_chats`);

      const message = `
📊 **СТАТИСТИКА БД**

👥 Пользователей: ${logs?.count || 0}
💬 Чатов: ${chats?.count || 0}
🕐 Последнее обновление: ${new Date().toLocaleString('ru-RU')}
      `.trim();

      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('[Stats] Error:', error.message);
      await this.bot.sendMessage(chatId, `⚠️ Ошибка получения статистики: ${error.message}`);
    }
  }
}

// ============================================================================
// EXPRESS SERVER
// ============================================================================

class ExpressServer {
  constructor(port, floodWaitManager) {
    this.app = express();
    this.port = port;
    this.floodWaitManager = floodWaitManager;
    this.server = null;
  }

  initialize() {
    this.app.use(express.json());

    // Health check
    this.app.get('/health', (req, res) => {
      res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    });

    // Status
    this.app.get('/status', (req, res) => {
      res.status(200).json({
        service: 'FANSTAT PRO',
        status: 'operational',
        floodWait: this.floodWaitManager.getStats(),
      });
    });

    // Error handler
    this.app.use((err, req, res, next) => {
      console.error('[Express] Error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    });

    this.server = this.app.listen(this.port, () => {
      console.log(`[Express] Server running on port ${this.port}`);
    });

    return this.server;
  }

  close() {
    return new Promise(resolve => {
      if (this.server) {
        this.server.close(resolve);
      } else {
        resolve();
      }
    });
  }
}

// ============================================================================
// SELF-PING MANAGER
// ============================================================================

class SelfPingManager {
  constructor(url, interval = 25 * 60 * 1000) {
    this.url = url;
    this.interval = interval;
    this.timerId = null;
  }

  start() {
    this.timerId = setInterval(async () => {
      try {
        await axios.get(`${this.url}/health`, { timeout: 5000 });
        console.log(`[Ping] ✅ Self-ping OK at ${new Date().toISOString()}`);
      } catch (error) {
        console.error('[Ping] ❌ Self-ping failed:', error.message);
      }
    }, this.interval);

    console.log('[Ping] Manager started (interval: 25 minutes)');
  }

  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      console.log('[Ping] Manager stopped');
    }
  }
}

// ============================================================================
// MAIN APPLICATION
// ============================================================================

class FANSTATApplication {
  constructor() {
    this.db = new DatabaseManager(CONFIG.DB_PATH);
    this.floodWaitManager = new FloodWaitManager(
      FLOODWAIT_CONFIG.BASE_DELAY,
      FLOODWAIT_CONFIG.MAX_RETRIES
    );
    this.telegramClient = null;
    this.bot = null;
    this.expressServer = null;
    this.selfPingManager = null;
    this.osintOps = null;
  }

  async initialize() {
    console.log('='.repeat(70));
    console.log('🚀 ФАНСТАТ PRO - Initializing...');
    console.log('='.repeat(70));

    try {
      // Initialize database
      await this.db.initialize();
      console.log('[Init] ✅ Database ready');

      // Initialize Telegram client
      this.telegramClient = new TelegramClientWrapper(
        CONFIG.API_ID,
        CONFIG.API_HASH,
        CONFIG.TELEGRAM_SESSION,
        this.floodWaitManager
      );
      await this.telegramClient.initialize();
      const me = await this.telegramClient.getMe();
      console.log(`[Init] ✅ Telegram authenticated as: ${me.firstName}`);

      // Initialize Bot API
      this.bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });
      console.log('[Init] ✅ Bot API connected');

      // Initialize OSINT operations
      this.osintOps = new OSINTOperations(
        this.db,
        this.telegramClient,
        this.bot,
        this.floodWaitManager
      );
      console.log('[Init] ✅ OSINT Engine ready');

      // Initialize Express server
      this.expressServer = new ExpressServer(CONFIG.PORT, this.floodWaitManager);
      this.expressServer.initialize();
      console.log('[Init] ✅ Express server ready');

      // Initialize self-ping
      this.selfPingManager = new SelfPingManager(CONFIG.RENDER_URL);
      this.selfPingManager.start();
      console.log('[Init] ✅ Self-ping manager ready');

      // Setup bot handlers
      this.setupBotHandlers();

      console.log('='.repeat(70));
      console.log('✅ ФАНСТАТ PRO is operational');
      console.log('='.repeat(70));

      // Status monitor
      setInterval(() => {
        const stats = this.floodWaitManager.getStats();
        console.log(
          `[Status] Requests: ${stats.totalRequests}, Backoffs: ${stats.totalBackoffs}, ` +
          `Errors: ${stats.consecutiveErrors}, FloodWaitUntil: ${new Date(stats.floodWaitUntil).toISOString()}`
        );
      }, 30000);

    } catch (error) {
      console.error('[Init] ❌ Initialization failed:', error.message);
      throw error;
    }
  }

  setupBotHandlers() {
    // Message handler
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const text = msg.text || '';

      // Only admin can use commands
      if (userId !== CONFIG.ADMIN_ID) {
        return;
      }

      try {
        if (text === '/start') {
          await this.bot.sendMessage(
            chatId,
            '🔍 *ФАНСТАТ OSINT | ГЛАВНОЕ МЕНЮ*\n\n' +
            'Нажмите кнопку для действия:',
            {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: this.getMainButtons(userId) }
            }
          );
        } else if (text.startsWith('/search ')) {
          const username = text.replace('/search ', '');
          await this.osintOps.osintSearch(username, chatId);
        }
      } catch (error) {
        console.error('[Bot] Handler error:', error.message);
        await this.bot.sendMessage(chatId, `⚠️ Ошибка: ${error.message}`);
      }
    });

    // Callback query handler
    this.bot.on('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      const userId = query.from.id;
      const data = query.data;

      if (userId !== CONFIG.ADMIN_ID) {
        await this.bot.answerCallbackQuery(query.id, 'Доступ запрещён', true);
        return;
      }

      try {
        if (data === 'osint_search') {
          await this.bot.sendMessage(chatId, 'Введите @username для поиска:');
        } else if (data === 'admin_panel') {
          await this.osintOps.getStats(chatId);
        } else if (data === 'join_mode') {
          await this.bot.sendMessage(chatId, 'Введите ссылки на чаты (по одной в строке):');
        }

        await this.bot.answerCallbackQuery(query.id);
      } catch (error) {
        console.error('[Bot] Callback error:', error.message);
        await this.bot.answerCallbackQuery(query.id, 'Ошибка', true);
      }
    });
  }

  getMainButtons(userId) {
    const buttons = [
      [{ text: '🔎 Поиск юзера (OSINT)', callback_data: 'osint_search' }],
      [{ text: '❤️ Стать добровольцем', callback_data: 'join_network' }],
    ];

    if (userId === CONFIG.ADMIN_ID) {
      buttons.push([{ text: '⚙️ АДМИН-ПАНЕЛЬ', callback_data: 'admin_panel' }]);
      buttons.push([{ text: '📤 Авто-вступление', callback_data: 'join_mode' }]);
    }

    return buttons;
  }

  async shutdown() {
    console.log('\n[Shutdown] Graceful shutdown initiated...');

    try {
      this.selfPingManager?.stop();
      await this.telegramClient?.disconnect();
      await this.db.close();
      await this.expressServer?.close();
      this.bot?.stopPolling();
      
      console.log('[Shutdown] ✅ Complete');
      process.exit(0);
    } catch (error) {
      console.error('[Shutdown] Error:', error.message);
      process.exit(1);
    }
  }

  setupSignalHandlers() {
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  setupErrorHandlers() {
    process.on('uncaughtException', (error) => {
      console.error('[UncaughtException]', error);
      this.shutdown();
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[UnhandledRejection]', reason);
    });
  }
}

// ============================================================================
// ENTRY POINT
// ============================================================================

async function main() {
  const app = new FANSTATApplication();
  app.setupSignalHandlers();
  app.setupErrorHandlers();

  try {
    await app.initialize();
  } catch (error) {
    console.error('[Main] Fatal error:', error.message);
    process.exit(1);
  }
}

main();
