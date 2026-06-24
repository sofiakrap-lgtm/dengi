'use strict';

/*
 * Денежный обмен между Софией и Никитой.
 * Сервер без внешних зависимостей: встроенный http + хранение в data.json.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const storage = require('./storage');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Начальное состояние ---------------------------------------------------

const DEFAULT_STATE = {
  users: {
    nikita: { name: 'Никита', balance: 298 },
    sofia: { name: 'София', balance: 250 },
    aleksey: { name: 'Алексей', balance: 200 },
  },
  messages: [],      // { id, from, text, ts }
  transactions: [],  // { id, from, to, amount, note, ts }
  cards: [],         // { id, title, description, emoji, color, owner, createdBy, createdAt, history:[{from,to,ts}] }
};

const VALID_USERS = ['nikita', 'sofia', 'aleksey'];

// Кто может создавать карты.
// Никита — без ограничений; Алексей — не чаще одной карты в 24 часа.
const CARD_CREATORS = ['nikita', 'aleksey'];

const DAY_MS = 24 * 60 * 60 * 1000;

// Лимит создания карт по пользователю (мс между картами). Если пользователя
// нет в этом списке — он создаёт карты без ограничений.
const CARD_RATE_LIMITS = {
  aleksey: DAY_MS, // одна карта в сутки
};

// Пароли пользователей. Можно переопределить через переменные окружения
// (PIN_NIKITA / PIN_SOFIA / PIN_ALEKSEY), иначе — простые значения по умолчанию.
const PASSWORDS = {
  nikita: process.env.PIN_NIKITA || '2222',
  sofia: process.env.PIN_SOFIA || '1111',
  aleksey: process.env.PIN_ALEKSEY || '3333',
};

// --- Хранилище -------------------------------------------------------------

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));

async function loadState() {
  const parsed = await storage.load();
  if (!parsed) {
    // Первый запуск — сохраняем начальное состояние (не падаем при ошибке).
    try {
      await storage.save(state);
    } catch (err) {
      console.error('Не удалось сохранить начальное состояние:', err.message);
    }
    return;
  }
  // Подстраховка: гарантируем наличие полей и всех пользователей
  // (например, Алексея, если данные сохранены до его добавления).
  const baseUsers = JSON.parse(JSON.stringify(DEFAULT_STATE.users));
  state = {
    users: Object.assign(baseUsers, parsed.users || {}),
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
    cards: Array.isArray(parsed.cards) ? parsed.cards : [],
  };
}

async function saveState() {
  await storage.save(state);
}

function id() {
  return crypto.randomBytes(8).toString('hex');
}

// --- Утилиты HTTP ----------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // Защита от выхода за пределы каталога.
  const safePath = path
    .normalize(urlPath)
    .replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не найдено');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    });
    res.end(content);
  });
}

// --- Бизнес-логика API -----------------------------------------------------

function publicState() {
  return {
    users: state.users,
    messages: state.messages,
    transactions: state.transactions,
    cards: state.cards,
    storage: storage.backend, // 'upstash' = данные сохраняются навсегда
  };
}

async function handleApi(req, res, urlPath) {
  // GET /api/state — всё состояние.
  if (req.method === 'GET' && urlPath === '/api/state') {
    return sendJson(res, 200, publicState());
  }

  // POST /api/login — проверка пароля пользователя.
  if (req.method === 'POST' && urlPath === '/api/login') {
    const body = await readBody(req);
    const user = String(body.user || '');
    const password = String(body.password || '');

    if (!VALID_USERS.includes(user)) {
      return sendJson(res, 400, { error: 'Неизвестный пользователь' });
    }
    if (password !== PASSWORDS[user]) {
      return sendJson(res, 401, { error: 'Неверный пароль' });
    }
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/message — отправить сообщение в чат.
  if (req.method === 'POST' && urlPath === '/api/message') {
    const body = await readBody(req);
    const from = String(body.from || '');
    const text = String(body.text || '').trim();

    if (!VALID_USERS.includes(from)) {
      return sendJson(res, 400, { error: 'Неизвестный пользователь' });
    }
    if (!text) {
      return sendJson(res, 400, { error: 'Пустое сообщение' });
    }
    if (text.length > 2000) {
      return sendJson(res, 400, { error: 'Сообщение слишком длинное' });
    }

    const msg = { id: id(), from, text, ts: Date.now() };
    state.messages.push(msg);
    await saveState();
    return sendJson(res, 200, { ok: true, message: msg });
  }

  // POST /api/transfer — перевод денег выбранному пользователю.
  if (req.method === 'POST' && urlPath === '/api/transfer') {
    const body = await readBody(req);
    const from = String(body.from || '');
    const to = String(body.to || '');
    const amount = Number(body.amount);
    const note = String(body.note || '').trim().slice(0, 200);

    if (!VALID_USERS.includes(from)) {
      return sendJson(res, 400, { error: 'Неизвестный пользователь' });
    }
    if (!VALID_USERS.includes(to) || to === from) {
      return sendJson(res, 400, { error: 'Выберите получателя' });
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      return sendJson(res, 400, { error: 'Введите корректную сумму' });
    }
    // Округляем до 2 знаков.
    const amt = Math.round(amount * 100) / 100;

    if (amt > state.users[from].balance) {
      return sendJson(res, 400, { error: 'Недостаточно средств' });
    }

    state.users[from].balance =
      Math.round((state.users[from].balance - amt) * 100) / 100;
    state.users[to].balance =
      Math.round((state.users[to].balance + amt) * 100) / 100;

    const tx = { id: id(), from, to, amount: amt, note, ts: Date.now() };
    state.transactions.push(tx);
    await saveState();
    return sendJson(res, 200, { ok: true, transaction: tx, users: state.users });
  }

  // POST /api/card/create — создать новую карту.
  // Никита — без ограничений; Алексей — не чаще одной карты в сутки.
  if (req.method === 'POST' && urlPath === '/api/card/create') {
    const body = await readBody(req);
    const from = String(body.from || '');
    const title = String(body.title || '').trim().slice(0, 40);
    const description = String(body.description || '').trim().slice(0, 200);
    const emoji = String(body.emoji || '🃏').trim().slice(0, 8) || '🃏';
    const color = String(body.color || 'violet').trim().slice(0, 16);

    if (!CARD_CREATORS.includes(from)) {
      return sendJson(res, 403, { error: 'У вас нет прав на создание карт' });
    }

    // Ограничение по частоте (для Алексея — одна карта в 24 часа).
    const limit = CARD_RATE_LIMITS[from];
    if (limit) {
      const lastAt = state.cards.reduce(
        (max, c) => (c.createdBy === from ? Math.max(max, c.createdAt || 0) : max),
        0
      );
      const elapsed = Date.now() - lastAt;
      if (lastAt && elapsed < limit) {
        const hoursLeft = Math.ceil((limit - elapsed) / (60 * 60 * 1000));
        return sendJson(res, 429, {
          error: 'Можно создавать только одну карту в сутки. Попробуйте через ' + hoursLeft + ' ч.',
        });
      }
    }

    if (!title) {
      return sendJson(res, 400, { error: 'Введите название карты' });
    }

    const card = {
      id: id(),
      title,
      description,
      emoji,
      color,
      owner: from,
      createdBy: from,
      createdAt: Date.now(),
      history: [], // { from, to, ts }
    };
    state.cards.push(card);
    await saveState();
    return sendJson(res, 200, { ok: true, card });
  }

  // POST /api/card/give — подарить карту другому пользователю.
  // Содержимое карты неизменно: меняется только владелец.
  if (req.method === 'POST' && urlPath === '/api/card/give') {
    const body = await readBody(req);
    const from = String(body.from || '');
    const to = String(body.to || '');
    const cardId = String(body.cardId || '');

    if (!VALID_USERS.includes(from)) {
      return sendJson(res, 400, { error: 'Неизвестный пользователь' });
    }
    if (!VALID_USERS.includes(to) || to === from) {
      return sendJson(res, 400, { error: 'Выберите получателя' });
    }

    const card = state.cards.find((c) => c.id === cardId);
    if (!card) {
      return sendJson(res, 404, { error: 'Карта не найдена' });
    }
    if (card.owner !== from) {
      return sendJson(res, 403, { error: 'Это не ваша карта' });
    }

    card.history.push({ from, to, ts: Date.now() });
    card.owner = to;
    await saveState();
    return sendJson(res, 200, { ok: true, card });
  }

  return sendJson(res, 404, { error: 'Не найдено' });
}

// --- Сервер ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath.startsWith('/api/')) {
    try {
      await handleApi(req, res, urlPath);
    } catch (err) {
      sendJson(res, 400, { error: 'Некорректный запрос' });
    }
    return;
  }

  serveStatic(req, res);
});

storage
  .init()
  .then(loadState)
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Сервер запущен: http://localhost:${PORT} (хранилище: ${storage.backend})`);
    });
  })
  .catch((err) => {
    // Даже при ошибке поднимаем сервер, чтобы сайт был доступен.
    console.error('Ошибка при старте:', err.message);
    server.listen(PORT, () => {
      console.log(`Сервер запущен (с ошибкой хранилища): http://localhost:${PORT}`);
    });
  });
