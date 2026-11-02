#!/usr/bin/env python3
"""獨立的參考實作：用 Python 的 Decimal 從公式重算一次，不共用任何 JS 程式碼。

python3 tests/reference.py          印出各案例的預期值（給人看）
python3 tests/reference.py --json   輸出 JSON，tests/e2e.js 會拿它跟頁面比對

公式（金額單位萬，比例為小數）：
  一年利息          = 借款 × 年利率
  固定總比例        = (每月 × 12 + 一年利息) ÷ 本金
  穩 / 上限每月金額  = max(0, (本金 × 6.4% 或 7.6% − 一年利息) ÷ 12)，顯示時無條件捨去到小數一位
  動態每月          = 部位 × 提領率 ÷ 12
  部位              = 本金 × (1 + 股市漲跌)
  保險絲            = 本金 × 60%（停）、本金 × 70%（恢復）
  反推本金          = (每月 × 12 + 一年利息) ÷ 7.6% 到 ÷ 6.4%
"""
import json
import sys
from decimal import Decimal as Dm, ROUND_HALF_UP, ROUND_CEILING, ROUND_FLOOR

FS, FM, DF, DM = Dm("0.064"), Dm("0.076"), Dm("0.068"), Dm("0.088")


def r0(x):
    return int(Dm(x).quantize(Dm("1"), ROUND_HALF_UP))


def fmt_int(x):
    return f"{r0(x):,}"


def fmt1(x):
    v = Dm(x).quantize(Dm("0.1"), ROUND_HALF_UP)
    return f"{v:,.1f}"


def fmt1_down(x):
    v = Dm(x).quantize(Dm("0.1"), ROUND_FLOOR)
    return f"{v:,.1f}"


def pct_up(rate):
    return f"{(Dm(rate) * 100).quantize(Dm('0.1'), ROUND_CEILING):.1f}"


def pct(rate):
    return f"{(Dm(rate) * 100).quantize(Dm('0.1'), ROUND_HALF_UP):.1f}"


def level(total, sweet, mx):
    return "ok" if total <= sweet else "warn" if total <= mx else "bad"


def case(p0, w, debt, rate_pct, s_pct, dyn_pct, rev_w):
    P0, W, D = Dm(str(p0)), Dm(str(w)), Dm(str(debt))
    r, s, dr = Dm(str(rate_pct)) / 100, Dm(str(s_pct)) / 100, Dm(str(dyn_pct)) / 100
    interest = D * r
    total = (W * 12 + interest) / P0
    sweet = max(Dm(0), (P0 * FS - interest) / 12)
    mx = max(Dm(0), (P0 * FM - interest) / 12)
    pos = P0 * (1 + s)
    dtotal = dr + interest / P0
    stop, back = P0 * Dm("0.6"), P0 * Dm("0.7")
    flevel = level(total, FS, FM)
    if pos < stop:
        state = "paused"
    elif pos < back:
        state = "between"
    elif flevel == "bad":
        state = "tooMuch"
    else:
        state = "ok"
    rw = Dm(str(rev_w))
    rev_out = (rw * 12 + interest)
    return {
        "input": dict(p0=p0, w=w, debt=debt, rate=rate_pct, s=s_pct, dynRate=dyn_pct, revW=rev_w),
        "pos": fmt_int(pos) + " 萬",
        "fixedLevel": flevel,
        "fixedState": state,
        "fixedTotalPct": pct_up(total),
        "withdrawPct": pct(W * 12 / P0),
        "sweet": fmt1_down(sweet),
        "max": fmt1_down(mx),
        "interestMonthly": fmt1(interest / 12),
        "dynLevel": level(dtotal, DF, DM),
        "dynTotalPct": pct_up(dtotal),
        "dynMonthly": fmt1(pos * dr / 12),
        "dynStartMonthly": fmt1(P0 * dr / 12),
        "fuseStop": fmt_int(stop),
        "fuseBack": fmt_int(back),
        "rev": fmt_int(rev_out / FM) + " 到 " + fmt_int(rev_out / FS) + " 萬" if rw > 0 else None,
    }


CASES = [
    # 預設值
    (1000, 3, 1000, 2.76, 0, 4, 3),
    # 剛好在 7.6% 上限邊界、超過一點點
    (1000, 4, 1000, 2.76, 0, 4, 4),
    (1000, 4.06, 1000, 2.76, 0, 4, 4.06),
    # 沒有借款
    (1000, 5, 0, 2.76, 0, 5, 5),
    # 利息本身就超過上限：穩與上限都應該是 0
    (500, 1, 2000, 3, 0, 4, 1),
    # 股市跌 45%（低於停領線）、跌 35%（兩條線之間）、跌 60%
    (1000, 3, 1000, 2.76, -45, 4, 3),
    (1000, 3, 1000, 2.76, -35, 4, 3),
    (1000, 3, 1000, 2.76, -60, 4, 3),
    # 股市漲 100%
    (2000, 6, 500, 2.2, 100, 6, 6),
    # 動態邊界：4% + 2.84% = 6.84%，舊版顏色與判斷不一致的案例
    (1000, 3, 1000, 2.84, 0, 4, 3),
    # 動態超過 8.8%
    (1000, 3, 1000, 2.76, -20, 7, 3),
    # 每月 0 萬
    (1000, 0, 1000, 2.76, 0, 0, 0.5),
    # 極大值
    (1e9, 50000, 1e9, 2, 0, 4, 50000),
]

if __name__ == "__main__":
    out = [case(*c) for c in CASES]
    if "--json" in sys.argv:
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        for o in out:
            print(json.dumps(o, ensure_ascii=False))
