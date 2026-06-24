'use strict';

(function () {
  const USERS = {
    sofia: { name: 'София', letter: 'С', cls: 'avatar-sofia' },
    nikita: { name: 'Никита', letter: 'Н', cls: 'avatar-nikita' },
  };

  let me = localStorage.getItem('dengi_user'); // 'sofia' | 'nikita' | null
  let lastState = null;
  let lastMsgCount = 0;

  // --- Элементы ---
  const $ = (id) => document.getElementById(id);
  const loginEl = $('login');
  const appEl = $('app');

  // --- Вход ---
  document.querySelectorAll('.user-pick').forEach((btn) => {
    btn.addEventListener('click', () => {
      me = btn.dataset.user;
      localStorage.setItem('dengi_user', me);
      enterApp();
    });
  });

  $('switch-user').addEventListener('click', () => {
    localStorage.removeItem('dengi_user');
    me = null;
    appEl.classList.add('hidden');
    loginEl.classList.remove('hidden');
  });

  // --- Вкладки ---
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      ['chat', 'send', 'history'].forEach((p) => {
        $('panel-' + p).classList.toggle('hidden', p !== name);
      });
      if (name === 'chat') scrollChatToBottom();
    });
  });

  // --- Форматирование ---
  function fmtAmount(n) {
    const v = Math.round(Number(n) * 100) / 100;
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return hm;
    const dm = d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    return dm + ' ' + hm;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  // --- Запуск приложения ---
  function enterApp() {
    if (!me || !USERS[me]) return;
    loginEl.classList.add('hidden');
    appEl.classList.remove('hidden');

    const u = USERS[me];
    const av = $('me-avatar');
    av.textContent = u.letter;
    av.className = 'avatar ' + u.cls;
    $('me-name').textContent = u.name;

    lastMsgCount = 0;
    refresh(true);
  }

  // --- Отрисовка состояния ---
  function render(state) {
    lastState = state;
    const other = me === 'sofia' ? 'nikita' : 'sofia';

    // Балансы
    $('bal-me-name').textContent = USERS[me].name + ' (ты)';
    $('bal-other-name').textContent = USERS[other].name;
    $('bal-me').textContent = fmtAmount(state.users[me].balance);
    $('bal-other').textContent = fmtAmount(state.users[other].balance);

    // Перевод — кому
    $('send-to-name').textContent = USERS[other].name;

    renderChat(state.messages);
    renderHistory(state.transactions);
  }

  function renderChat(messages) {
    const chat = $('chat');
    if (!messages.length) {
      chat.innerHTML = '<div class="chat-empty">Сообщений пока нет.<br>Напиши первым 👋</div>';
      return;
    }
    chat.innerHTML = messages
      .map((m) => {
        const mine = m.from === me;
        return (
          '<div class="bubble ' + (mine ? 'mine' : 'theirs') + '">' +
          escapeHtml(m.text) +
          '<span class="time">' + fmtTime(m.ts) + '</span>' +
          '</div>'
        );
      })
      .join('');

    // Прокрутка вниз при новых сообщениях
    if (messages.length !== lastMsgCount) {
      lastMsgCount = messages.length;
      scrollChatToBottom();
    }
  }

  function scrollChatToBottom() {
    const chat = $('chat');
    requestAnimationFrame(() => {
      chat.scrollTop = chat.scrollHeight;
    });
  }

  function renderHistory(txs) {
    const el = $('history');
    if (!txs.length) {
      el.innerHTML = '<div class="history-empty">Переводов пока нет.</div>';
      return;
    }
    const sorted = txs.slice().sort((a, b) => b.ts - a.ts);
    el.innerHTML = sorted
      .map((t) => {
        const incoming = t.to === me;
        const partner = incoming ? USERS[t.from].name : USERS[t.to].name;
        const title = incoming ? 'От ' + partner : 'Для ' + partner;
        const sign = incoming ? '+' : '−';
        const note = t.note ? '<div class="tx-note">' + escapeHtml(t.note) + '</div>'
                            : '<div class="tx-time">' + fmtTime(t.ts) + '</div>';
        return (
          '<div class="tx">' +
          '<div class="tx-icon ' + (incoming ? 'tx-in' : 'tx-out') + '">' + (incoming ? '↓' : '↑') + '</div>' +
          '<div class="tx-body">' +
          '<div class="tx-title">' + title + '</div>' +
          note +
          (t.note ? '<div class="tx-time">' + fmtTime(t.ts) + '</div>' : '') +
          '</div>' +
          '<div class="tx-amount ' + (incoming ? 'in' : 'out') + '">' + sign + fmtAmount(t.amount) + ' D</div>' +
          '</div>'
        );
      })
      .join('');
  }

  // --- Сеть ---
  async function refresh(scroll) {
    try {
      const res = await fetch('/api/state');
      const state = await res.json();
      render(state);
      if (scroll) scrollChatToBottom();
    } catch (err) {
      /* тихо игнорируем — повторим при следующем опросе */
    }
  }

  // Чат
  $('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: me, text }),
      });
      await refresh(true);
    } catch (err) {
      input.value = text; // вернуть текст при ошибке
    }
  });

  // Быстрые суммы
  document.querySelectorAll('.quick button').forEach((b) => {
    b.addEventListener('click', () => {
      const cur = parseFloat($('send-amount').value) || 0;
      $('send-amount').value = fmtAmount(cur + Number(b.dataset.q));
    });
  });

  // Перевод
  $('send-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = $('send-msg');
    const amount = parseFloat($('send-amount').value);
    const note = $('send-note').value.trim();

    msgEl.className = 'send-msg';
    msgEl.textContent = '';

    if (!amount || amount <= 0) {
      msgEl.classList.add('err');
      msgEl.textContent = 'Введите сумму больше нуля';
      return;
    }

    try {
      const res = await fetch('/api/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: me, amount, note }),
      });
      const data = await res.json();
      if (!res.ok) {
        msgEl.classList.add('err');
        msgEl.textContent = data.error || 'Ошибка перевода';
        return;
      }
      const other = me === 'sofia' ? 'nikita' : 'sofia';
      msgEl.classList.add('ok');
      msgEl.textContent = 'Отправлено ' + fmtAmount(amount) + ' D для ' + USERS[other].name + ' ✓';
      $('send-amount').value = '';
      $('send-note').value = '';
      await refresh(false);
    } catch (err) {
      msgEl.classList.add('err');
      msgEl.textContent = 'Сеть недоступна, попробуйте ещё раз';
    }
  });

  // --- Опрос обновлений (для синхронизации между телефонами) ---
  setInterval(() => {
    if (me) refresh(false);
  }, 3000);

  // --- Старт ---
  if (me && USERS[me]) {
    enterApp();
  }
})();
