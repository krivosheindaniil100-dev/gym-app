#!/usr/bin/env node
/**
 * End-to-end "press every button" test for Body Twin (web build of the app).
 *   node e2e/run.cjs [baseUrl] [--shots dir] [--only area]
 * Needs a running dev/preview server (default http://127.0.0.1:5173/).
 * Exit code 1 when any step fails or the page logs an error.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { makeSeed, STORAGE_KEY } = require('./seed.cjs');

const args = process.argv.slice(2);
const BASE = args.find((a) => /^https?:/.test(a)) || 'http://127.0.0.1:5173/';
const shotsDir = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : path.join(__dirname, 'shots');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
fs.mkdirSync(shotsDir, { recursive: true });

const results = [];
const consoleErrors = [];
let page;
let area = '';

async function step(name, fn) {
  const label = `${area} › ${name}`;
  const before = consoleErrors.length;
  try {
    await fn();
    const errs = consoleErrors.slice(before);
    if (errs.length) {
      results.push({ label, ok: false, error: 'console: ' + errs.join(' | ').slice(0, 300) });
      await page.screenshot({ path: path.join(shotsDir, `FAIL-${results.length}.png`) }).catch(() => {});
    } else results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, error: String(e.message || e).split('\n')[0].slice(0, 300) });
    await page.screenshot({ path: path.join(shotsDir, `FAIL-${results.length}.png`) }).catch(() => {});
    // try to recover: close any open sheets
    for (let i = 0; i < 4; i++) {
      const close = page.locator('.sheet button[aria-label="Закрыть"]').last();
      if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
      else break;
      await page.waitForTimeout(150);
    }
  }
}

const expect = (cond, msg) => {
  if (!cond) throw new Error('assert: ' + msg);
};
const state = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}').state, STORAGE_KEY);
const tab = (name) => page.locator('.tab', { hasText: name }).click();
const visibleScreen = () => page.locator('.screen:visible').first();
// screenshots are best-effort: software WebGL can make them very slow on a loaded machine
const shot = (name) => page.screenshot({ path: path.join(shotsDir, name + '.png'), timeout: 120000 }).catch(() => {});
const closeSheet = async () => {
  await page.locator('.sheet button[aria-label="Закрыть"]').last().click();
  await page.waitForTimeout(250);
};
const toastGone = () => page.waitForTimeout(350);
const setRange = (sel, value) =>
  page.evaluate(
    ([s, v]) => {
      const r = document.querySelector(s);
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(r, v === 'min' ? r.min : v === 'max' ? r.max : String(v));
      r.dispatchEvent(new Event('input', { bubbles: true }));
    },
    [sel, value],
  );

async function newPage(browser, seeded, viewport = { width: 400, height: 860 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('console', (m) => {
    if (m.type() === 'error' && !/XNNPACK|favicon|net::ERR_|Failed to load resource/.test(m.text())) consoleErrors.push(m.text().slice(0, 200));
  });
  p.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + e.message.slice(0, 200)));
  if (seeded) await p.addInitScript(([k, s]) => !localStorage.getItem(k) && localStorage.setItem(k, s), [STORAGE_KEY, JSON.stringify(makeSeed())]);
  return p;
}

async function waitModel() {
  await page.waitForSelector('.body-canvas canvas', { timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('.body-loading'), null, { timeout: 60000 });
}

/* ───────────────────────── areas ───────────────────────── */

