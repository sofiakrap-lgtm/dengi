'use strict';

/*
 * Слой хранения состояния.
 *
 * Если заданы переменные окружения UPSTASH_REDIS_REST_URL и
 * UPSTASH_REDIS_REST_TOKEN — состояние хранится в Upstash Redis
 * (постоянно, переживает перезапуски на бесплатном Render).
 * Иначе используется локальный файл data.json (для разработки).
 */

const fs = require('fs');
const path = require('path');

const KEY = 'dengi:state';
const DATA_FILE = path.join(__dirname, 'data.json');

// Убираем случайные кавычки/пробелы/переводы строк, которые часто
// попадают при копировании значений из .env в панель хостинга.
function clean(v) {
  return String(v || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

const UPSTASH_URL = clean(process.env.UPSTASH_REDIS_REST_URL);
const UPSTASH_TOKEN = clean(process.env.UPSTASH_REDIS_REST_TOKEN);
const useUpstash = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

async function upstashCommand(command) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + UPSTASH_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = ' — ' + (await res.text()).slice(0, 200); } catch (e) {}
    if (res.status === 401) {
      throw new Error(
        'Upstash 401: токен отклонён. Проверь UPSTASH_REDIS_REST_TOKEN ' +
        '(должен быть из раздела REST API, без кавычек и пробелов).' + detail
      );
    }
    throw new Error('Upstash error ' + res.status + detail);
  }
  return res.json(); // { result: ... }
}

async function load() {
  if (useUpstash) {
    try {
      const data = await upstashCommand(['GET', KEY]);
      return data && data.result ? JSON.parse(data.result) : null;
    } catch (err) {
      console.error('Не удалось загрузить из Upstash:', err.message);
      return null;
    }
  }

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

async function save(state) {
  const json = JSON.stringify(state);
  if (useUpstash) {
    await upstashCommand(['SET', KEY, json]);
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

module.exports = { load, save, backend: useUpstash ? 'upstash' : 'file' };
