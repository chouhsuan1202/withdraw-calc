/*
 * calc.js 的單元測試。不需要任何套件，直接執行：
 *   node tests/calc.test.js
 * 預期值都用 tests/reference.py（Python Decimal 獨立實作）或手算核對過。
 */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'calc.js'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push({ name, e });
  }
}
/* 浮點數比較：差距小於 1e-9 視為相等 */
function near(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, (msg || '') + ' 預期 ' + expected + '，實際 ' + actual);
}

/* ---------- parseField：輸入驗證 ---------- */
test('parseField 一般數字', () => {
  assert.deepEqual(C.parseField('1000'), { ok: true, value: 1000, error: '' });
  assert.deepEqual(C.parseField(' 2.76 '), { ok: true, value: 2.76, error: '' });
  assert.equal(C.parseField('1e3').value, 1000);
});
test('parseField 空字串、非數字', () => {
  assert.equal(C.parseField('').ok, false);
  assert.equal(C.parseField('   ').error, '請填一個數字');
  assert.equal(C.parseField('abc').ok, false);
  assert.equal(C.parseField(null).ok, false);
  assert.equal(C.parseField(undefined).ok, false);
  assert.equal(C.parseField('Infinity').ok, false);
});
test('parseField 負數', () => {
  const r = C.parseField('-5');
  assert.equal(r.ok, false);
  assert.equal(r.error, '不能是負數');
});
test('parseField 0：一般欄位可以，本金不行', () => {
  assert.equal(C.parseField('0').ok, true);
  const r = C.parseField('0', { positive: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, '要大於 0');
});
test('parseField 上限', () => {
  assert.equal(C.parseField('100', { maxValue: 100 }).ok, true);
  const r = C.parseField('100.5', { maxValue: 100 });
  assert.equal(r.ok, false);
  assert.equal(r.error, '不能超過 100');
});
test('parseField 極大值仍是合法數字', () => {
  assert.equal(C.parseField('1e15').ok, true);
});

/* ---------- 利息 ---------- */
test('利息：1000 萬 × 2.76%', () => {
  near(C.annualInterest(1000, 0.0276), 27.6);
  near(C.monthlyInterest(1000, 0.0276), 2.3);
});
test('利息：借款 0 或利率 0 都是 0', () => {
  assert.equal(C.annualInterest(0, 0.03), 0);
  assert.equal(C.annualInterest(1000, 0), 0);
});

/* ---------- levelOf：門檻判斷 ---------- */
test('levelOf 剛好等於門檻算在內', () => {
  assert.equal(C.levelOf(0.064, 0.064, 0.076), 'ok');
  assert.equal(C.levelOf(0.076, 0.064, 0.076), 'warn');
});
test('levelOf 浮點數雜訊不會誤判', () => {
  /* 0.04 + 0.028 在浮點數下可能是 0.06800000000000001 */
  assert.equal(C.levelOf(0.04 + 2.8 / 100, 0.068, 0.088), 'ok');
});
test('levelOf 超過一點點就換等級', () => {
  assert.equal(C.levelOf(0.0641, 0.064, 0.076), 'warn');
  assert.equal(C.levelOf(0.0761, 0.064, 0.076), 'bad');
});

/* ---------- 固定提領 ---------- */
test('固定：預設值 1000 萬、每月 3 萬、借 1000 萬 @ 2.76%', () => {
  const f = C.fixedSummary({ principal: 1000, monthly: 3, debt: 1000, rate: 0.0276 });
  near(f.withdrawRate, 0.036);
  near(f.interestRate, 0.0276);
  near(f.totalRate, 0.0636);
  assert.equal(f.level, 'ok');
  near(f.sweetMonthly, (64 - 27.6) / 12); /* 3.0333 */
  near(f.maxMonthly, (76 - 27.6) / 12);   /* 4.0333 */
  near(f.interestMonthly, 2.3);
});
test('固定：每月 4 萬是 7.56%，在上限內', () => {
  const f = C.fixedSummary({ principal: 1000, monthly: 4, debt: 1000, rate: 0.0276 });
  near(f.totalRate, 0.0756);
  assert.equal(f.level, 'warn');
});
test('固定：每月 4.06 萬超過上限 4.033 萬，要判成太多（舊版誤判為可以）', () => {
  const f = C.fixedSummary({ principal: 1000, monthly: 4.06, debt: 1000, rate: 0.0276 });
  near(f.totalRate, 0.07632);
  assert.equal(f.level, 'bad');
  assert.ok(4.06 > f.maxMonthly);
});
test('固定：利率 2.84% 時每月 3 萬是 6.44%，超過穩的範圍（舊版誤判為安全）', () => {
  const f = C.fixedSummary({ principal: 1000, monthly: 3, debt: 1000, rate: 0.0284 });
  near(f.totalRate, 0.0644);
  assert.equal(f.level, 'warn');
  assert.ok(3 > f.sweetMonthly);
});
test('固定：等級與上限金額永遠一致（掃過多組金額）', () => {
  for (let w = 0; w <= 8; w += 0.01) {
    const f = C.fixedSummary({ principal: 1000, monthly: w, debt: 1000, rate: 0.0276 });
    const withinMax = w <= f.maxMonthly + 1e-9;
    assert.equal(f.level !== 'bad', withinMax, 'w=' + w);
    const withinSweet = w <= f.sweetMonthly + 1e-9;
    assert.equal(f.level === 'ok', withinSweet, 'w=' + w);
  }
});
test('固定：沒有借款', () => {
  const f = C.fixedSummary({ principal: 1000, monthly: 5, debt: 0, rate: 0.0276 });
  near(f.totalRate, 0.06);
  assert.equal(f.level, 'ok');
  near(f.sweetMonthly, 64 / 12);
  near(f.maxMonthly, 76 / 12);
});
test('固定：利息本身就超過上限，可領金額是 0 不是負數', () => {
  const f = C.fixedSummary({ principal: 500, monthly: 1, debt: 2000, rate: 0.03 });
  assert.equal(f.sweetMonthly, 0);
  assert.equal(f.maxMonthly, 0);
  assert.equal(f.level, 'bad');
});

/* ---------- 部位與保險絲 ---------- */
test('部位：漲跌後的金額', () => {
  near(C.positionAfter(1000, -0.6), 400);
  near(C.positionAfter(1000, 0), 1000);
  near(C.positionAfter(1000, 1), 2000);
});
test('保險絲兩條線', () => {
  const l = C.fuseLines(1000);
  near(l.stop, 600);
  near(l.back, 700);
});
test('fixedState 四種狀態與邊界', () => {
  assert.equal(C.fixedState(1000, 550, 'ok'), 'paused');
  assert.equal(C.fixedState(1000, 599.99, 'ok'), 'paused');
  assert.equal(C.fixedState(1000, 600, 'ok'), 'between');   /* 剛好 600 不算跌破 */
  assert.equal(C.fixedState(1000, 699.99, 'ok'), 'between');
  assert.equal(C.fixedState(1000, 700, 'ok'), 'ok');        /* 剛好 700 算站回 */
  assert.equal(C.fixedState(1000, 1000, 'bad'), 'tooMuch');
  assert.equal(C.fixedState(1000, 1000, 'warn'), 'ok');
  /* 跌破停領線時，暫停優先於「領太多」 */
  assert.equal(C.fixedState(1000, 500, 'bad'), 'paused');
});

/* ---------- 動態提領 ---------- */
test('動態：預設 4%', () => {
  const d = C.dynSummary({ principal: 1000, dynRate: 0.04, debt: 1000, rate: 0.0276 });
  near(d.totalRate, 0.0676);
  assert.equal(d.level, 'ok');
  near(d.monthlyAtStart, 40 / 12);
});
test('動態：4% + 2.84% = 6.84%，超過免調整線（舊版顏色說超過、判斷說安全）', () => {
  const d = C.dynSummary({ principal: 1000, dynRate: 0.04, debt: 1000, rate: 0.0284 });
  near(d.totalRate, 0.0684);
  assert.equal(d.level, 'warn');
});
test('動態：6% + 2.76% = 8.76% 在要配規則的範圍；7% 就太多', () => {
  assert.equal(C.dynSummary({ principal: 1000, dynRate: 0.06, debt: 1000, rate: 0.0276 }).level, 'warn');
  assert.equal(C.dynSummary({ principal: 1000, dynRate: 0.07, debt: 1000, rate: 0.0276 }).level, 'bad');
});
test('動態每月：部位 × 提領率 ÷ 12', () => {
  near(C.dynMonthly(800, 0.07), 56 / 12);
  near(C.dynMonthly(400, 0.04), 16 / 12);
  assert.equal(C.dynMonthly(1000, 0), 0);
});
test('動態範例表', () => {
  const ex = C.dynExamples(1000, 0.04);
  assert.equal(ex.length, 3);
  near(ex[0].position, 700); near(ex[0].yearly, 28); near(ex[0].monthly, 28 / 12);
  near(ex[1].position, 1000); near(ex[1].yearly, 40);
  near(ex[2].position, 1300); near(ex[2].yearly, 52); near(ex[2].monthly, 52 / 12);
});

/* ---------- 反推本金 ---------- */
test('反推：每月 3 萬、借 1000 萬 @ 2.76% 要 837 到 994 萬', () => {
  const n = C.requiredPrincipal(3, 1000, 0.0276);
  near(n.atMax, 63.6 / 0.076);    /* 836.84 */
  near(n.atSweet, 63.6 / 0.064);  /* 993.75 */
  assert.equal(C.fmtInt(n.atMax), '837');
  assert.equal(C.fmtInt(n.atSweet), '994');
});
test('反推與正算互相吻合：用反推的本金正算，剛好落在門檻上', () => {
  const n = C.requiredPrincipal(3, 1000, 0.0276);
  near(C.fixedSummary({ principal: n.atMax, monthly: 3, debt: 1000, rate: 0.0276 }).totalRate, 0.076);
  near(C.fixedSummary({ principal: n.atSweet, monthly: 3, debt: 1000, rate: 0.0276 }).totalRate, 0.064);
});
test('反推：沒有借款', () => {
  const n = C.requiredPrincipal(5, 0, 0.0276);
  near(n.atMax, 60 / 0.076);
  near(n.atSweet, 60 / 0.064);
});

/* ---------- 壞年桶 ---------- */
test('壞年桶：每月 3 萬 × 20 個月 = 60 萬', () => {
  near(C.reserveFor(3), 60);
  assert.equal(C.reserveFor(0), 0);
});

/* ---------- 格式化 ---------- */
test('pctUp 無條件進位，且不受浮點數雜訊影響', () => {
  assert.equal(C.pctUp(0.0636), '6.4');
  assert.equal(C.pctUp(0.064), '6.4');
  assert.equal(C.pctUp(0.0641), '6.5');
  assert.equal(C.pctUp(0.0756), '7.6');
  assert.equal(C.pctUp(0.07632), '7.7');
  assert.equal(C.pctUp(0.04 + 0.028), '6.8');
  assert.equal(C.pctUp(0), '0.0');
});
test('pct 四捨五入', () => {
  assert.equal(C.pct(0.036), '3.6');
  assert.equal(C.pct(0.04872), '4.9');
  assert.equal(C.pct(0), '0.0');
});
test('fmtInt / fmt1 千分位與四捨五入', () => {
  assert.equal(C.fmtInt(1000), '1,000');
  assert.equal(C.fmtInt(836.84), '837');
  assert.equal(C.fmtInt(1e9), '1,000,000,000');
  assert.equal(C.fmtInt(76.32 / 0.064), '1,193'); /* 數學上 1192.5，浮點數是 1192.4999... */
  assert.equal(C.fmt1(40 / 12), '3.3');
  assert.equal(C.fmt1(2.25), '2.3');
  assert.equal(C.fmt1(0), '0.0');
  assert.equal(C.fmt1(1234567.89), '1,234,567.9');
});
test('fmt1 / fmtInt 不會出現 -0', () => {
  assert.equal(C.fmt1(-0.01), '0.0');
  assert.equal(C.fmtInt(-0.4), '0');
});
test('fmt1Down 無條件捨去', () => {
  assert.equal(C.fmt1Down((76 - 27.6) / 12), '4.0');   /* 4.0333 */
  assert.equal(C.fmt1Down((64 - 28.4) / 12), '2.9');   /* 2.9667，四捨五入會變 3.0 */
  assert.equal(C.fmt1Down(9.75), '9.7');
  assert.equal(C.fmt1Down(0.3), '0.3');                /* 0.3 × 10 的浮點誤差不會掉到 0.2 */
  assert.equal(C.fmt1Down(0), '0.0');
});

/* ---------- 和 Python 參考實作比對（有 python3 才跑） ---------- */
test('和 tests/reference.py 的結果一致', () => {
  const { execFileSync } = require('node:child_process');
  let raw;
  try {
    raw = execFileSync('python3', [path.join(__dirname, 'reference.py'), '--json'], { encoding: 'utf8' });
  } catch (e) {
    console.log('  （略過：找不到 python3）');
    return;
  }
  const cases = JSON.parse(raw);
  cases.forEach(ref => {
    const i = ref.input;
    const r = i.rate / 100;
    const f = C.fixedSummary({ principal: i.p0, monthly: i.w, debt: i.debt, rate: r });
    const d = C.dynSummary({ principal: i.p0, dynRate: i.dynRate / 100, debt: i.debt, rate: r });
    const pos = C.positionAfter(i.p0, i.s / 100);
    const tag = JSON.stringify(i);
    assert.equal(C.fmtInt(pos) + ' 萬', ref.pos, tag);
    assert.equal(f.level, ref.fixedLevel, tag);
    assert.equal(C.fixedState(i.p0, pos, f.level), ref.fixedState, tag);
    assert.equal(C.pctUp(f.totalRate), ref.fixedTotalPct, tag);
    assert.equal(C.pct(f.withdrawRate), ref.withdrawPct, tag);
    assert.equal(C.fmt1Down(f.sweetMonthly), ref.sweet, tag);
    assert.equal(C.fmt1Down(f.maxMonthly), ref.max, tag);
    assert.equal(C.fmt1(f.interestMonthly), ref.interestMonthly, tag);
    assert.equal(d.level, ref.dynLevel, tag);
    assert.equal(C.pctUp(d.totalRate), ref.dynTotalPct, tag);
    assert.equal(C.fmt1(C.dynMonthly(pos, i.dynRate / 100)), ref.dynMonthly, tag);
    assert.equal(C.fmt1(d.monthlyAtStart), ref.dynStartMonthly, tag);
    const l = C.fuseLines(i.p0);
    assert.equal(C.fmtInt(l.stop), ref.fuseStop, tag);
    assert.equal(C.fmtInt(l.back), ref.fuseBack, tag);
    if (ref.rev) {
      const n = C.requiredPrincipal(i.revW, i.debt, r);
      assert.equal(C.fmtInt(n.atMax) + ' 到 ' + C.fmtInt(n.atSweet) + ' 萬', ref.rev, tag);
    }
  });
});

/* ---------- 結果 ---------- */
failures.forEach(f => {
  console.error('✗ ' + f.name);
  console.error('  ' + String(f.e && f.e.message).split('\n').join('\n  '));
});
console.log((failures.length ? '有失敗：' : '全部通過：') + passed + ' 通過，' + failures.length + ' 失敗');
process.exitCode = failures.length ? 1 : 0;