async function onboarding(browser) {
  area = 'Онбординг';
  page = await newPage(browser, false);
  await page.goto(BASE);
  await step('экран приветствия → Начать', async () => {
    await page.getByText('Твой цифровой двойник').waitFor();
    await page.getByRole('button', { name: /Начать/ }).click();
  });
  await step('профиль: имя, пол, рост, год', async () => {
    await page.getByPlaceholder('Как к тебе обращаться').fill('Тест');
    await page.getByRole('button', { name: 'Женский' }).click();
    await page.getByRole('button', { name: 'Мужской' }).click();
    const nums = page.locator('.onb .input[inputmode="decimal"]');
    await nums.nth(0).fill('181');
    await nums.nth(1).fill('1996');
    await page.getByRole('button', { name: /Далее/ }).click();
  });
  await step('тело: «Далее» заблокирована без данных', async () => {
    expect(await page.getByRole('button', { name: /Далее/ }).isDisabled(), 'next must be disabled without weight');
  });
  await step('тело: режим «По обхватам»', async () => {
    await page.getByPlaceholder('80,0').fill('84,5');
    await page.getByRole('button', { name: 'По обхватам' }).click();
    const f = page.locator('.onb .grid2 .input');
    await f.nth(0).fill('88');
    await f.nth(1).fill('39');
    await page.getByText('Безжировая масса').waitFor();
  });
  await step('тело: режим «Не знаю»', async () => {
    await page.getByRole('button', { name: 'Не знаю' }).click();
    await page.getByText('Безжировая масса').waitFor();
  });
  await step('тело: QR (веб-ввод) заполняет поля', async () => {
    await page.getByRole('button', { name: /Сканировать QR/ }).click();
    await page.locator('.sheet textarea').fill('weight=83.2;pbf=19.4;smm=37.1');
    await page.getByRole('button', { name: 'Готово' }).click();
    await page.waitForTimeout(300);
    expect((await page.getByPlaceholder('80,0').inputValue()).replace(',', '.') === '83.2', 'weight from QR');
    await page.getByRole('button', { name: /Далее/ }).click();
  });
  await step('цель и активность', async () => {
    await page.getByText('Много на ногах').click();
    await page.getByRole('button', { name: 'Набор массы' }).click();
    await page.getByRole('button', { name: 'Сушка' }).click();
    await page.getByRole('button', { name: /Назад/ }).click();
    await page.getByRole('button', { name: /Далее/ }).click();
    await page.getByRole('button', { name: /Далее/ }).click();
  });
  await step('предпочтения в еде → построить модель', async () => {
    await page.getByRole('button', { name: 'Без свинины' }).click();
    await page.getByRole('button', { name: 'Лактоза' }).click();
    await page.getByRole('button', { name: 'Курица / индейка' }).click();
    await page.getByRole('button', { name: 'Да, нужен десерт' }).click();
    await page.getByRole('button', { name: '5', exact: true }).click();
    await page.getByRole('button', { name: 'до 40 мин' }).click();
    await page.getByRole('button', { name: /Построить моё тело/ }).click();
    await waitModel();
    const s = await state();
    expect(s.onboarded && s.measurements.length === 1, 'onboarded with one measurement');
    expect(Math.abs(s.measurements[0].weight - 83.2) < 0.01 && s.measurements[0].source === 'qr', 'measurement stored from QR');
    expect(s.profile.food.diet === 'no_pork' && s.profile.food.mealsPerDay === 5, 'food prefs stored');
  });
  await shot('onboarding-done');
  await page.context().close();
}

