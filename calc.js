/*
 * 0050 提領計算機的計算邏輯（純函式，不碰 DOM）
 *
 * 單位約定：
 *   金額一律是「萬」，利率與提領率一律是小數（4% 寫成 0.04）。
 *
 * 瀏覽器：用 <script src="calc.js"> 載入後掛在 window.WithdrawCalc。
 * Node：require('./calc.js') 取得同一組函式，給單元測試用。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WithdrawCalc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /*
   * 門檻：一年被帳戶拿走的總額（你領的加利息）占起始本金的比例。
   * 數字來自 backtest/backtest.py 的歷史回測（本金 1000 萬、借款 1000 萬、利率 2.76%）：
   *   固定每月 3 萬：(36 + 27.6) / 1000 = 6.36%，四捨五入成 6.4%（最穩）
   *   固定每月 4 萬：(48 + 27.6) / 1000 = 7.56%，四捨五入成 7.6%（上限）
   *   動態部位 4%：4% + 2.76% = 6.76%，四捨五入成 6.8%（免調整）
   *   動態部位 6%：6% + 2.76% = 8.76%，四捨五入成 8.8%（要配 GK 三條規則）
   */
  var THRESHOLDS = Object.freeze({
    fixedSweet: 0.064,
    fixedMax: 0.076,
    dynFree: 0.068,
    dynMax: 0.088
  });

  /* 固定提領的保險絲：部位跌破起始本金六成暫停，回到七成恢復 */
  var FUSE = Object.freeze({ stop: 0.6, back: 0.7 });

  /* 壞年桶準備幾個月的生活費 */
  var RESERVE_MONTHS = 20;

  /* 浮點數比較的容許誤差，避免 0.064000000001 這種雜訊被判成超標 */
  var EPS = 1e-9;

  /**
   * 解析一個輸入欄位的字串。
   * @param {string} raw 輸入框的 value
   * @param {{positive?: boolean, maxValue?: number}} opts
   *   positive：必須大於 0（例如本金）；否則只要大於等於 0
   *   maxValue：上限（例如百分比欄位不能超過 100）
   * @returns {{ok: boolean, value: number, error: string}}
   */
  function parseField(raw, opts) {
    opts = opts || {};
    var text = String(raw == null ? '' : raw).trim();
    if (text === '') return { ok: false, value: NaN, error: '請填一個數字' };
    var n = Number(text);
    if (!Number.isFinite(n)) return { ok: false, value: NaN, error: '請填一個數字' };
    if (n < 0) return { ok: false, value: n, error: '不能是負數' };
    if (opts.positive && n === 0) return { ok: false, value: n, error: '要大於 0' };
    if (opts.maxValue != null && n > opts.maxValue) {
      return { ok: false, value: n, error: '不能超過 ' + opts.maxValue };
    }
    return { ok: true, value: n, error: '' };
  }

  /** 一年利息（萬）：借款 × 年利率 */
  function annualInterest(debt, rate) {
    return debt * rate;
  }

  /** 每月利息（萬）：借款 × 年利率 ÷ 12 */
  function monthlyInterest(debt, rate) {
    return debt * rate / 12;
  }

  /**
   * 依門檻判斷等級。直接拿原始比例比，不先四捨五入，
   * 這樣「最多可以領」算出的金額和安全判斷永遠一致。
   * @returns {'ok'|'warn'|'bad'}
   */
  function levelOf(totalRate, sweet, max) {
    if (totalRate <= sweet + EPS) return 'ok';
    if (totalRate <= max + EPS) return 'warn';
    return 'bad';
  }

  /**
   * 在某個總比例上限下，每月最多能領多少（萬）。
   * (本金 × 比例 − 一年利息) ÷ 12，利息已經超過上限時回傳 0。
   */
  function monthlyCap(principal, capRate, debt, rate) {
    return Math.max(0, (principal * capRate - annualInterest(debt, rate)) / 12);
  }

  /**
   * 固定提領的摘要。
   * @param {{principal:number, monthly:number, debt:number, rate:number}} p
   */
  function fixedSummary(p) {
    var withdrawRate = p.monthly * 12 / p.principal;
    var interestRate = annualInterest(p.debt, p.rate) / p.principal;
    var totalRate = withdrawRate + interestRate;
    return {
      withdrawRate: withdrawRate,
      interestRate: interestRate,
      totalRate: totalRate,
      level: levelOf(totalRate, THRESHOLDS.fixedSweet, THRESHOLDS.fixedMax),
      sweetMonthly: monthlyCap(p.principal, THRESHOLDS.fixedSweet, p.debt, p.rate),
      maxMonthly: monthlyCap(p.principal, THRESHOLDS.fixedMax, p.debt, p.rate),
      interestMonthly: monthlyInterest(p.debt, p.rate)
    };
  }

  /**
   * 動態提領的摘要（以起始本金為基準）。
   * @param {{principal:number, dynRate:number, debt:number, rate:number}} p
   */
  function dynSummary(p) {
    var interestRate = annualInterest(p.debt, p.rate) / p.principal;
    var totalRate = p.dynRate + interestRate;
    return {
      interestRate: interestRate,
      totalRate: totalRate,
      level: levelOf(totalRate, THRESHOLDS.dynFree, THRESHOLDS.dynMax),
      monthlyAtStart: p.principal * p.dynRate / 12,
      interestMonthly: monthlyInterest(p.debt, p.rate)
    };
  }

  /** 股市漲跌 change（-0.6 代表跌 60%）之後的部位 */
  function positionAfter(principal, change) {
    return principal * (1 + change);
  }

  /** 保險絲兩條線（萬） */
  function fuseLines(principal) {
    return { stop: principal * FUSE.stop, back: principal * FUSE.back };
  }

  /**
   * 固定提領在某個部位下的狀態。
   * @returns {'paused'|'between'|'tooMuch'|'ok'}
   *   paused：部位跌破停領線，暫停
   *   between：在停領線與恢復線之間，維持之前的狀態
   *   tooMuch：部位夠，但金額超過上限
   *   ok：照領
   */
  function fixedState(principal, position, level) {
    var lines = fuseLines(principal);
    if (position < lines.stop) return 'paused';
    if (position < lines.back) return 'between';
    if (level === 'bad') return 'tooMuch';
    return 'ok';
  }

  /** 動態提領：1 月部位 × 提領率 ÷ 12 */
  function dynMonthly(position, dynRate) {
    return position * dynRate / 12;
  }

  /**
   * 反推：每月想領 monthly 萬，需要多少本金。
   * atMax：剛好領到上限（7.6%）需要的本金，數字較小
   * atSweet：穩穩地領（6.4%）需要的本金，數字較大
   */
  function requiredPrincipal(monthly, debt, rate) {
    var yearlyOut = monthly * 12 + annualInterest(debt, rate);
    return {
      atMax: yearlyOut / THRESHOLDS.fixedMax,
      atSweet: yearlyOut / THRESHOLDS.fixedSweet
    };
  }

  /** 壞年桶建議金額（萬）：每月金額 × 20 個月 */
  function reserveFor(monthly) {
    return monthly * RESERVE_MONTHS;
  }

  /** 動態範例表：部位跌三成、持平、漲三成時，一年與每月各領多少 */
  function dynExamples(principal, dynRate) {
    return [0.7, 1, 1.3].map(function (factor) {
      var position = principal * factor;
      var yearly = position * dynRate;
      return { factor: factor, position: position, yearly: yearly, monthly: yearly / 12 };
    });
  }

  /*
   * 去掉浮點數雜訊：只保留 12 位有效數字。
   * 例如 76.32 / 0.064 數學上是 1192.5，浮點數算出 1192.4999999999998，
   * 不先清掉的話四捨五入會變 1192 而不是 1193。
   */
  function clean(x) {
    return Number(Number(x).toPrecision(12));
  }

  /**
   * 比例轉成百分比字串，無條件進位到小數一位。
   * 用進位而不是四捨五入，是為了讓畫面上的數字和判斷一致：
   * 只要顯示的數字不超過門檻（例如 7.6），實際比例就一定不超過門檻。
   */
  function pctUp(rate) {
    var tenths = Math.ceil(clean(rate * 1000));
    return (Math.max(0, tenths) / 10).toFixed(1);
  }

  /** 比例轉成百分比字串，四捨五入到小數一位（不拿來跟門檻比的數字用） */
  function pct(rate) {
    return (Math.round(clean(rate * 1000)) / 10).toFixed(1);
  }

  /* 統一的輸出：-0 一律變 0，再用 zh-TW 千分位 */
  function toText(v, digits) {
    if (v === 0) v = 0;
    return v.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  /** 整數（四捨五入，千分位） */
  function fmtInt(n) {
    return toText(Math.round(clean(n)), 0);
  }

  /** 小數一位（四捨五入，千分位） */
  function fmt1(n) {
    return toText(Math.round(clean(n * 10)) / 10, 1);
  }

  /**
   * 小數一位，無條件捨去。用在「穩 / 上限每月最多領多少」：
   * 照著畫面上的數字填，一定落在對應的範圍內，不會因為四捨五入多領一點點就超標。
   */
  function fmt1Down(n) {
    return toText(Math.floor(clean(n * 10)) / 10, 1);
  }

  return {
    THRESHOLDS: THRESHOLDS,
    FUSE: FUSE,
    RESERVE_MONTHS: RESERVE_MONTHS,
    parseField: parseField,
    annualInterest: annualInterest,
    monthlyInterest: monthlyInterest,
    levelOf: levelOf,
    monthlyCap: monthlyCap,
    fixedSummary: fixedSummary,
    dynSummary: dynSummary,
    positionAfter: positionAfter,
    fuseLines: fuseLines,
    fixedState: fixedState,
    dynMonthly: dynMonthly,
    requiredPrincipal: requiredPrincipal,
    reserveFor: reserveFor,
    dynExamples: dynExamples,
    pctUp: pctUp,
    pct: pct,
    fmtInt: fmtInt,
    fmt1: fmt1,
    fmt1Down: fmt1Down
  };
});
