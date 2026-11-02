// Браузерный тест страницы профиля (/profile): шапка, имя с dirty-индикатором,
// аватар из библиотеки и загрузкой, смена почты по коду, смена пароля,
// удаление аккаунта и «выйти на всех устройствах». HTTP API подменяется через
// page.route, сервер не нужен; статика читается из static/.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

// 1x1 прозрачный PNG — достаточно, чтобы assetURL собрал Blob и <img> загрузился.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HOST = 'https://profile.test';

function json(route, data, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
}

async function openPage(browser, state) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.route(HOST + '/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    const body = (() => {
      try { return request.postDataJSON(); } catch { return null; }
    })();

    if (pathname.startsWith('/static/')) {
      const type = pathname.endsWith('.css') ? 'text/css' : 'text/javascript';
      return route.fulfill({ contentType: type, body: fs.readFileSync(path.join(process.cwd(), pathname)) });
    }

    if (!pathname.startsWith('/api/')) {
      return route.fulfill({ contentType: 'text/html', body: fs.readFileSync('static/profile.html') });
    }

    requests.push({ method, pathname, body, raw: request.postDataBuffer() });

    if (pathname === '/api/auth/me' && method === 'GET') {
      if (state.loggedOut) return json(route, { detail: 'Требуется вход' }, 401);
      return json(route, state.me);
    }
    if (pathname === '/api/auth/me' && method === 'PATCH') {
      const name = String(body?.name ?? '').trim();
      if (!name) return json(route, { detail: 'Имя не может быть пустым' }, 400);
      if (Array.from(name).length > 64) return json(route, { detail: 'Имя слишком длинное' }, 400);
      state.me.name = name;
      if ('avatar_asset_id' in (body || {})) state.me.avatar_asset_id = body.avatar_asset_id;
      return json(route, { ok: true, name: state.me.name, avatar_asset_id: state.me.avatar_asset_id });
    }
    if (pathname === '/api/auth/me' && method === 'DELETE') {
      if (String(body?.email || '').toLowerCase() !== state.me.email.toLowerCase()) {
        return json(route, { detail: 'Введите почту аккаунта, чтобы подтвердить удаление' }, 400);
      }
      state.deleted = true;
      return json(route, { ok: true });
    }
    if (pathname === '/api/auth/settings') {
      return json(route, { allow_registration: true, password_min_length: 8, code_ttl_minutes: 10, max_upload_mb: 25 });
    }
    if (pathname === '/api/auth/change-email/request-code' && method === 'POST') {
      const email = String(body?.email || '').toLowerCase();
      if (email === 'taken@test.ru') return json(route, { detail: 'Эта почта уже занята другим аккаунтом' }, 400);
      if (email === state.me.email.toLowerCase()) return json(route, { detail: 'Это уже ваша почта' }, 400);
      state.pendingEmail = email;
      return json(route, { ok: true, sent: false, dev_code: '123456', ttl_min: 10, email });
    }
    if (pathname === '/api/auth/change-email' && method === 'POST') {
      if (String(body?.code || '') !== '123456') return json(route, { detail: 'Неверный код' }, 400);
      if (state.me.has_password && String(body?.password || '') !== state.password) {
        return json(route, { detail: 'Неверный текущий пароль' }, 400);
      }
      state.me.email = String(body?.email || '').toLowerCase();
      return json(route, { ok: true, email: state.me.email });
    }
    if (pathname === '/api/auth/change-password' && method === 'POST') {
      if (state.me.has_password && String(body?.old_password || '') !== state.password) {
        return json(route, { detail: 'Старый пароль неверен' }, 400);
      }
      if (Array.from(String(body?.password || '')).length < 8) {
        return json(route, { detail: 'Пароль должен быть не короче 8 символов' }, 400);
      }
      state.password = String(body.password);
      state.me.has_password = true;
      return json(route, { ok: true });
    }
    if (pathname === '/api/auth/logout-all' && method === 'POST') {
      state.loggedOut = true;
      return json(route, { ok: true });
    }
    if (pathname === '/api/auth/logout' && method === 'POST') {
      state.loggedOut = true;
      return json(route, { ok: true });
    }
    if (pathname === '/api/assets' && method === 'GET') {
      return json(route, [
        { id: 'asset-a', name: 'Ария', kind: 'portrait', mime: 'image/png' },
        { id: 'asset-b', name: 'Ария в плаще', kind: 'portrait', mime: 'image/png' },
      ]);
    }
    if (pathname === '/api/assets' && method === 'POST') {
      return json(route, { id: 'asset-up', name: 'avatar', kind: 'portrait', mime: 'image/png' });
    }
    if (pathname.startsWith('/api/assets/')) {
      return json(route, { id: pathname.split('/').pop(), mime: 'image/png', encoding: 'raw', data_b64: PNG_B64 });
    }
    return json(route, { detail: 'not found' }, 404);
  });

  await page.goto(HOST + '/profile');
  await page.waitForSelector('#profile-title');
  return { page, errors, requests };
}

