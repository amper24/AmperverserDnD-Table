// ---------------------------------------------------------------------------
// profile-page.js — страница профиля (/profile).
//
// Блоки:
//   «Основное» — имя (1..64 после trim) и аватар (файл или портрет из
//                библиотеки) с dirty-индикатором, сохранением и отменой;
//   «Почта»    — новый адрес + код подтверждения (и текущий пароль, если он
//                задан), затем повторная проверка уникальности на сервере;
//   «Пароль»   — старый/новый/повтор; сервер завершает остальные сессии;
//   «Аккаунт»  — выход, «на всех устройствах», удаление по вводу почты.
//
// Данные — существующие HTTP API: /api/auth/me, /api/auth/settings,
// /api/assets?kind=portrait, /api/auth/change-email*, /api/auth/change-password,
// /api/auth/logout(-all), DELETE /api/auth/me. Сервер остаётся источником правды
// и валидации; клиент повторяет те же ограничения, чтобы объяснить ошибку сразу.
// Зависимости: common.js, asset-kinds.js.
// ---------------------------------------------------------------------------
(async function () {
  const app = document.getElementById('app');
  const APP_NAME = 'Edge Tablet';
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let me;
  try {
    me = await API.get('/api/auth/me');
  } catch (e) {
    if (e?.status === 401 || e?.message === 'unauthorized') {
      go('/login?next=' + encodeURIComponent(location.pathname + location.search), true);
      return;
    }
    app.append(el('div', { class: 'center' },
      el('div', { class: 'card auth' },
        el('h2', {}, 'Не удалось открыть профиль'),
        el('p', { class: 'muted' }, e?.message || 'Ошибка сети'),
        el('a', { href: '/', class: 'btn' }, 'На главную'))));
    return;
  }

  const settings = await API.get('/api/auth/settings').catch(() => ({}));
  const PW_MIN = Number(settings.password_min_length) || 8;
  const MAX_UPLOAD_MB = Number(settings.max_upload_mb) || 25;
  document.title = 'Профиль — ' + APP_NAME;

  // ---------- общие помощники ----------
  function formatDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  }
  function initialOf(name) {
    const s = (name || '').trim();
    return s ? Array.from(s)[0].toUpperCase() : '?';
  }
  function errorNode(id) {
    return el('p', { class: 'profile-error', id, role: 'alert', hidden: '' });
  }
  function showError(node, text) { node.textContent = text || ''; node.hidden = !text; }
  function clearError(node) { showError(node, ''); }
  function field(labelText, control, help, error, cls) {
    return el('div', { class: 'field profile-field' + (cls ? ' ' + cls : '') },
      el('label', { for: control.id }, labelText), control, help || null, error || null);
  }
  function blockHead(id, title, extra) {
    return el('div', { class: 'profile-block-head' }, el('h2', { id }, title), extra || null);
  }
  function paintAvatar(node, id, name) {
    node.replaceChildren();
    node.textContent = initialOf(name);
    if (!id) return;
    assetURL(id).then(url => {
      if (!node.isConnected) return;
      node.replaceChildren(el('img', { src: url, alt: '' }));
    }).catch(() => { /* остаётся инициал */ });
  }
  function nameRule(value) {
    const name = value.trim();
    const n = Array.from(name).length;
    if (!n) return 'Имя не может быть пустым';
    if (n > 64) return `Имя слишком длинное: ${n} символов (максимум 64)`;
    return '';
  }

  // ---------- шапка страницы ----------
  const topbarUserLink = el('a', { href: '/profile', class: 'userlink', 'aria-current': 'page', title: 'Профиль' }, me.name || 'Профиль');
  app.append(el('header', { class: 'topbar' },
    el('a', { href: '/', class: 'brand' }, APP_NAME),
    el('nav', { class: 'mainnav', 'aria-label': 'Основная навигация' },
      el('a', { href: '/campaigns' }, 'Кампании'),
      el('a', { href: '/characters' }, 'Персонажи'),
      el('a', { href: '/compendium' }, 'Справочник')),
    el('span', { class: 'spacer' }),
    Theme.button(),
    el('span', { class: 'userbox' }, topbarUserLink)));

  const page = el('main', { class: 'page profile-page' });
  app.append(page);

  const heroAvatar = el('div', { class: 'profile-avatar', id: 'profile-avatar-hero', 'aria-hidden': 'true' });
  const heroName = el('h1', { id: 'profile-title' }, me.name || 'Без имени');
  const heroEmail = el('p', { class: 'profile-email', id: 'profile-email-current' }, me.email);
  const heroRole = el('span', { class: 'badge ' + (me.is_root ? 'root' : 'player') },
    me.is_root ? 'root' : 'Пользователь');
  const heroCreated = el('span', { class: 'profile-meta-item' },
    'На сайте с ', el('time', { datetime: me.created_at || '' }, formatDate(me.created_at)));
  page.append(el('section', { class: 'card profile-hero', 'aria-labelledby': 'profile-title' },
    heroAvatar,
    el('div', { class: 'profile-identity' },
      el('div', { class: 'profile-eyebrow' }, 'Профиль'),
      heroName,
      heroEmail,
      el('div', { class: 'profile-meta' },
        heroRole,
        heroCreated,
        el('span', { class: 'profile-meta-item' }, me.has_password ? 'Вход по паролю' : 'Вход по коду'))),
    el('div', { class: 'profile-hero-actions' },
      el('a', { class: 'btn', href: '/' }, icon('left'), ' Назад'))));
  paintAvatar(heroAvatar, me.avatar_asset_id, me.name, 'Аватар');

  // ---------- «Основное»: имя и аватар ----------
  const saved = { name: (me.name || '').trim(), avatar: me.avatar_asset_id || null };
  let avatarDraft = saved.avatar;
  let busy = false;

  const nameInput = el('input', {
    id: 'profile-name', name: 'name', type: 'text', maxlength: '64', autocomplete: 'nickname',
    required: '', 'aria-describedby': 'profile-name-help profile-name-error',
  });
  nameInput.value = saved.name;
  const nameHelp = el('p', { class: 'muted small', id: 'profile-name-help' }, 'От 1 до 64 символов; пробелы по краям обрезаются.');
  const nameError = errorNode('profile-name-error');

  const dirtyBadge = el('span', { class: 'profile-dirty', id: 'profile-dirty', role: 'status', 'aria-live': 'polite', hidden: '' }, 'Несохранённые изменения');
  const saveBtn = el('button', { type: 'submit', class: 'primary', id: 'profile-save', disabled: '' }, 'Сохранить');
  const cancelBtn = el('button', { type: 'button', id: 'profile-cancel', disabled: '' }, 'Отмена');

  const avatarPreview = el('div', { class: 'profile-avatar profile-avatar-small', id: 'profile-avatar-preview', 'aria-hidden': 'true' });
  const fileInput = el('input', { type: 'file', id: 'profile-avatar-file', class: 'profile-file', accept: 'image/png,image/jpeg,image/webp,image/gif', 'aria-label': 'Файл аватара' });
  const uploadBtn = el('button', { type: 'button', id: 'profile-avatar-upload', class: 'small', 'aria-controls': 'profile-avatar-file' }, 'Загрузить файл');
  const libraryBtn = el('button', { type: 'button', id: 'profile-avatar-library', class: 'small' }, 'Из библиотеки');
  const removeAvatarBtn = el('button', { type: 'button', id: 'profile-avatar-remove', class: 'small' }, 'Убрать');
  const avatarNote = el('p', { class: 'muted small', id: 'profile-avatar-note' }, 'Показывается в шапке, списке участников кампании и чате. Сжимается до 1024 px и хранится в базе.');
  const avatarError = errorNode('profile-avatar-error');

  function paintDraftAvatar() {
    paintAvatar(avatarPreview, avatarDraft, nameInput.value || me.name);
    removeAvatarBtn.disabled = !avatarDraft;
  }
  function isDirty() {
    return nameInput.value.trim() !== saved.name || (avatarDraft || null) !== (saved.avatar || null);
  }
  function updateDirty() {
    const dirty = isDirty();
    dirtyBadge.hidden = !dirty;
    saveBtn.disabled = !dirty || busy;
    cancelBtn.disabled = !dirty || busy;
    saveBtn.textContent = busy ? 'Сохранение…' : 'Сохранить';
  }
  function setBusy(value) {
    busy = value;
    uploadBtn.disabled = value;
    libraryBtn.disabled = value;
    removeAvatarBtn.disabled = value || !avatarDraft;
    updateDirty();
  }
  function setAvatar(id) {
    avatarDraft = id || null;
    paintDraftAvatar();
    updateDirty();
  }

  nameInput.addEventListener('input', () => { clearError(nameError); nameInput.removeAttribute('aria-invalid'); updateDirty(); });
  cancelBtn.addEventListener('click', () => {
    nameInput.value = saved.name;
    avatarDraft = saved.avatar;
    clearError(nameError);
    clearError(avatarError);
    nameInput.removeAttribute('aria-invalid');
    paintDraftAvatar();
    updateDirty();
    nameInput.focus();
  });
  removeAvatarBtn.addEventListener('click', () => { setAvatar(null); clearError(avatarError); });
  uploadBtn.addEventListener('click', () => fileInput.click());
  libraryBtn.addEventListener('click', () => openLibrary());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    clearError(avatarError);
    if (!file.type || !file.type.startsWith('image/')) {
      showError(avatarError, 'Выберите изображение: PNG, JPEG, WebP или GIF');
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      showError(avatarError, `Файл больше ${MAX_UPLOAD_MB} МБ`);
      return;
    }
    const oldLabel = uploadBtn.textContent;
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Загрузка…';
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('kind', AssetKinds.forUsage('avatar'));
      fd.append('name', 'Аватар ' + (nameInput.value.trim() || me.name || ''));
      const asset = await API.upload('/api/assets', fd);
      setAvatar(asset.id);
      toast('Аватар загружен — нажмите «Сохранить»');
    } catch (e) {
      showError(avatarError, e.message || 'Не удалось загрузить файл');
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = oldLabel;
    }
  });

  async function openLibrary() {
    clearError(avatarError);
    let assets;
    try {
      assets = await API.get('/api/assets?kind=portrait');
    } catch (e) {
      showError(avatarError, e.message || 'Не удалось открыть библиотеку');
      return;
    }
    let chosen = avatarDraft;
    const grid = el('div', { class: 'profile-asset-grid', role: 'group', 'aria-label': 'Портреты из библиотеки' });
    if (!assets.length) {
      grid.append(el('p', { class: 'muted' }, 'В библиотеке нет портретов. Загрузите файл или добавьте портрет в ', el('a', { href: '/library' }, 'библиотеке'), '.'));
    }
    for (const a of assets) {
      const thumb = el('span', { class: 'profile-asset-img' }, icon('image'));
      assetURL(a.id).then(url => { if (thumb.isConnected) thumb.replaceChildren(el('img', { src: url, alt: '' })); }).catch(() => {});
      const btn = el('button', {
        type: 'button',
        class: 'profile-asset' + (a.id === chosen ? ' selected' : ''),
        'aria-pressed': a.id === chosen ? 'true' : 'false',
        title: a.name || 'Портрет',
      }, thumb, el('span', { class: 'profile-asset-name' }, a.name || 'Портрет'));
      btn.addEventListener('click', () => {
        chosen = a.id;
        for (const item of grid.querySelectorAll('.profile-asset')) {
          item.classList.toggle('selected', item === btn);
          item.setAttribute('aria-pressed', item === btn ? 'true' : 'false');
        }
      });
      grid.append(btn);
    }
    const buttons = assets.length ? [{ label: 'Выбрать', cls: 'primary', fn: () => chosen || false }] : [];
    const picked = await modal('Аватар из библиотеки', grid, buttons);
    if (picked) {
      setAvatar(picked);
      toast('Аватар выбран — нажмите «Сохранить»');
    }
  }

  const mainForm = el('form', { id: 'profile-main-form', class: 'card profile-block', 'aria-labelledby': 'profile-main-title', novalidate: '' },
    blockHead('profile-main-title', 'Основное', dirtyBadge),
    el('p', { class: 'muted small profile-desc' }, 'Имя и аватар видят другие игроки. Изменения применяются только после нажатия «Сохранить».'),
    el('div', { class: 'profile-form-grid' },
      field('Имя', nameInput, nameHelp, nameError, 'full'),
      el('div', { class: 'profile-field full profile-avatar-editor', role: 'group', 'aria-labelledby': 'profile-avatar-label' },
        el('span', { class: 'profile-label', id: 'profile-avatar-label' }, 'Аватар'),
        el('div', { class: 'profile-avatar-row' },
          avatarPreview,
          el('div', { class: 'profile-avatar-actions' },
            el('div', { class: 'profile-actions' }, uploadBtn, libraryBtn, removeAvatarBtn),
            avatarNote,
            avatarError,
            fileInput)))),
    el('div', { class: 'profile-actions' }, saveBtn, cancelBtn));

  mainForm.addEventListener('submit', async e => {
    e.preventDefault();
    clearError(nameError);
    const name = nameInput.value.trim();
    const localError = nameRule(name);
    if (localError) {
      showError(nameError, localError);
      nameInput.setAttribute('aria-invalid', 'true');
      nameInput.focus();
      return;
    }
    if (!isDirty() || busy) return;
    setBusy(true);
    try {
      const r = await API.patch('/api/auth/me', { name, avatar_asset_id: avatarDraft });
      saved.name = (r.name ?? name).trim();
      saved.avatar = r.avatar_asset_id !== undefined ? (r.avatar_asset_id || null) : avatarDraft;
      me.name = saved.name;
      me.avatar_asset_id = saved.avatar;
      nameInput.value = saved.name;
      heroName.textContent = saved.name;
      topbarUserLink.textContent = saved.name;
      paintAvatar(heroAvatar, saved.avatar, saved.name);
      paintDraftAvatar();
      toast('Профиль сохранён');
    } catch (err) {
      showError(nameError, err.message || 'Не удалось сохранить профиль');
    } finally {
      setBusy(false);
    }
  });

  // ---------- «Почта» ----------
  const emailCurrent = el('p', { class: 'profile-current' },
    el('span', { class: 'muted small' }, 'Текущая почта: '), el('b', {}, me.email));
  const emailNew = el('input', {
    id: 'profile-email-new', type: 'email', autocomplete: 'email', placeholder: 'new@example.com',
    required: '', 'aria-describedby': 'profile-email-help profile-email-error',
  });
  const emailHelp = el('p', { class: 'muted small', id: 'profile-email-help' }, 'На новый адрес придёт код подтверждения. Пока код не введён, почта не меняется.');
  const emailPassword = el('input', {
    id: 'profile-email-password', type: 'password', autocomplete: 'current-password',
    'aria-describedby': 'profile-email-password-help',
  });
  const emailPasswordHelp = el('p', { class: 'muted small', id: 'profile-email-password-help' }, 'Текущий пароль нужен, чтобы подтвердить смену почты.');
  const emailPasswordField = field('Текущий пароль', emailPassword, emailPasswordHelp, null);
  emailPasswordField.hidden = !me.has_password;
  const emailError = errorNode('profile-email-error');
  const emailCode = el('input', {
    id: 'profile-email-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
    maxlength: '8', placeholder: '123456', 'aria-describedby': 'profile-email-code-info profile-email-code-error',
  });
  const emailCodeInfo = el('p', { class: 'profile-code-info', id: 'profile-email-code-info', role: 'status', 'aria-live': 'polite' });
  const emailCodeError = errorNode('profile-email-code-error');
  const emailSend = el('button', { type: 'submit', class: 'primary', id: 'profile-email-send' }, 'Изменить почту');
  const emailConfirm = el('button', { type: 'submit', class: 'primary', id: 'profile-email-confirm' }, 'Подтвердить почту');
  const emailResend = el('button', { type: 'button', class: 'small', id: 'profile-email-resend' }, 'Отправить код ещё раз');
  const emailCancel = el('button', { type: 'button', class: 'small', id: 'profile-email-cancel' }, 'Отмена');
  const emailCodeBox = el('div', { class: 'profile-code-box', id: 'profile-email-code-box', hidden: '' },
    field('Код из письма', emailCode, emailCodeInfo, emailCodeError),
    el('div', { class: 'profile-actions' }, emailConfirm, emailResend, emailCancel));
  let pendingEmail = null;

  function setEmailStage(email) {
    pendingEmail = email || null;
    const active = !!email;
    emailCodeBox.hidden = !active;
    emailSend.hidden = active;
    emailNew.readOnly = active;
    // Пароль не блокируем: если сервер отклонит его, пользователь исправит и повторит
    // подтверждение, не отменяя уже отправленный код.
    emailPassword.disabled = false;
    if (active) {
      emailCode.value = '';
      emailCodeInfo.textContent = `Код отправлен на ${email}. Проверьте почту и папку «Спам».`;
      emailCode.focus();
    }
  }
  function resetEmailStage() {
    setEmailStage(null);
    emailNew.readOnly = false;
    emailPassword.disabled = false;
    emailSend.hidden = false;
    emailCode.value = '';
    clearError(emailError);
    clearError(emailCodeError);
  }
  async function sendEmailCode() {
    clearError(emailError);
    clearError(emailCodeError);
    const email = emailNew.value.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      showError(emailError, 'Введите корректную почту, например name@example.com');
      emailNew.focus();
      return;
    }
    if (email === (me.email || '').toLowerCase()) {
      showError(emailError, 'Это уже ваша почта');
      emailNew.focus();
      return;
    }
    if (me.has_password && !emailPassword.value) {
      showError(emailError, 'Введите текущий пароль');
      emailPassword.focus();
      return;
    }
    emailSend.disabled = true;
    try {
      const r = await API.post('/api/auth/change-email/request-code', { email });
      setEmailStage(email);
      emailCodeInfo.textContent = r.sent
        ? `Код отправлен на ${email}. Проверьте почту и папку «Спам».`
        : 'Почтовый сервер не настроен — код показан ниже (режим разработки).';
      if (r.dev_code) emailCode.value = r.dev_code;
      toast('Код отправлен на ' + email);
    } catch (e) {
      showError(emailError, e.message || 'Не удалось отправить код');
    } finally {
      emailSend.disabled = false;
    }
  }
  async function confirmEmail() {
    if (!pendingEmail) { await sendEmailCode(); return; }
    clearError(emailError);
    clearError(emailCodeError);
    const code = emailCode.value.trim();
    if (!code) {
      showError(emailCodeError, 'Введите код из письма');
      emailCode.focus();
      return;
    }
    emailConfirm.disabled = true;
    emailResend.disabled = true;
    try {
      const body = { email: pendingEmail, code };
      if (me.has_password) body.password = emailPassword.value;
      const r = await API.post('/api/auth/change-email', body);
      me.email = r.email || pendingEmail;
      heroEmail.textContent = me.email;
      emailCurrent.querySelector('b').textContent = me.email;
      deleteEmail.placeholder = me.email;
      deleteEmail.value = '';
      updateDeleteState();
      resetEmailStage();
      emailNew.value = '';
      emailPassword.value = '';
      toast('Почта изменена');
    } catch (e) {
      showError(emailCodeError, e.message || 'Не удалось изменить почту');
    } finally {
      emailConfirm.disabled = false;
      emailResend.disabled = false;
    }
  }
  emailSend.addEventListener('click', e => { e.preventDefault(); sendEmailCode(); });
  emailConfirm.addEventListener('click', e => { e.preventDefault(); confirmEmail(); });
  emailResend.addEventListener('click', async () => {
    if (!pendingEmail) return;
    emailResend.disabled = true;
    try {
      const r = await API.post('/api/auth/change-email/request-code', { email: pendingEmail });
      emailCodeInfo.textContent = r.sent
        ? `Код отправлен на ${pendingEmail}. Проверьте почту и папку «Спам».`
        : 'Почтовый сервер не настроен — код показан ниже (режим разработки).';
      if (r.dev_code) emailCode.value = r.dev_code;
      clearError(emailCodeError);
      toast('Код отправлен повторно');
    } catch (e) {
      showError(emailCodeError, e.message || 'Не удалось отправить код');
    } finally {
      emailResend.disabled = false;
    }
  });
  emailCancel.addEventListener('click', () => { resetEmailStage(); emailNew.focus(); });
  const emailForm = el('form', { id: 'profile-email-form', class: 'card profile-block', 'aria-labelledby': 'profile-email-title', novalidate: '' },
    blockHead('profile-email-title', 'Почта'),
    el('p', { class: 'muted small profile-desc' }, 'Почта — логин и адрес для кодов входа и восстановления пароля. Смена подтверждается кодом на новый адрес; занятые адреса отклоняются.'),
    emailCurrent,
    el('div', { class: 'profile-form-grid' },
      field('Новая почта', emailNew, emailHelp, null, 'full'),
      emailPasswordField),
    el('div', { class: 'profile-actions' }, emailSend),
    emailError,
    emailCodeBox);
  emailForm.addEventListener('submit', e => { e.preventDefault(); pendingEmail ? confirmEmail() : sendEmailCode(); });

  // ---------- «Пароль» ----------
  const oldPw = el('input', { id: 'profile-old-password', type: 'password', autocomplete: 'current-password', 'aria-describedby': 'profile-password-help' });
  const oldPwField = field('Текущий пароль', oldPw, null, null);
  oldPwField.hidden = !me.has_password;
  const newPw = el('input', { id: 'profile-new-password', type: 'password', autocomplete: 'new-password', placeholder: `минимум ${PW_MIN} символов`, 'aria-describedby': 'profile-password-help' });
  const repeatPw = el('input', { id: 'profile-password-repeat', type: 'password', autocomplete: 'new-password' });
  const passwordHelp = el('p', { class: 'muted small', id: 'profile-password-help' }, `Минимум ${PW_MIN} символов. После смены остальные устройства выйдут из аккаунта; текущая сессия останется.`);
  const passwordError = errorNode('profile-password-error');
  const passwordSave = el('button', { type: 'submit', class: 'primary', id: 'profile-password-save' }, 'Изменить пароль');
  const passwordForm = el('form', { id: 'profile-password-form', class: 'card profile-block', 'aria-labelledby': 'profile-password-title', novalidate: '' },
    blockHead('profile-password-title', 'Пароль'),
    el('p', { class: 'muted small profile-desc' }, me.has_password ? 'Для смены нужен текущий пароль — так чужой вход с украденной сессией не сменит пароль.' : 'У аккаунта пока нет пароля: задайте его, и вход по паролю станет доступен.'),
    el('div', { class: 'profile-form-grid' },
      oldPwField,
      field('Новый пароль', newPw, passwordHelp, null, 'full'),
      field('Повторите новый пароль', repeatPw, null, null, 'full')),
    passwordError,
    el('div', { class: 'profile-actions' }, passwordSave));

  passwordForm.addEventListener('submit', async e => {
    e.preventDefault();
    clearError(passwordError);
    const oldValue = oldPw.value;
    const value = newPw.value;
    const repeat = repeatPw.value;
    const len = Array.from(value).length;
    if (me.has_password && !oldValue) { showError(passwordError, 'Введите текущий пароль'); oldPw.focus(); return; }
    if (!len) { showError(passwordError, 'Введите новый пароль'); newPw.focus(); return; }
    if (len < PW_MIN) { showError(passwordError, `Пароль должен быть не короче ${PW_MIN} символов (сейчас ${len})`); newPw.focus(); return; }
    if (value !== repeat) { showError(passwordError, 'Пароли не совпадают'); repeatPw.focus(); return; }
    passwordSave.disabled = true;
    try {
      await API.post('/api/auth/change-password', { old_password: oldValue, password: value });
      me.has_password = true;
      oldPwField.hidden = false;
      emailPasswordField.hidden = false;
      oldPw.value = newPw.value = repeatPw.value = '';
      toast('Пароль изменён. Остальные устройства вышли из аккаунта.');
    } catch (e) {
      showError(passwordError, e.message || 'Не удалось изменить пароль');
    } finally {
      passwordSave.disabled = false;
    }
  });

  // ---------- «Аккаунт» ----------
  const logoutBtn = el('button', { type: 'button', id: 'profile-logout' }, 'Выйти');
  const logoutAllBtn = el('button', { type: 'button', id: 'profile-logout-all' }, 'Выйти на всех устройствах');
  const cookieBtn = el('button', { type: 'button', class: 'small', id: 'profile-cookie-settings' }, 'Настройки cookie');
  const deleteEmail = el('input', { id: 'profile-delete-email', type: 'email', autocomplete: 'off', placeholder: me.email, 'aria-describedby': 'profile-delete-help profile-delete-error' });
  const deleteHelp = el('p', { class: 'muted small', id: 'profile-delete-help' }, 'Введите текущую почту, чтобы подтвердить удаление. Действие необратимо.');
  const deleteBtn = el('button', { type: 'button', class: 'danger', id: 'profile-delete-btn', disabled: '' }, 'Удалить аккаунт');
  const deleteError = errorNode('profile-delete-error');
  function updateDeleteState() {
    deleteBtn.disabled = deleteEmail.value.trim().toLowerCase() !== (me.email || '').toLowerCase();
  }
  deleteEmail.addEventListener('input', () => { clearError(deleteError); updateDeleteState(); });
  logoutBtn.addEventListener('click', async () => {
    try {
      await API.post('/api/auth/logout');
      LS.removeItem('dnd_token');
      go('/');
    } catch (e) {
      toast(e.message || 'Не удалось выйти', 3500);
    }
  });
  logoutAllBtn.addEventListener('click', async () => {
    const yes = await modal('Выйти на всех устройствах?',
      el('p', {}, 'Все сессии, включая текущую, будут завершены. Чтобы вернуться, войдите снова.'),
      [{ label: 'Выйти везде', cls: 'danger', fn: () => true }]);
    if (!yes) return;
    try {
      await API.post('/api/auth/logout-all');
      LS.removeItem('dnd_token');
      go('/');
    } catch (e) {
      toast(e.message || 'Не удалось завершить сессии', 3500);
    }
  });
  cookieBtn.addEventListener('click', () => Consent.settings());
  deleteBtn.addEventListener('click', async () => {
    clearError(deleteError);
    const email = deleteEmail.value.trim().toLowerCase();
    if (email !== (me.email || '').toLowerCase()) return;
    const yes = await modal('Удалить аккаунт?',
      el('div', {},
        el('p', {}, 'Будут удалены аккаунт, ваши кампании (вместе со сценами, приглашениями и чатом), созданные вами персонажи, наборы и загруженные изображения.'),
        el('p', { class: 'muted small' }, 'Это действие необратимо. Ваши кампании с другими игроками тоже будут удалены; их персонажи сохранятся, но потеряют привязку к кампании.')),
      [{ label: 'Удалить навсегда', cls: 'danger', fn: () => true }]);
    if (!yes) return;
    deleteBtn.disabled = true;
    try {
      await API.req('DELETE', '/api/auth/me', { email });
      LS.removeItem('dnd_token');
      go('/');
    } catch (e) {
      showError(deleteError, e.message || 'Не удалось удалить аккаунт');
      updateDeleteState();
    }
  });

  const accountForm = el('section', { class: 'card profile-block', id: 'profile-account', 'aria-labelledby': 'profile-account-title' },
    blockHead('profile-account-title', 'Аккаунт'),
    el('p', { class: 'muted small profile-desc' }, 'Сессии и удаление аккаунта. Смена пароля уже завершает остальные сессии; «Выйти на всех устройствах» завершает все, включая эту.'),
    el('div', { class: 'profile-actions' }, logoutBtn, logoutAllBtn, cookieBtn),
    el('hr', { class: 'profile-rule' }),
    el('div', { class: 'profile-danger' },
      el('h3', {}, 'Опасная зона'),
      el('p', { class: 'muted small' }, 'Удаление аккаунта необратимо. Root-аккаунт нельзя удалить, если он единственный администратор сервера.'),
      field('Подтвердите почту', deleteEmail, deleteHelp, deleteError),
      el('div', { class: 'profile-actions' }, deleteBtn)));

  page.append(mainForm, emailForm, passwordForm, accountForm);

  paintDraftAvatar();
  updateDirty();
  updateDeleteState();

  // Предупреждение о несохранённых изменениях при уходе со страницы.
  window.addEventListener('beforeunload', e => {
    if (!isDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });
})();