async function body(browser) {
  area = 'Тело';
  page = await newPage(browser, true);
  await page.goto(BASE);
  await step('3D-модель загружается', async () => {
    await waitModel();
    await page.waitForTimeout(1200);
    await shot('body');
  });
  await step('виды: спереди / сбоку / сзади / лицо', async () => {
    for (const n of ['Сбоку', 'Сзади', 'Спереди']) {
      await page.locator('.hero-tools button', { hasText: n }).click();
      await page.waitForTimeout(500);
    }
    await page.getByRole('button', { name: 'Лицо' }).click();
    await page.waitForTimeout(1200);
    await shot('body-face');
    await page.locator('.hero-tools button', { hasText: 'Спереди' }).click();
    await page.waitForTimeout(900);
  });
  await step('обхваты и контур сравнения', async () => {
    await page.getByRole('button', { name: 'Обхваты' }).click();
    await page.waitForTimeout(600);
    expect((await page.locator('.ring-label:visible').count()) >= 5, 'girth labels visible');
    await page.getByRole('button', { name: 'Сравнить' }).click();
    await page.waitForTimeout(1500);
    await shot('body-rings-ghost');
    await page.getByRole('button', { name: 'Обхваты' }).click();
    await page.getByRole('button', { name: 'Сравнить' }).click();
  });
  await step('машина времени: прошлое → прогноз → сейчас', async () => {
    await setRange('input.range', 'min');
    await page.locator('.live-pill', { hasText: 'ИСТОРИЯ' }).waitFor();
    await page.waitForTimeout(1200);
    await setRange('input.range', 'max');
    await page.locator('.live-pill', { hasText: 'ПРОГНОЗ' }).waitFor();
    await page.waitForTimeout(1200);
    await page.locator('.timeline-date .badge', { hasText: 'сейчас' }).click();
    await page.locator('.live-pill', { hasText: 'LIVE' }).waitFor();
  });
  await step('QR → лист замера → сохранить', async () => {
    const n0 = (await state()).measurements.length;
    await page.getByRole('button', { name: 'Сканировать QR' }).click();
    await page.locator('.sheet textarea').fill('{"Weight":"86,9","PBF":"21.8","SMM":"38.3","VFL":"8"}');
    await page.getByRole('button', { name: 'Готово' }).click();
    await page.locator('.sheet-title', { hasText: 'Данные из QR' }).waitFor();
    await page.locator('.sheet').getByText('Масса жира').waitFor();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await toastGone();
    const s = await state();
    expect(s.measurements.length === n0 + 1, 'measurement added');
    const m = s.measurements[s.measurements.length - 1];
    expect(Math.abs(m.weight - 86.9) < 0.01 && Math.abs(m.fatPct - 21.8) < 0.01 && m.visceral === 8, 'QR JSON parsed');
  });
  await step('QR: только ссылка → подсказка', async () => {
    await page.getByRole('button', { name: 'Сканировать QR' }).click();
    await page.locator('.sheet textarea').fill('https://cloud.example.com/r/ABC123');
    await page.getByRole('button', { name: 'Готово' }).click();
    await page.getByText(/только ссылку/).waitFor();
    await page.waitForTimeout(200);
    expect(await page.getByRole('button', { name: 'Сохранить' }).isDisabled(), 'save disabled without numbers');
    await closeSheet();
  });
  await step('QR: набор чисел → сопоставление', async () => {
    await page.getByRole('button', { name: 'Сканировать QR' }).click();
    await page.locator('.sheet textarea').fill('20261110;86.5;21.5;38.4');
    await page.getByRole('button', { name: 'Готово' }).click();
    await page.getByText('Сопоставьте числа из кода').waitFor();
    await page.locator('.sheet .chip', { hasText: '86.5' }).click();
    await page.locator('.sheet .chip', { hasText: 'Вес, кг' }).click();
    await page.locator('.sheet .chip', { hasText: '21.5' }).click();
    await page.locator('.sheet .chip', { hasText: 'Жир, %' }).click();
    await page.locator('.sheet').getByText('Масса жира').waitFor();
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await toastGone();
    expect(Object.keys((await state()).qrLearned).length === 1, 'mapping learned');
  });
  await step('замер вручную', async () => {
    await visibleScreen().evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.getByRole('button', { name: '+ вручную' }).click();
    await page.locator('.sheet-title', { hasText: 'Новый замер' }).waitFor();
    await page.locator('.sheet .input[placeholder="80,5"]').fill('86,2');
    await page.locator('.sheet .input[placeholder="18,5"]').fill('21,2');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await toastGone();
    await visibleScreen().evaluate((el) => el.scrollTo(0, 0));
  });
  await step('аватар: зоны жира, тип фигуры', async () => {
    await page.getByRole('button', { name: 'Мой аватар' }).click();
    await page.getByText('Где у тебя больше всего жира').waitFor();
    await page.locator('.sheet .row.between', { hasText: 'Ягодицы' }).getByText('много').click();
    await page.locator('.sheet .row.between', { hasText: 'Живот' }).getByText('мало').click();
    await page.locator('.sheet .pick').first().click();
    await page.waitForTimeout(300);
    const a = (await state()).profile.avatar;
    expect(a.pattern.glutes > 1.5 && a.pattern.belly < 1, 'pattern stored');
    expect(Object.keys(a.shape).length === 1, 'shape stored');
  });
  await step('аватар: замеры рулеткой', async () => {
    await page.locator('.sheet .seg button', { hasText: 'Замеры' }).click();
    const f = page.locator('.sheet .field .input');
    await f.nth(2).fill('91');
    await page.getByRole('button', { name: 'Применить' }).click();
    await toastGone();
    expect((await state()).profile.avatar.girths.waist.cm === 91, 'waist tape stored');
    await page.getByRole('button', { name: 'Сбросить' }).click();
    await toastGone();
    expect(Object.keys((await state()).profile.avatar.girths).length === 0, 'tape reset');
  });
  await step('аватар: внешность', async () => {
    await page.locator('.sheet .seg button', { hasText: 'Внешность' }).click();
    const sw = page.locator('.sheet button[aria-label^="#"]');
    await sw.nth(1).click();
    await sw.nth(8).click();
    await sw.nth(14).click();
    for (const n of ['Под машинку', 'Без волос', 'Короткие', 'Азиат.', 'Африк.', 'Смешан.', 'Европ.']) await page.locator('.sheet .seg button', { hasText: n }).click();
    await closeSheet();
    await page.waitForTimeout(1200);
  });
  await step('аватар: листы «По фото» и «Лицо по селфи» открываются', async () => {
    await page.getByRole('button', { name: 'Мой аватар' }).click();
    await page.locator('.sheet .btn', { hasText: 'По фото' }).click();
    await page.getByText('Подгонка по фото').waitFor();
    await closeSheet();
    await page.getByRole('button', { name: 'Мой аватар' }).click();
    await page.locator('.sheet .btn', { hasText: 'Лицо по селфи' }).click();
    await page.getByText('Лицо по селфи').first().waitFor();
    await closeSheet();
  });
  await step('настройки: профиль, цель, режим расхода, автокоррекция', async () => {
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByText('Как считать расход').waitFor();
    for (const n of ['Шаги', 'Часы', 'Образ жизни']) await page.locator('.sheet .seg button', { hasText: n }).click();
    await page.locator('.sheet .pick', { hasText: 'Много на ногах' }).click();
    await page.locator('.sheet .toggle').first().click();
    const s = await state();
    expect(s.profile.activityFactor === 1.5 && s.profile.calibrate === true, 'settings stored');
    await page.locator('.sheet .toggle').first().click();
  });
  await step('настройки: экспорт резервной копии', async () => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.locator('.sheet .btn', { hasText: 'Экспорт' }).click()]);
    const p = await dl.path();
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(data.app === 'BodyTwin' && Array.isArray(data.measurements), 'backup content');
    fs.copyFileSync(p, path.join(shotsDir, 'backup.json'));
  });
  await step('настройки: импорт мусора отклоняется, импорт копии работает', async () => {
    const bad = path.join(shotsDir, 'bad.json');
    fs.writeFileSync(bad, '{"hello":1}');
    await page.locator('.sheet input[type=file]').setInputFiles(bad);
    await page.getByText(/Ошибка/).waitFor();
    await toastGone();
    page.once('dialog', (d) => d.accept());
    await page.locator('.sheet input[type=file]').setInputFiles(path.join(shotsDir, 'backup.json'));
    await page.getByText('Данные восстановлены').waitFor();
    await waitModel();
  });
  await page.context().close();
}

