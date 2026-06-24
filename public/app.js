'use strict';

(function () {
  const USERS = {
    sofia: { name: 'София', letter: 'С', cls: 'avatar-sofia' },
    nikita: { name: 'Никита', letter: 'Н', cls: 'avatar-nikita' },
    aleksey: { name: 'Алексей', letter: 'А', cls: 'avatar-aleksey' },
  };
  const ORDER = ['sofia', 'nikita', 'aleksey'];
  // Кто может создавать карты (Алексей — не чаще одной в сутки, лимит на сервере).
  const CARD_CREATORS = ['nikita', 'aleksey'];
  const canCreateCards = (u) => CARD_CREATORS.includes(u);

  const EMOJIS = ['🃏', '⭐', '🎁', '💎', '🏆', '❤️', '🔥', '🎮', '🍀', '👑'];
  const COLORS = ['violet', 'blue', 'pink', 'green', 'gold', 'red'];

  let me = null;               // становится собой только после ввода пароля
  let pendingUser = null;      // выбран на шаге пароля
  const storedUser = localStorage.getItem('dengi_user'); // для подстановки
  let lastState = null;
  let lastMsgCount = 0;
  let recipient = null;        // выбранный получатель перевода
  let newCardEmoji = EMOJIS[0];
  let newCardColor = COLORS[0];

  const $ = (id) => document.getElementById(id);
  const loginEl = $('login');
  const appEl = $('app');

  function others() {
    return ORDER.filter((u) => u !== me);
  }

  // --- Вход (два шага: выбор пользователя → пароль) ---
  function showPicker() {
    $('login-pass').classList.add('hidden');
    $('login-pick').classList.remove('hidden');
    $('pass-input').value = '';
    $('pass-err').textContent = '';
  }

  function showPassword(user) {
    pendingUser = user;
    $('login-pick').classList.add('hidden');
    $('login-pass').classList.remove('hidden');
    const av = $('pass-avatar');
    av.textContent = USERS[user].letter;
    av.className = 'avatar big ' + USERS[user].cls;
    $('pass-name').textContent = USERS[user].name;
    $('pass-err').textContent = '';
    $('pass-input').value = '';
    setTimeout(() => $('pass-input').focus(), 60);
  }

  document.querySelectorAll('.user-pick').forEach((btn) => {
    btn.addEventListener('click', () => showPassword(btn.dataset.user));
  });

  $('pass-back').addEventListener('click', showPicker);

  $('login-pass').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('pass-input').value;
    const errEl = $('pass-err');
    errEl.textContent = '';
    if (!password) {
      errEl.textContent = 'Введите пароль';
      return;
    }
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: pendingUser, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.error || 'Неверный пароль';
        return;
      }
      me = pendingUser;
      localStorage.setItem('dengi_user', me);
      enterApp();
    } catch (err) {
      errEl.textContent = 'Сеть недоступна, попробуйте ещё раз';
    }
  });

  $('switch-user').addEventListener('click', () => {
    me = null;
    appEl.classList.add('hidden');
    loginEl.classList.remove('hidden');
    showPicker();
  });

  // --- Вкладки ---
  const TABS = ['chat', 'send', 'cards', 'history'];
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const name = tab.dataset.tab;
      TABS.forEach((p) => {
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
    return String(s).replace(/[&<>"']/g, (c) => ({
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

    if (!recipient || recipient === me) recipient = others()[0];

    buildRecipients();
    buildCardCreateControls();
    lastMsgCount = 0;
    refresh(true);
  }

  // --- Получатели перевода ---
  function buildRecipients() {
    const box = $('send-recipients');
    box.innerHTML = others()
      .map((u) => {
        const sel = u === recipient ? ' selected' : '';
        return (
          '<button type="button" class="recipient' + sel + '" data-user="' + u + '">' +
          '<span class="avatar ' + USERS[u].cls + '">' + USERS[u].letter + '</span>' +
          '<span>' + USERS[u].name + '</span>' +
          '</button>'
        );
      })
      .join('');
    box.querySelectorAll('.recipient').forEach((b) => {
      b.addEventListener('click', () => {
        recipient = b.dataset.user;
        box.querySelectorAll('.recipient').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      });
    });
  }

  // --- Контролы создания карты (значок + цвет) ---
  function buildCardCreateControls() {
    $('card-create').classList.toggle('hidden', !canCreateCards(me));
    if (!canCreateCards(me)) return;

    // Подсказка о суточном лимите (для Алексея).
    const hint = $('card-create-hint');
    if (hint) {
      hint.classList.toggle('hidden', me !== 'aleksey');
    }

    const ep = $('card-emoji-pick');
    ep.innerHTML = EMOJIS.map(
      (e) => '<button type="button" class="emoji-opt' + (e === newCardEmoji ? ' selected' : '') + '" data-e="' + e + '">' + e + '</button>'
    ).join('');
    ep.querySelectorAll('.emoji-opt').forEach((b) => {
      b.addEventListener('click', () => {
        newCardEmoji = b.dataset.e;
        ep.querySelectorAll('.emoji-opt').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      });
    });

    const cp = $('card-color-pick');
    cp.innerHTML = COLORS.map(
      (c) => '<button type="button" class="color-opt card-' + c + (c === newCardColor ? ' selected' : '') + '" data-c="' + c + '"></button>'
    ).join('');
    cp.querySelectorAll('.color-opt').forEach((b) => {
      b.addEventListener('click', () => {
        newCardColor = b.dataset.c;
        cp.querySelectorAll('.color-opt').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      });
    });
  }

  // --- Отрисовка состояния ---
  function render(state) {
    lastState = state;

    renderBalances(state.users);

    // Предупреждение, если данные не сохраняются постоянно
    const warn = $('storage-warn');
    if (warn) {
      warn.classList.toggle('hidden', !state.storage || state.storage === 'upstash');
    }

    renderChat(state.messages);
    renderHistory(state.transactions);
    renderCards(state.cards || []);
  }

  function renderBalances(users) {
    const el = $('balances');
    const order = [me].concat(others());
    el.innerHTML = order
      .map((u) => {
        const mine = u === me;
        return (
          '<div class="balance-card' + (mine ? ' me' : '') + '">' +
          '<div class="balance-label">' +
          '<span class="avatar mini ' + USERS[u].cls + '">' + USERS[u].letter + '</span>' +
          USERS[u].name + (mine ? ' (ты)' : '') +
          '</div>' +
          '<div class="balance-value">' + fmtAmount(users[u].balance) + ' <span class="cur">D</span></div>' +
          '</div>'
        );
      })
      .join('');
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
        const who = mine ? '' : '<span class="bubble-name">' + escapeHtml(USERS[m.from] ? USERS[m.from].name : m.from) + '</span>';
        return (
          '<div class="bubble ' + (mine ? 'mine' : 'theirs') + '">' +
          who +
          escapeHtml(m.text) +
          '<span class="time">' + fmtTime(m.ts) + '</span>' +
          '</div>'
        );
      })
      .join('');

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
        const involved = t.from === me || t.to === me;
        const fromName = USERS[t.from] ? USERS[t.from].name : t.from;
        const toName = USERS[t.to] ? USERS[t.to].name : t.to;
        let title;
        if (incoming) title = 'От ' + fromName;
        else if (t.from === me) title = 'Для ' + toName;
        else title = fromName + ' → ' + toName;
        const sign = involved ? (incoming ? '+' : '−') : '';
        const cls = involved ? (incoming ? 'in' : 'out') : 'neutral';
        const icon = involved ? (incoming ? '↓' : '↑') : '↔';
        return (
          '<div class="tx">' +
          '<div class="tx-icon ' + (incoming ? 'tx-in' : 'tx-out') + '">' + icon + '</div>' +
          '<div class="tx-body">' +
          '<div class="tx-title">' + escapeHtml(title) + '</div>' +
          (t.note ? '<div class="tx-note">' + escapeHtml(t.note) + '</div>' : '') +
          '<div class="tx-time">' + fmtTime(t.ts) + '</div>' +
          '</div>' +
          '<div class="tx-amount ' + cls + '">' + sign + fmtAmount(t.amount) + ' D</div>' +
          '</div>'
        );
      })
      .join('');
  }

  // --- Карты ---
  function cardHtml(card, withActions) {
    const ownerName = USERS[card.owner] ? USERS[card.owner].name : card.owner;
    let actions = '';
    if (withActions) {
      actions =
        '<div class="card-actions">' +
        others()
          .map(
            (u) =>
              '<button class="give-btn" data-card="' + card.id + '" data-to="' + u + '">Подарить: ' + USERS[u].name + '</button>'
          )
          .join('') +
        '</div>';
    }
    const passed = card.history && card.history.length
      ? '<span class="card-passed"> · передавалась ' + card.history.length + ' раз</span>'
      : '';
    return (
      '<div class="game-card card-' + escapeHtml(card.color || 'violet') + '">' +
      '<div class="game-card-emoji">' + escapeHtml(card.emoji || '🃏') + '</div>' +
      '<div class="game-card-body">' +
      '<div class="game-card-title">' + escapeHtml(card.title) + '</div>' +
      (card.description ? '<div class="game-card-desc">' + escapeHtml(card.description) + '</div>' : '') +
      '<div class="game-card-meta">Владелец: <strong>' + escapeHtml(ownerName) + '</strong>' + passed + '</div>' +
      '</div>' +
      actions +
      '</div>'
    );
  }

  function renderCards(cards) {
    const mine = cards.filter((c) => c.owner === me);
    const myEl = $('my-cards');
    myEl.innerHTML = mine.length
      ? mine.map((c) => cardHtml(c, true)).join('')
      : '<div class="cards-empty">У тебя пока нет карт.</div>';

    const allEl = $('all-cards');
    allEl.innerHTML = cards.length
      ? cards.slice().reverse().map((c) => cardHtml(c, false)).join('')
      : '<div class="cards-empty">Карт пока нет.' + (canCreateCards(me) ? ' Создай первую!' : '') + '</div>';

    // Кнопки «подарить»
    myEl.querySelectorAll('.give-btn').forEach((b) => {
      b.addEventListener('click', () => giveCard(b.dataset.card, b.dataset.to));
    });
  }

  async function giveCard(cardId, to) {
    const card = (lastState.cards || []).find((c) => c.id === cardId);
    if (!card) return;
    if (!confirm('Подарить карту «' + card.title + '» пользователю ' + USERS[to].name + '?\nЭто действие нельзя отменить.')) {
      return;
    }
    try {
      const res = await fetch('/api/card/give', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: me, to, cardId }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Не удалось подарить карту');
        return;
      }
      await refresh(false);
    } catch (err) {
      alert('Сеть недоступна, попробуйте ещё раз');
    }
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
      input.value = text;
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

    if (!recipient) {
      msgEl.classList.add('err');
      msgEl.textContent = 'Выберите получателя';
      return;
    }
    if (!amount || amount <= 0) {
      msgEl.classList.add('err');
      msgEl.textContent = 'Введите сумму больше нуля';
      return;
    }

    try {
      const res = await fetch('/api/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: me, to: recipient, amount, note }),
      });
      const data = await res.json();
      if (!res.ok) {
        msgEl.classList.add('err');
        msgEl.textContent = data.error || 'Ошибка перевода';
        return;
      }
      msgEl.classList.add('ok');
      msgEl.textContent = 'Отправлено ' + fmtAmount(amount) + ' D для ' + USERS[recipient].name + ' ✓';
      $('send-amount').value = '';
      $('send-note').value = '';
      await refresh(false);
    } catch (err) {
      msgEl.classList.add('err');
      msgEl.textContent = 'Сеть недоступна, попробуйте ещё раз';
    }
  });

  // Создание карты (Никита)
  $('card-create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msgEl = $('card-msg');
    const title = $('card-title').value.trim();
    const description = $('card-desc').value.trim();

    msgEl.className = 'send-msg';
    msgEl.textContent = '';

    if (!title) {
      msgEl.classList.add('err');
      msgEl.textContent = 'Введите название карты';
      return;
    }

    try {
      const res = await fetch('/api/card/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: me, title, description, emoji: newCardEmoji, color: newCardColor }),
      });
      const data = await res.json();
      if (!res.ok) {
        msgEl.classList.add('err');
        msgEl.textContent = data.error || 'Ошибка создания карты';
        return;
      }
      msgEl.classList.add('ok');
      msgEl.textContent = 'Карта создана ✓';
      $('card-title').value = '';
      $('card-desc').value = '';
      await refresh(false);
    } catch (err) {
      msgEl.classList.add('err');
      msgEl.textContent = 'Сеть недоступна, попробуйте ещё раз';
    }
  });

  // --- Опрос обновлений ---
  setInterval(() => {
    if (me) refresh(false);
  }, 3000);

  // --- Старт --- (пароль спрашивается при каждом входе)
  if (storedUser && USERS[storedUser]) {
    showPassword(storedUser);
  } else {
    showPicker();
  }
})();