function waitRequest(page, method, pathname) {
  return page.waitForRequest(r => r.method() === method && new URL(r.url()).pathname === pathname);
}

(async () => {
  const browser = await chromium.launch(await require('./browser-launch.cjs')());
  try {
    const state = {
      me: { id: 'u1', name: 'Ария', email: 'aria@test', is_root: false, avatar_asset_id: null, created_at: '2025-03-04T10:00:00Z', has_password: true },
      password: 'secret123',
      loggedOut: false,
      deleted: false,
      pendingEmail: null,
    };
    const { page, errors, requests } = await openPage(browser, state);

    // ---------- шапка и доступность ----------
    assert.equal(await page.locator('#profile-title').innerText(), 'Ария');
    assert.equal(await page.locator('#profile-email-current').innerText(), 'aria@test');
    assert.equal(await page.locator('.profile-meta .badge.player').innerText(), 'Пользователь');
    assert.equal(await page.locator('.profile-meta time').getAttribute('datetime'), '2025-03-04T10:00:00Z');
    assert.equal(await page.locator('a[aria-current="page"]').getAttribute('href'), '/profile');
    assert.equal(await page.getByLabel('Имя').count(), 1, 'у поля имени есть label');
    assert.equal(await page.locator('#profile-avatar-hero').innerText(), 'А', 'без аватара показывается инициал');
    assert.equal(await page.locator('#profile-dirty').isHidden(), true);
    assert.equal(await page.locator('#profile-save').isDisabled(), true);
    for (const href of ['/campaigns', '/characters', '/compendium']) {
      assert.equal(await page.locator(`.mainnav a[href="${href}"]`).count(), 1, `ссылка ${href}`);
    }

    // ---------- имя: dirty, сохранение, пустое имя ----------
    await page.locator('#profile-name').fill('Ария Новая');
    assert.equal(await page.locator('#profile-dirty').isVisible(), true);
    assert.equal(await page.locator('#profile-save').isEnabled(), true);
    const patched = waitRequest(page, 'PATCH', '/api/auth/me');
    await page.locator('#profile-save').click();
    const patch = await patched;
    assert.deepEqual(patch.postDataJSON(), { name: 'Ария Новая', avatar_asset_id: null });
    await page.locator('.toast', { hasText: 'Профиль сохранён' }).first().waitFor();
    assert.equal(await page.locator('#profile-dirty').isHidden(), true);
    assert.equal(await page.locator('#profile-title').innerText(), 'Ария Новая');

    const beforeInvalid = requests.filter(r => r.method === 'PATCH').length;
    await page.locator('#profile-name').fill('   ');
    await page.locator('#profile-save').click();
    await page.locator('#profile-name-error').waitFor();
    assert.match(await page.locator('#profile-name-error').innerText(), /пустым/);
    assert.equal(requests.filter(r => r.method === 'PATCH').length, beforeInvalid, 'пустое имя не отправляется');
    await page.locator('#profile-cancel').click();
    assert.equal(await page.locator('#profile-name').inputValue(), 'Ария Новая');

    // ---------- аватар: библиотека ----------
    await page.locator('#profile-avatar-library').click();
    await page.locator('.modal').waitFor();
    assert.equal(await page.locator('.profile-asset').count(), 2);
    await page.locator('.profile-asset').nth(1).click();
    assert.equal(await page.locator('.profile-asset').nth(1).getAttribute('aria-pressed'), 'true');
    await page.locator('.modal').getByRole('button', { name: 'Выбрать' }).click();
    await page.locator('.modal-bg').waitFor({ state: 'detached' });
    await page.locator('#profile-avatar-preview img').waitFor();
    assert.equal(await page.locator('#profile-dirty').isVisible(), true);
    const avatarPatch = waitRequest(page, 'PATCH', '/api/auth/me');
    await page.locator('#profile-save').click();
    assert.equal((await avatarPatch).postDataJSON().avatar_asset_id, 'asset-b');
    await page.locator('.toast', { hasText: 'Профиль сохранён' }).first().waitFor();

    // ---------- аватар: загрузка файла ----------
    const uploaded = waitRequest(page, 'POST', '/api/assets');
    await page.setInputFiles('#profile-avatar-file', {
      name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(PNG_B64, 'base64'),
    });
    const uploadRequest = await uploaded;
    assert.match(String(uploadRequest.postDataBuffer()), /portrait/, 'kind=portrait в multipart');
    await page.locator('#profile-avatar-preview img').waitFor();
    assert.equal(await page.locator('#profile-dirty').isVisible(), true);
    const uploadPatch = waitRequest(page, 'PATCH', '/api/auth/me');
    await page.locator('#profile-save').click();
    assert.equal((await uploadPatch).postDataJSON().avatar_asset_id, 'asset-up');
    await page.locator('.toast', { hasText: 'Профиль сохранён' }).first().waitFor();

    // ---------- аватар: убрать ----------
    await page.locator('#profile-avatar-remove').click();
    const removePatch = waitRequest(page, 'PATCH', '/api/auth/me');
    await page.locator('#profile-save').click();
    assert.equal((await removePatch).postDataJSON().avatar_asset_id, null);
    await page.locator('.toast', { hasText: 'Профиль сохранён' }).first().waitFor();

    // ---------- почта: код обязателен, занятый адрес отклоняется ----------
    await page.locator('#profile-email-new').fill('new@example.com');
    await page.locator('#profile-email-password').fill('secret123');
    const requested = waitRequest(page, 'POST', '/api/auth/change-email/request-code');
    await page.locator('#profile-email-send').click();
    await requested;
    await page.locator('#profile-email-code-box').waitFor();
    assert.equal(await page.locator('#profile-email-code').inputValue(), '123456', 'dev_code подставлен');
    await page.locator('#profile-email-code').fill('000000');
    await page.locator('#profile-email-confirm').click();
    await page.locator('#profile-email-code-error').waitFor();
    assert.match(await page.locator('#profile-email-code-error').innerText(), /Неверный код/);
    assert.equal(await page.locator('#profile-email-current').innerText(), 'aria@test', 'почта не изменилась');

    await page.locator('#profile-email-code').fill('123456');
    const confirmed = waitRequest(page, 'POST', '/api/auth/change-email');
    await page.locator('#profile-email-confirm').click();
    await confirmed;
    await page.locator('#profile-email-current', { hasText: 'new@example.com' }).waitFor();
    assert.equal(await page.locator('#profile-email-code-box').isHidden(), true);
    await page.locator('.toast', { hasText: 'Почта изменена' }).first().waitFor();

    await page.locator('#profile-email-new').fill('taken@test.ru');
    await page.locator('#profile-email-password').fill('secret123');
    await page.locator('#profile-email-send').click();
    await page.locator('#profile-email-error').waitFor();
    assert.match(await page.locator('#profile-email-error').innerText(), /занята/);
    assert.equal(await page.locator('#profile-email-code-box').isHidden(), true);

    // ---------- пароль: старый, повтор и успех ----------
    await page.locator('#profile-old-password').fill('wrong');
    await page.locator('#profile-new-password').fill('newsecret1');
    await page.locator('#profile-password-repeat').fill('newsecret1');
    const badPassword = waitRequest(page, 'POST', '/api/auth/change-password');
    await page.locator('#profile-password-save').click();
    await badPassword;
    await page.locator('#profile-password-error').waitFor();
    assert.match(await page.locator('#profile-password-error').innerText(), /Старый пароль/);

    const requestsBeforeMismatch = requests.filter(r => r.pathname === '/api/auth/change-password').length;
    await page.locator('#profile-old-password').fill('secret123');
    await page.locator('#profile-new-password').fill('newsecret2');
    await page.locator('#profile-password-repeat').fill('newsecret3');
    await page.locator('#profile-password-save').click();
    assert.match(await page.locator('#profile-password-error').innerText(), /не совпадают/);
    assert.equal(requests.filter(r => r.pathname === '/api/auth/change-password').length, requestsBeforeMismatch, 'несовпадающие пароли не отправляются');

    await page.locator('#profile-password-repeat').fill('newsecret2');
    const goodPassword = waitRequest(page, 'POST', '/api/auth/change-password');
    await page.locator('#profile-password-save').click();
    await goodPassword;
    await page.locator('.toast', { hasText: 'Пароль изменён' }).first().waitFor();
    assert.equal(await page.locator('#profile-new-password').inputValue(), '');

    // ---------- аккаунт: удаление и выход на всех устройствах ----------
    // Страница не должна уходить на «/» в тесте — подменяем навигацию.
    await page.evaluate(() => { window.go = url => { window.__went = url; }; });
    assert.equal(await page.locator('#profile-delete-email').inputValue(), '');
    assert.equal(await page.locator('#profile-delete-btn').isDisabled(), true);
    await page.locator('#profile-delete-email').fill('new@example.com');
    assert.equal(await page.locator('#profile-delete-btn').isEnabled(), true);
    await page.locator('#profile-delete-btn').click();
    await page.locator('.modal').waitFor();
    await page.locator('.modal').getByRole('button', { name: 'Отмена' }).click();

    await page.locator('#profile-delete-btn').click();
    const deleted = waitRequest(page, 'DELETE', '/api/auth/me');
    await page.locator('.modal').getByRole('button', { name: 'Удалить навсегда' }).click();
    assert.equal((await deleted).postDataJSON().email, 'new@example.com');
    await page.waitForFunction(() => window.__went === '/');
    assert.equal(state.deleted, true);

    await page.locator('#profile-logout-all').click();
    await page.locator('.modal').waitFor();
    const loggedOutAll = waitRequest(page, 'POST', '/api/auth/logout-all');
    await page.locator('.modal').getByRole('button', { name: 'Выйти везде' }).click();
    await loggedOutAll;
    assert.equal(state.loggedOut, true);

    assert.deepEqual(errors, [], 'нет ошибок JS на странице');
    console.log('profile-page.browser: ok');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
