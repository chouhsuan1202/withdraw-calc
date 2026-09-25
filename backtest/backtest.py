#!/usr/bin/env python3
"""0050 提領回測。計算機裡的門檻（固定 6.4% 穩、7.6% 上限；動態 6.8% 免調整、8.8% 要護欄）就是從這裡來的。

python3 backtest.py            跑一遍，印表格，存 results.json
python3 backtest.py --refresh  先從 Yahoo 重抓月資料再跑

規則：
- 本金 P0=1000 萬全進 0050，借款 D=1000 萬只繳息，年利率 r=2.76%，利息每月從股票帳戶扣（保守：現實裡爸的利息是租金付）
- 固定：每月領 W；部位跌破起始六成暫停，回到七成恢復（保險絲）
- 動態：每年 1 月看部位乘提領率當今年生活費，按月領；不設保險絲
- 每個月都當一次起點，各跑 5、10、15 年
- 記：有沒有歸零、保險絲響幾個月、期末夠不夠還清 1000 萬、最差期末剩多少
- 嚴苛版：加權指數 ^TWII 1997 起、不含股息，當底線
"""
import csv, json, os, sys, time, datetime as dt, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
P0, D, R = 1000.0, 1000.0, 0.0276          # 萬、萬、年利率
FUSE_STOP, FUSE_BACK = 0.6, 0.7


def fetch(sym, start):
    p1 = int(dt.datetime(start, 1, 1).timestamp()); p2 = int(time.time())
    u = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?period1={p1}&period2={p2}&interval=1mo"
    d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=60))["chart"]["result"][0]
    q = d["indicators"]["quote"][0]["close"]; adj = d["indicators"].get("adjclose", [{}])[0].get("adjclose") or q
    return [(dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m"), q[i], adj[i]) for i, t in enumerate(d["timestamp"]) if q[i] is not None]


def load(name):
    with open(f"{HERE}/{name}_monthly.csv") as f:
        rows = [(r["month"], float(r["adjclose"])) for r in csv.DictReader(f)]
    if name == "0050":
        # Yahoo 把 2013-12 的 4:1 分割記錯，前面價格全是 4 倍，除回來
        rows = [(m, p / 4 if m < "2013-12" else p) for m, p in rows]
    return rows


def run_fixed(prices, start, months, w):
    pos = P0; paused = False; pause_m = 0; ruin = False
    for k in range(start, start + months):
        pos *= prices[k + 1] / prices[k]
        pos -= D * R / 12
        if not paused and pos < P0 * FUSE_STOP: paused = True
        if paused and pos >= P0 * FUSE_BACK: paused = False
        if paused: pause_m += 1
        else: pos -= w
        if pos <= 0: ruin = True; pos = 0; break
    return dict(end=pos, ruin=ruin, pause=pause_m)


def run_dyn(prices, start, months, rate):
    pos = P0; ruin = False; monthly = pos * rate / 12
    for i, k in enumerate(range(start, start + months)):
        if i % 12 == 0: monthly = pos * rate / 12
        pos *= prices[k + 1] / prices[k]
        pos -= D * R / 12 + monthly
        if pos <= 0: ruin = True; pos = 0; break
    return dict(end=pos, ruin=ruin, pause=0)


def sweep(prices, months, fn, arg):
    outs = [fn(prices, s, months, arg) for s in range(0, len(prices) - months)]
    n = len(outs)
    return dict(paths=n, ruin=sum(o["ruin"] for o in outs), max_pause=max(o["pause"] for o in outs),
                repay=round(100 * sum(o["end"] >= D for o in outs) / n), worst=round(min(o["end"] for o in outs)),
                median=round(sorted(o["end"] for o in outs)[n // 2]))


def main():
    if "--refresh" in sys.argv:
        for sym, name, start in [("0050.TW", "0050", 2000), ("^TWII", "twii", 1997)]:
            rows = fetch(sym, start)
            with open(f"{HERE}/{name}_monthly.csv", "w") as f:
                f.write("month,close,adjclose\n")
                for m, c, a in rows: f.write(f"{m},{c:.4f},{a:.4f}\n")
            print("抓到", name, len(rows), "個月")
    data = {"0050": [p for _, p in load("0050")], "twii": [p for _, p in load("twii")]}
    res = {}
    print(f"\n本金 {P0:.0f} 萬、借款 {D:.0f} 萬 @ {R*100:.2f}%（利息每月 {D*R/12:.2f} 萬從帳戶扣）\n")
    for src, prices in data.items():
        print(f"== {src}（{len(prices)} 個月）==")
        print("固定提領   每月  一年抽本金%   5y還清%  10y還清%  15y還清%  暫停最多(月)  15y最差  15y中位  歸零")
        for w in (3, 4, 5, 6):
            row = {y: sweep(prices, y * 12, run_fixed, w) for y in (5, 10, 15)}
            res[f"{src}_fixed_{w}"] = row
            pct = (w * 12 + D * R) / P0 * 100
            print(f"          {w:>4}萬   {pct:5.1f}%      {row[5]['repay']:>4}     {row[10]['repay']:>4}      {row[15]['repay']:>4}       {max(r['max_pause'] for r in row.values()):>4}      {row[15]['worst']:>6}   {row[15]['median']:>6}   {sum(r['ruin'] for r in row.values())}")
        print("動態提領   比例  一年抽本金%   5y還清%  10y還清%  15y還清%               15y最差  15y中位  歸零")
        for rate in (0.04, 0.05, 0.06):
            row = {y: sweep(prices, y * 12, run_dyn, rate) for y in (5, 10, 15)}
            res[f"{src}_dyn_{int(rate*100)}"] = row
            pct = (rate + D * R / P0) * 100
            print(f"          {rate*100:>3.0f}%    {pct:5.1f}%      {row[5]['repay']:>4}     {row[10]['repay']:>4}      {row[15]['repay']:>4}                    {row[15]['worst']:>6}   {row[15]['median']:>6}   {sum(r['ruin'] for r in row.values())}")
        print()
    with open(f"{HERE}/results.json", "w") as f: json.dump(res, f, ensure_ascii=False, indent=1)
    print("存到 results.json")


if __name__ == "__main__":
    main()
