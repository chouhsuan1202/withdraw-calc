/*
 * 用真的瀏覽器打開 index.html，檢查畫面上的數字、互動與排版。
 * 需要 Playwright（npm i -D playwright 後 npx playwright install chromium）與 python3。
 *   node tests/e2e.js                 跑檢查
 *   node tests/e2e.js --shots <資料夾>  另外存手機版與桌機版截圖
 */
'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const PAGE = process.env.PAGE_URL || ('file://' + path.join(__dirname, '..', 'index.html'));
const shotsIdx = process.argv.indexOf('--shots');
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
const refs = JSON.parse(execFileSync('python3', [path.join(__dirname, 'reference.py'), '--json'], { encoding: 'utf8' }));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try { await fn(); passed++; } catch (e) { failures.push({ name, e }); }
}

async function setVal(page, id, v) {
  await page.evaluate(([id, v]) => {
    const el = document.getElementById(id);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [id, v]);
}
const text = (page, id) => page.$eval('#' + id, el => el.textContent.trim());

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(PAGE);

  /* 1. 每個參考案例：頁面數字要和 Python 算的一樣 */
  const FIXED_WORD = { paused: '暫停提領', between: '看之前的狀態', tooMuch: '領太多了' };
  const SAFE_FIXED = { ok: '安全（穩的範圍內）', warn: '可以（在上限內）', bad: '太多，會斷炊' };
  const SAFE_DYN = { ok: '安全', warn: '要配三條規則才行', bad: '太多，部位會越領越薄' };
  for (const ref of refs) {
    const i = ref.input;
    const tag = JSON.stringify(i);
    await check('固定 ' + tag, async () => {
      await page.click('#tabFixed');
      for (const [id, v] of [['p0', i.p0], ['w', i.w], ['debt', i.debt], ['rate', i.rate], ['s', i.s], ['dynRate', i.dynRate], ['revW', i.revW]]) await setVal(page, id, v);
      assert.equal(await text(page, 'pos'), ref.pos);
      assert.equal(await text(page, 'oMax'), '穩 ' + ref.sweet + ' 萬 · 上限 ' + ref.max + ' 萬');
      assert.equal(await text(page, 'oInt'), ref.interestMonthly + ' 萬');
      assert.equal(await text(page, 'oSafe'), SAFE_FIXED[ref.fixedLevel]);
      const wPct = await text(page, 'wPct');
      assert.ok(wPct.startsWith('本金 ' + ref.withdrawPct + '%'), wPct);
      if (i.debt > 0) assert.ok(wPct.includes('加利息共 ' + ref.fixedTotalPct + '%'), wPct);
      const word = await text(page, 'vWord');
      assert.equal(word, FIXED_WORD[ref.fixedState] || ('照領 ' + Number(i.w).toLocaleString('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' 萬'));
      if (ref.fixedState === 'tooMuch') assert.ok((await text(page, 'vWhy')).includes('降到每月 ' + ref.max + ' 萬以內'));
      const fuse = await text(page, 'fuseLines');
      assert.equal(fuse, '保險絲：跌破 ' + ref.fuseStop + ' 萬暫停，回到 ' + ref.fuseBack + ' 萬恢復');
      if (ref.rev) assert.equal(await text(page, 'revOut'), ref.rev);
    });
    await check('動態 ' + tag, async () => {
      await page.click('#tabDyn');
      assert.equal(await text(page, 'oDyn'), ref.dynMonthly + ' 萬');
      assert.equal(await text(page, 'vWord'), '每月拿 ' + ref.dynMonthly + ' 萬');
      assert.equal(await text(page, 'oSafe'), SAFE_DYN[ref.dynLevel]);
      const dynPct = await text(page, 'dynPct');
      assert.ok(dynPct.startsWith('每月拿 ' + ref.dynStartMonthly + ' 萬'), dynPct);
      if (i.debt > 0) assert.ok(dynPct.includes('加利息共 ' + ref.dynTotalPct + '%'), dynPct);
      /* 百分比顏色要和安不安全那列一致 */
      const [c1, c2] = await page.evaluate(() => [document.getElementById('dynPct').style.color, document.getElementById('oSafe').style.color]);
      assert.equal(c1, c2);
      await page.click('#tabFixed');
    });
  }

  /* 2. 邊界輸入：空白、0、負數 */
  await check('本金空白：提示先填，結果全部是 -', async () => {
    await page.goto(PAGE);
    await setVal(page, 'p0', '');
    assert.equal(await text(page, 'vWord'), '先填起始本金');
    for (const id of ['oFixed', 'oMax', 'oInt', 'oSafe', 'pos']) assert.equal(await text(page, id), '-');
    assert.equal(await page.getAttribute('#p0', 'aria-invalid'), 'true');
    assert.equal(await text(page, 'p0Err'), '請填一個數字');
    /* 反推不依賴本金，仍然要算 */
    assert.equal(await text(page, 'revOut'), '837 到 994 萬');
  });
  await check('本金 0', async () => {
    await setVal(page, 'p0', '0');
    assert.equal(await text(page, 'p0Err'), '要大於 0');
    assert.equal(await text(page, 'vWord'), '先修正上面的數字');
  });
  await check('負數借款：顯示錯誤，不偷偷當成 0', async () => {
    await setVal(page, 'p0', '1000');
    await setVal(page, 'debt', '-100');
    assert.equal(await text(page, 'debtErr'), '不能是負數');
    assert.equal(await page.getAttribute('#debt', 'aria-invalid'), 'true');
    assert.ok((await text(page, 'vWhy')).includes('「借款」不能是負數'));
    assert.equal(await text(page, 'oSafe'), '-');
    assert.equal(await text(page, 'revOut'), '-');
  });
  await check('修好之後錯誤消失', async () => {
    await setVal(page, 'debt', '1000');
    assert.equal(await text(page, 'debtErr'), '');
    assert.equal(await page.getAttribute('#debt', 'aria-invalid'), 'false');
    assert.equal(await text(page, 'vWord'), '照領 3.0 萬');
  });
  await check('利率超過 100%', async () => {
    await setVal(page, 'rate', '150');
    assert.equal(await text(page, 'rateErr'), '不能超過 100');
    await setVal(page, 'rate', '2.76');
  });
  await check('動態模式下的每月想領錯誤不影響結果（欄位隱藏）', async () => {
    await setVal(page, 'w', '-1');
    await page.click('#tabDyn');
    assert.equal(await text(page, 'wErr'), '');
    assert.equal(await text(page, 'vWord'), '每月拿 3.3 萬');
    await page.click('#tabFixed');
    assert.equal(await text(page, 'wErr'), '不能是負數');
    await setVal(page, 'w', '3');
  });
  await check('反推欄位空白', async () => {
    await setVal(page, 'revW', '');
    assert.equal(await text(page, 'revOut'), '先填想領的金額');
    assert.equal(await text(page, 'revWErr'), '');
    await setVal(page, 'revW', '-2');
    assert.equal(await text(page, 'revWErr'), '不能是負數');
    await setVal(page, 'revW', '3');
  });

  /* 3. 鍵盤操作 */
  await check('分頁可用方向鍵切換，網址 hash 跟著變', async () => {
    await page.goto(PAGE);
    await page.focus('#tabFixed');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getAttribute('#tabDyn', 'aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'tabDyn');
    assert.equal(await page.evaluate(() => location.hash), '#dyn');
    assert.equal(await page.getAttribute('#tabDyn', 'tabindex'), '0');
    assert.equal(await page.getAttribute('#tabFixed', 'tabindex'), '-1');
    await page.keyboard.press('Home');
    assert.equal(await page.getAttribute('#tabFixed', 'aria-selected'), 'true');
    assert.equal(await page.evaluate(() => location.hash), '');
  });
  await check('重新整理保留動態模式', async () => {
    await page.goto(PAGE + '#dyn');
    assert.equal(await page.getAttribute('#tabDyn', 'aria-selected'), 'true');
    assert.equal(await page.isVisible('#boxDynRate'), true);
  });
  await check('對話框：Enter 打開、Esc 關閉、焦點回到按鈕', async () => {
    await page.goto(PAGE);
    for (const [btn, dlg] of [['histLink', 'histDlg'], ['modeRuleLink', 'ruleDlg'], ['methodLink', 'methodDlg']]) {
      await page.focus('#' + btn);
      await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(id => document.getElementById(id).open, dlg), true, dlg);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(id => document.getElementById(id).open, dlg), false, dlg);
      assert.equal(await page.evaluate(() => document.activeElement.id), btn);
    }
  });
  await check('規則對話框帶入目前數字', async () => {
    await page.click('#modeRuleLink');
    assert.equal(await text(page, 'ruleMonthly'), '3.0');
    assert.equal(await text(page, 'ruleYearly'), '36.0');
    assert.equal(await text(page, 'ruleReserve'), '60');
    assert.equal(await text(page, 'ruleSweet'), '3.0');
    assert.equal(await text(page, 'ruleMax'), '4.0');
    assert.equal(await text(page, 'ruleSweetPct'), '3.6');
    assert.equal(await text(page, 'ruleMaxPct'), '4.8');
    await page.keyboard.press('Escape');
  });
  await check('滑桿有 aria-valuetext', async () => {
    await setVal(page, 's', '-30');
    assert.equal(await page.getAttribute('#s', 'aria-valuetext'), '-30%');
  });

  /* 4. 排版：375 與 1280 寬、兩種模式、都不能有橫向捲動或被裁切的表格 */
  for (const width of [375, 1280]) {
    for (const m of ['fixed', 'dyn']) {
      await check('排版 ' + width + 'px ' + m, async () => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(PAGE + (m === 'dyn' ? '#dyn' : ''));
        const r = await page.evaluate(() => ({
          doc: document.documentElement.scrollWidth, vw: innerWidth,
          tables: [...document.querySelectorAll('.tbl-wrap')].filter(e => e.offsetParent).map(e => [e.scrollWidth, e.clientWidth])
        }));
        assert.ok(r.doc <= r.vw, '頁面寬 ' + r.doc + ' 超過視窗 ' + r.vw);
        r.tables.forEach(([sw, cw]) => assert.ok(sw <= cw, '表格內容寬 ' + sw + ' 超過 ' + cw));
        if (SHOTS) await page.screenshot({ path: path.join(SHOTS, (width < 500 ? 'mobile' : 'desktop') + '-' + m + '.png'), fullPage: true });
      });
    }
  }
  await check('手機版對話框不超出畫面', async () => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(PAGE + '#dyn');
    await page.click('#modeRuleLink');
    const w = await page.$eval('#ruleDlg', d => d.getBoundingClientRect().width);
    assert.ok(w <= 375, String(w));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'mobile-dialog.png') });
  });

  if (SHOTS) {
    /* 錯誤狀態與深色模式截圖 */
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(PAGE);
    await setVal(page, 'debt', '-100');
    await page.screenshot({ path: path.join(SHOTS, 'mobile-error.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(PAGE);
    await page.screenshot({ path: path.join(SHOTS, 'mobile-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });
  }

  await check('沒有 console error', async () => assert.deepEqual(errors, []));
  await browser.close();

  failures.forEach(f => { console.error('✗ ' + f.name); console.error('  ' + String(f.e && f.e.message).split('\n').join('\n  ')); });
  console.log((failures.length ? '有失敗：' : '全部通過：') + passed + ' 通過，' + failures.length + ' 失敗');
  process.exitCode = failures.length ? 1 : 0;
})();