async function nutrition(browser) {
  area = 'Питание';
  page = await newPage(browser, true);
  await page.goto(BASE);
  await waitModel();
  await tab('Питание');
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await step('поиск продукта → граммы с клавиатуры → добавить', async () => {
    await visibleScreen().locator('.add-line').first().click();
    await page.getByPlaceholder(/Поиск/).fill('гречка');
    await page.locator('.sheet .item', { hasText: 'Гречка (сухая)' }).click();
    await page.locator('.big-input').fill('185');
    await page.getByText('579').first().waitFor(); // 313 × 1.85
    await page.locator('.sheet-foot .btn.primary').click();
    await toastGone();
    const e = (await state()).food[today];
    expect(e && e.length === 1 && e[0].grams === 185 && e[0].per100.kcal === 313, 'entry stored with typed grams');
  });
  await step('единицы: «шт» считает количество', async () => {
    await visibleScreen().locator('.add-line').first().click();
    await page.getByPlaceholder(/Поиск/).fill('яйцо куриное');
    await page.locator('.sheet .item').first().click();
    const chip = page.locator('.sheet .chip', { hasText: 'шт' }).first();
    await page.waitForTimeout(450); // sheet slide-in
    await chip.click();
    await page.locator('.sheet .chip', { hasText: '1 × шт' }).waitFor();
    await chip.click();
    await page.locator('.sheet .chip', { hasText: '2 × шт' }).waitFor();
    expect((await page.locator('.big-input').inputValue()) === '110', '2 eggs = 110 g, got ' + (await page.locator('.big-input').inputValue()));
    await page.locator('.sheet .seg button', { hasText: 'Обед' }).click();
    await page.locator('.sheet-foot .btn.primary').click();
    await toastGone();
    const e = (await state()).food[today];
    expect(e.length === 2 && e[1].meal === 'lunch', 'meal switch stored');
  });
  await step('недавние продукты', async () => {
    await visibleScreen().locator('.add-line').nth(2).click();
    await page.locator('.sheet .item', { hasText: 'Гречка (сухая)' }).waitFor();
    await closeSheet();
  });
  await step('изменить и удалить запись', async () => {
    await visibleScreen().locator('.item', { hasText: 'Гречка (сухая)' }).click();
    await page.locator('.big-input').fill('90,5');
    await page.locator('.sheet-foot .btn.primary').click();
    await page.waitForTimeout(250);
    expect((await state()).food[today][0].grams === 90.5, 'grams edited (decimal comma)');
    await visibleScreen().locator('.item', { hasText: 'Яйцо' }).click();
    await page.locator('.sheet-foot .btn.danger').click();
    await page.waitForTimeout(250);
    expect((await state()).food[today].length === 1, 'entry deleted');
  });
  await step('быстрая запись «Только ккал»', async () => {
    await visibleScreen().locator('.add-line').nth(3).click();
    await page.locator('.sheet .btn', { hasText: 'Только ккал' }).click();
    await page.getByPlaceholder('Обед в кафе').fill('Ужин в кафе');
    await page.locator('.sheet .big-input').fill('650');
    await page.locator('.sheet-foot .btn.primary').click();
    await page.waitForTimeout(300);
    const e = (await state()).food[today];
    expect(e.length === 2 && e[1].per100.kcal === 650 && e[1].grams === 100, 'quick kcal stored');
  });
  await step('свой продукт → в «Мои»', async () => {
    await visibleScreen().locator('.add-line').nth(2).click();
    await page.locator('.sheet .btn', { hasText: 'Свой продукт' }).click();
    await page.getByPlaceholder(/Творог/).fill('Батончик тест');
    const f = page.locator('.sheet .grid2 .input');
    await f.nth(0).fill('402');
    await f.nth(1).fill('30');
    await f.nth(2).fill('14');
    await f.nth(3).fill('39');
    await f.nth(5).fill('60');
    await page.locator('.sheet-foot .btn.primary').click();
    await page.locator('.big-input').waitFor();
    expect((await page.locator('.big-input').inputValue()) === '60', 'portion default = unit weight');
    await page.locator('.sheet-foot .btn.primary').click();
    await toastGone();
    expect((await state()).customFoods.length === 1, 'custom food saved');
  });
  await step('штрихкод без сети → создание продукта по этикетке', async () => {
    await page.route('**/world.openfoodfacts.org/**', (r) => r.abort());
    await visibleScreen().locator('.add-line').first().click();
    await page.getByRole('button', { name: 'Сканировать штрихкод' }).click();
    await page.locator('.sheet textarea').fill('4607001234567');
    await page.getByRole('button', { name: 'Готово' }).click();
    await page.getByText('4607001234567').waitFor({ timeout: 15000 });
    await closeSheet();
    if (await page.locator('.sheet').count()) await closeSheet();
    await page.unroute('**/world.openfoodfacts.org/**');
  });
  await step('штрихкод: продукт из Open Food Facts (мок) с порцией', async () => {
    await page.route('**/world.openfoodfacts.org/api/v2/product/**', (r) =>
      r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ status: 1, product: { code: '4600000000017', product_name_ru: 'Йогурт тестовый', brands: 'Бренд', serving_quantity: 125, serving_size: '125 г', nutriments: { 'energy-kcal_100g': 62, proteins_100g: 4.1, fat_100g: 1.5, carbohydrates_100g: 7.9 } } }),
      }),
    );
    await visibleScreen().locator('.add-line').first().click();
    await page.getByRole('button', { name: 'Сканировать штрихкод' }).click();
    await page.locator('.sheet textarea').fill('4600000000017');
    await page.getByRole('button', { name: 'Готово' }).click();
    await page.getByText('Йогурт тестовый').waitFor();
    expect((await page.locator('.big-input').inputValue()) === '125', 'serving prefilled but editable');
    await page.locator('.big-input').fill('200');
    await page.getByText('124').first().waitFor();
    await page.locator('.sheet-foot .btn.primary').click();
    await toastGone();
    await page.unroute('**/world.openfoodfacts.org/api/v2/product/**');
  });
  await step('расход: шаги, часы, активность', async () => {
    await visibleScreen().locator('button.card', { hasText: 'Расход и активность' }).click();
    await page.getByPlaceholder('например 9500').fill('9500');
    await page.getByPlaceholder('из приложения часов').fill('420');
    await page.locator('.sheet select').selectOption('run_10');
    await page.locator('.sheet .grid2 .input').first().fill('30');
    await page.locator('.sheet .btn.primary', { hasText: 'Добавить' }).click();
    await toastGone();
    const a = (await state()).activity[today];
    expect(a.steps === 9500 && a.watchActiveKcal === 420 && a.activities.length === 1 && a.activities[0].kcal > 250, 'activity stored');
    await page.locator('.sheet .item button[aria-label="Удалить"]').click();
    expect((await state()).activity[today].activities.length === 0, 'activity deleted');
    await closeSheet();
  });
  await step('навигация по дням', async () => {
    await page.getByRole('button', { name: 'Предыдущий день' }).click();
    await visibleScreen().getByText('Вчера', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Предыдущий день' }).click();
    await page.getByRole('button', { name: 'Следующий день' }).click();
    await page.getByRole('button', { name: 'Следующий день' }).click();
    await visibleScreen().getByText('Сегодня', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Следующий день' }).isDisabled(), 'no future days');
  });
  await step('расчёт нормы: цель и темп', async () => {
    await visibleScreen().locator('.seg button', { hasText: 'Расчёт нормы' }).click();
    await page.getByText('Как получилось').waitFor();
    await visibleScreen().locator('.chip', { hasText: 'Поддержание' }).click();
    await visibleScreen().locator('.chip', { hasText: 'Сушка' }).click();
    await setRange('.screen:not([style*="none"]) input[type=range]', -0.8);
    await shot('norm');
  });
  await step('что приготовить: блюдо → в дневник', async () => {
    await visibleScreen().locator('.seg button', { hasText: 'Что приготовить' }).click();
    const n0 = (await state()).food[today].length;
    await visibleScreen().locator('button.card').nth(0).click();
    await page.getByText('Как готовить').waitFor();
    await page.locator('.sheet-foot .btn.primary').click();
    await toastGone();
    expect((await state()).food[today].length === n0 + 1, 'recipe added to diary');
  });
  await step('что приготовить: остаток дня / целый день / свои БЖУ', async () => {
    await visibleScreen().locator('.seg button', { hasText: 'Остаток дня' }).click();
    await page.waitForTimeout(300);
    await visibleScreen().locator('.seg button', { hasText: 'Целый день' }).click();
    await page.getByText('Вариант 1').waitFor();
    await page.getByRole('button', { name: /Другие варианты/ }).click();
    await visibleScreen().locator('.card-title .link', { hasText: 'задать БЖУ' }).click();
    await visibleScreen().locator('.grid3 .input').first().fill('150');
    await page.getByText('Вариант 1').waitFor();
    await visibleScreen().locator('.card-title .link', { hasText: 'сбросить' }).click();
    await shot('cook-day');
  });
  await page.context().close();
}

async function training(browser) {
  area = 'Тренировки';
  page = await newPage(browser, true);
  await page.goto(BASE);
  await waitModel();
  await tab('Тренировки');
  await step('анкета → программа', async () => {
    await visibleScreen().getByRole('button', { name: 'Составить программу' }).click();
    for (const n of ['Рекомпозиция', 'Сушка', '2+ года', '6 мес – 2 года', 'Дом + гантели', 'Зал', 'На максимум', 'Нормально', 'Колени', 'Без кардио', 'После силовой']) await page.locator('.sheet button', { hasText: n }).first().click();
    await page.locator('.sheet .seg button', { hasText: /^5$/ }).click();
    await page.locator('.sheet .seg button', { hasText: /^4$/ }).click();
    await page.locator('.sheet .seg button', { hasText: /^75$/ }).click();
    await page.locator('.sheet .chip', { hasText: 'Ягодицы' }).click();
    await page.locator('.sheet-foot .btn.primary').click();
    await toastGone();
    const p = (await state()).plan;
    expect(p && p.days.length === 4 && p.prefs.avoid.includes('knees') && p.prefs.sessionMinutes === 75, 'plan stored');
  });
  await step('день программы: раскрыть, заменить упражнение', async () => {
    const card = visibleScreen().locator('.card', { hasText: 'Верх A' }).last();
    await card.locator('button.row').click();
    const before = (await state()).plan.days[0].exercises[0].exerciseId;
    await card.getByRole('button', { name: 'Заменить' }).first().click();
    await page.locator('.sheet .item').first().click();
    await toastGone();
    expect((await state()).plan.days[0].exercises[0].exerciseId !== before, 'exercise swapped');
  });
  await step('тренировка: подходы, таймер отдыха, +подход, завершить', async () => {
    await visibleScreen().getByRole('button', { name: /Начать этот день/ }).first().click();
    await page.locator('.set-check').first().waitFor();
    const w = page.locator('.set-row .input').first();
    await w.fill('42,5');
    await page.locator('.set-check').first().click();
    await page.locator('.rest-timer').waitFor();
    await page.locator('.rest-timer .btn', { hasText: '+30' }).click();
    await page.getByRole('button', { name: 'Пропустить' }).click();
    await page.locator('.sheet .add-line').first().click();
    await page.locator('.set-check').nth(1).click();
    await page.getByRole('button', { name: 'Пропустить' }).click();
    await page.locator('.sheet-foot .btn.primary').click();
    await toastGone();
    const s = await state();
    expect(s.sessions.length === 1 && s.sessions[0].exercises[0].sets[0].weight === 42.5 && s.sessions[0].exercises[0].sets[0].done, 'session stored');
    expect(!s.activeSession, 'active session cleared');
    const acts = Object.values(s.activity).flatMap((a) => a.activities).filter((a) => a.sessionId === s.sessions[0].id);
    expect(acts.length === 1, 'workout added to expenditure');
  });
  await step('отмена тренировки', async () => {
    await visibleScreen().getByRole('button', { name: /Начать этот день/ }).first().click();
    await page.locator('.set-check').first().waitFor();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Отменить' }).click();
    await page.waitForTimeout(300);
    expect(!(await state()).activeSession, 'session cancelled');
  });
  await step('история: открыть, удалить', async () => {
    await page.getByRole('button', { name: 'История' }).click();
    await page.getByText('История тренировок').waitFor();
    page.once('dialog', (d) => d.accept());
    await page.locator('.sheet .card button[aria-label="Удалить"]').first().click();
    await page.waitForTimeout(300);
    const s = await state();
    expect(s.sessions.length === 0, 'session deleted');
    expect(Object.values(s.activity).flatMap((a) => a.activities).every((a) => a.source !== 'workout' || !a.sessionId), 'workout kcal removed');
    await closeSheet();
  });
  await step('пересоздать программу (дом без железа, 3 дня)', async () => {
    await page.getByRole('button', { name: 'Настроить программу' }).click();
    await page.locator('.sheet button', { hasText: 'Дом без железа' }).click();
    await page.locator('.sheet .seg button', { hasText: /^3$/ }).click();
    await page.locator('.sheet-foot .btn.primary').click();
    await toastGone();
    const p = (await state()).plan;
    expect(p.days.length === 3 && p.prefs.place === 'home_bodyweight', 'plan regenerated');
    await shot('training');
  });
  await page.context().close();
}

async function progress(browser) {
  area = 'Прогресс';
  page = await newPage(browser, true);
  await page.goto(BASE);
  await waitModel();
  await tab('Прогресс');
  await step('метрики и периоды графика', async () => {
    for (const n of ['% жира', 'Жир, кг', 'Мышцы', 'Вес']) await visibleScreen().locator('.seg button', { hasText: n }).click();
    for (const n of ['90 дней', 'Всё время', '30 дней']) await visibleScreen().locator('.seg button', { hasText: n }).click();
    await visibleScreen().locator('svg.chart').first().click({ position: { x: 150, y: 80 } });
    await shot('progress');
  });
  await step('столбик баланса показывает подсказку', async () => {
    const bars = visibleScreen().locator('svg.chart').nth(1);
    await bars.scrollIntoViewIfNeeded();
    await bars.click({ position: { x: 200, y: 60 } });
    await page.getByText(/ккал \(/).first().waitFor();
  });
  await step('замер: изменить и удалить', async () => {
    const n0 = (await state()).measurements.length;
    await visibleScreen().evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await visibleScreen().locator('.item', { hasText: 'мышцы' }).last().click();
    await page.locator('.sheet-title', { hasText: 'Замер' }).waitFor();
    await page.locator('.sheet .input[placeholder="80,5"]').fill('91,5');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await toastGone();
    expect((await state()).measurements[0].weight === 91.5, 'measurement edited');
    await visibleScreen().locator('.item', { hasText: 'мышцы' }).last().click();
    page.once('dialog', (d) => d.accept());
    await page.locator('.sheet-foot .btn.danger').click();
    await page.waitForTimeout(300);
    expect((await state()).measurements.length === n0 - 1, 'measurement deleted');
  });
  await step('добавить замер вручную из «Прогресса»', async () => {
    await visibleScreen().locator('.add-line', { hasText: 'Добавить замер' }).click();
    await page.locator('.sheet .input[placeholder="80,5"]').fill('87');
    await page.locator('.sheet .input[placeholder="18,5"]').fill('22');
    await page.getByRole('button', { name: 'Сохранить' }).click();
    await toastGone();
  });
  await step('настройки открываются из «Прогресса»', async () => {
    await visibleScreen().evaluate((el) => el.scrollTo(0, 0));
    await visibleScreen().getByRole('button', { name: 'Настройки' }).click();
    await page.getByText('Как это считается').waitFor();
    await closeSheet();
  });
  await step('сброс всех данных → онбординг', async () => {
    await visibleScreen().getByRole('button', { name: 'Настройки' }).click();
    page.once('dialog', (d) => d.accept());
    await page.locator('.sheet .btn.danger', { hasText: 'Сбросить всё' }).click();
    await page.getByText('Твой цифровой двойник').waitFor();
  });
  await page.context().close();
}

async function smallScreen(browser) {
  area = 'Экран 360×640';
  page = await newPage(browser, true, { width: 360, height: 640 });
  await page.goto(BASE);
  await step('ничего не вылезает за ширину экрана', async () => {
    await waitModel();
    for (const t of ['Тело', 'Питание', 'Тренировки', 'Прогресс']) {
      await tab(t);
      await page.waitForTimeout(500);
      const over = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('.screen *')) {
          if (!el.offsetParent) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1) && !el.closest('.chips.scroll') && !el.closest('.hero') && !el.closest('.ring-labels')) out.push(el.className + ':' + Math.round(r.right));
        }
        return out.slice(0, 5);
      });
      expect(over.length === 0, `overflow on tab ${t}: ${over.join(', ')}`);
      await shot('small-' + t);
    }
  });
  await page.context().close();
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const areas = { onboarding, body, nutrition, training, progress, small: smallScreen };
  for (const [k, fn] of Object.entries(areas)) {
    if (only && only !== k) continue;
    try {
      await fn(browser);
    } catch (e) {
      results.push({ label: `${k} › (аварийное завершение)`, ok: false, error: String(e.message || e).split('\n')[0] });
    }
  }
  await browser.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.label}${r.ok ? '' : '  — ' + r.error}`);
  console.log(`\n${results.length - failed.length}/${results.length} шагов прошло`);
  process.exit(failed.length ? 1 : 0);
})();
