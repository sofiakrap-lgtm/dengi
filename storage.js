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

// Текущий режим: 'upstash' пока проверка не покажет проблему.
let mode = useUpstash ? 'upstash' : 'file';
let note = '';

// Проверяем доступность Upstash при старте. Если токен/URL неверны —
// не падаем, а переходим на временное файловое хранилище и громко
// предупреждаем (история не переживёт перезапуск, пока не исправят).
async function init() {
  if (mode !== 'upstash') return;
  try {
    await upstashCommand(['PING']);
    console.log('Upstash подключён — данные сохраняются постоянно.');
  } catch (err) {
    mode = 'file';
    note = err.message;
    console.error('⚠️  ' + err.message);
    console.error(
      '⚠️  Временно использую файловое хранилище. История НЕ сохранится ' +
      'между перезапусками, пока не исправишь токен Upstash!'
    );
  }
}

async function load() {
  if (mode === 'upstash') {
    const data = await upstashCommand(['GET', KEY]);
    return data && data.result ? JSON.parse(data.result) : null;
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
  if (mode === 'upstash') {
    await upstashCommand(['SET', KEY, json]);
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

module.exports = {
  init,
  load,
  save,
  get backend() {
    return mode;
  },
  get note() {
    return note;
  },
};
