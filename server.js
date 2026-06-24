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
  },
  messages: [],      // { id, from, text, ts }
  transactions: [],  // { id, from, to, amount, note, ts }
};

const VALID_USERS = ['nikita', 'sofia'];

// --- Хранилище -------------------------------------------------------------

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));

async function loadState() {
  const parsed = await storage.load();
  if (!parsed) {
    // Первый запуск — сохраняем начальное состояние.
    await storage.save(state);
    return;
  }
  // Подстраховка: гарантируем наличие полей.
  state = {
    users: parsed.users || DEFAULT_STATE.users,
    messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
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
  };
}

async function handleApi(req, res, urlPath) {
  // GET /api/state — всё состояние.
  if (req.method === 'GET' && urlPath === '/api/state') {
    return sendJson(res, 200, publicState());
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

  // POST /api/transfer — перевод денег другому пользователю.
  if (req.method === 'POST' && urlPath === '/api/transfer') {
    const body = await readBody(req);
    const from = String(body.from || '');
    const amount = Number(body.amount);
    const note = String(body.note || '').trim().slice(0, 200);

    if (!VALID_USERS.includes(from)) {
      return sendJson(res, 400, { error: 'Неизвестный пользователь' });
    }
    const to = VALID_USERS.find((u) => u !== from);

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

loadState()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Сервер запущен: http://localhost:${PORT} (хранилище: ${storage.backend})`);
    });
  })
  .catch((err) => {
    console.error('Не удалось загрузить состояние:', err);
    process.exit(1);
  });
