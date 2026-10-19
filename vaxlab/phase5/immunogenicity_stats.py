"""Phase 5 — 免疫原性与保护效力统计评价（零外部依赖，纯标准库）。

对应开发计划 T-501..T-507：
  T-501 endpoint_titre()   4 倍/2 倍系列稀释 OD → 线性插值终点滴度（cut-off = 阴性均值 × 2.1）
  T-502 welch_t() / mannwhitney_u()  组间比较（log2 滴度；小 n 以非参数为准）
  T-503 four_pl()          剂量-效应 4 参数对数-逻辑，变量投影 NLS（给定 ED50/Hill 时
                           顶/底幅值为线性最小二乘解）+ 网格粗搜 + 区间细化
  T-504 gmt()              GMT = 2^mean(log2 titre) 与相对未免疫对照倍数变化
  T-505 protection()       保护率 + 1 尾 Fisher 精确检验（超几何精确式）+ 载量对数降幅
  T-506 elispot_compare()  每百万 PBMC 斑点，组间中位数差 + U 检验 p
  T-507 run()              产出 phase5/immunogenicity_report.json 与 immunogenicity_summary.csv

统计口径（写死，避免口径漂移）：alpha=0.05；组间双侧；保护效力 1 尾且必须同时报效应量；
滴度一律 log2 变换后再算均值/方差；n < 5 的组标注 low-n: descriptive only。
分布尾概率用不完全 Beta / 不完全 Gamma 连分式自行实现（Numerical Recipes 算法），不引 SciPy。
"""

import csv
import json
import math
import os

ALPHA = 0.05
CUTOFF_FACTOR = 2.1
LOW_N = 5


# ---------------------------------------------------------------- 分布尾概率（纯标准库）

def _betacf(a, b, x):
    """不完全 Beta 连分式（modified Lentz 法）。"""
    MAXIT, EPS, FPMIN = 300, 3.0e-12, 1.0e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < FPMIN:
        d = FPMIN
    d = 1.0 / d
    h = d
    for m in range(1, MAXIT + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < FPMIN:
            d = FPMIN
        c = 1.0 + aa / c
        if abs(c) < FPMIN:
            c = FPMIN
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < EPS:
            break
    return h


def betai(a, b, x):
    """正则化不完全 Beta 函数 I_x(a,b)。"""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    lbeta = (math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
             + a * math.log(x) + b * math.log(1.0 - x))
    bt = math.exp(lbeta)
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1.0 - x) / b


def t_sf_two_sided(t, df):
    """Student t 双侧尾概率：p = I_{df/(df+t^2)}(df/2, 1/2)。"""
    return betai(df / 2.0, 0.5, df / (df + t * t))


def f_sf(x, d1, d2):
    """F 分布右尾概率：p = I_{d2/(d2+d1 x)}(d2/2, d1/2)。"""
    if x <= 0:
        return 1.0
    return betai(d2 / 2.0, d1 / 2.0, d2 / (d2 + d1 * x))


def norm_sf(z):
    """标准正态右尾概率。"""
    return 0.5 * math.erfc(z / math.sqrt(2.0))


# ---------------------------------------------------------------- T-501 终点滴度

def endpoint_titre(od_by_log2dil, neg_mean_od, cutoff_factor=CUTOFF_FACTOR):
    """od_by_log2dil: [(log2 稀释度, OD)] 升序。返回 (终点滴度 log2, cutoff)。

    线性插值：在 OD 由 ≥cutoff 跌到 <cutoff 的相邻稀释步之间按 OD 线性内插。
    若首点即低于 cutoff 返回 None。
    """
    cutoff = neg_mean_od * cutoff_factor
    pts = sorted(od_by_log2dil)
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if y0 >= cutoff > y1:
            frac = (y0 - cutoff) / (y0 - y1) if y0 != y1 else 0.0
            return x0 + frac * (x1 - x0), cutoff
    if pts and pts[-1][1] >= cutoff:
        return pts[-1][0], cutoff  # 全部高于 cutoff：报最高稀释度（右截尾，如实标注）
    return None, cutoff


# ---------------------------------------------------------------- T-502 组间比较

def _mean(xs):
    return sum(xs) / len(xs)


def welch_t(a, b):
    """Welch t 检验（双侧）。返回 dict(t, df, p, low_n...)。"""
    na, nb = len(a), len(b)
    ma, mb = _mean(a), _mean(b)
    va = sum((x - ma) ** 2 for x in a) / (na - 1)
    vb = sum((x - mb) ** 2 for x in b) / (nb - 1)
    se2 = va / na + vb / nb
    t = (ma - mb) / math.sqrt(se2)
    df = se2 ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1))
    return {"test": "welch_t", "t": t, "df": df, "p": t_sf_two_sided(t, df),
            "low_n": na < LOW_N or nb < LOW_N}


def mannwhitney_u(a, b):
    """Mann-Whitney U（正态近似 + ties 校正 + 连续性校正，双侧）。小样本仍报精确方向性由调用方决定。"""
    na, nb = len(a), len(b)
    # ties 分组（合并序列相等段长度）
    pooled = sorted(a + b)
    tie_groups, i = [], 0
    while i < len(pooled):
        j = i
        while j + 1 < len(pooled) and pooled[j + 1] == pooled[i]:
            j += 1
        if j > i:
            tie_groups.append(j - i + 1)
        i = j + 1
    # 带组别身份的平均秩
    tagged = [(v, "a") for v in a] + [(v, "b") for v in b]
    tagged_sorted = sorted(tagged, key=lambda t: t[0])
    ranks_tagged = []
    i = 0
    while i < len(tagged_sorted):
        j = i
        while j + 1 < len(tagged_sorted) and tagged_sorted[j + 1][0] == tagged_sorted[i][0]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for _ in range(i, j + 1):
            ranks_tagged.append(avg)
        i = j + 1
    ra = sum(rk for rk, (_, g) in zip(ranks_tagged, tagged_sorted) if g == "a")
    u_a = ra - na * (na + 1) / 2.0
    u_b = na * nb - u_a
    u = min(u_a, u_b)
    mu = na * nb / 2.0
    n = na + nb
    # sigma² = na·nb/12·[(n+1) − Σ(t³−t)/(n(n−1))]
    sigma2 = na * nb / 12.0 * ((n + 1) - sum(t ** 3 - t for t in tie_groups) / (n * (n - 1.0)))
    z = (abs(u - mu) - 0.5) / math.sqrt(sigma2)
    exact = None if tie_groups else _mwu_exact_p(na, nb, u)
    if exact is not None:
        p, method = exact, "exact"
    else:
        p, method = min(1.0, 2.0 * norm_sf(z)), "normal-approx-ties-corrected"
    return {"test": "mannwhitney_u", "U": u, "z": z, "p": p, "p_method": method,
            "ties_corrected": bool(tie_groups), "low_n": na < LOW_N or nb < LOW_N}


def _mwu_exact_p(na, nb, u_obs):
    """小样本精确双侧 p：枚举 U 的零分布（DP 计数）。n 过大时返回 None 回退近似。"""
    if na * nb > 400 or max(na, nb) > 20:
        return None
    # dp[k][s] = 从秩 1..(na+nb) 中恰取 k 个、秩和为 s 的方案数（二维 DP，固定组大小）
    smax = na * (2 * (na + nb) - na + 1) // 2      # 最大秩和：取最大的 na 个秩
    dp = [[0] * (smax + 1) for _ in range(na + 1)]
    dp[0][0] = 1
    for rank in range(1, na + nb + 1):
        for k in range(min(rank, na), 0, -1):
            for s in range(smax, rank - 1, -1):
                dp[k][s] += dp[k - 1][s - rank]
    total = 0
    numer = 0
    mu = na * nb / 2.0
    for s in range(smax + 1):
        cnt = dp[na][s]
        if not cnt:
            continue
        total += cnt
        us = s - na * (na + 1) / 2.0  # U_a = R_a - na(na+1)/2
        if us < -1e-9 or us > na * nb + 1e-9:
            continue
        if abs(us - mu) >= abs(u_obs - mu) - 1e-9:
            numer += cnt
    if total == 0:
        return None
    return min(1.0, numer / total)



# ---------------------------------------------------------------- T-503 4PL 变量投影

def four_pl(log_dose, response):
    """4 参数对数-逻辑：y = bot + (top-bot)/(1+2^{-b(x-ED50)})，变量投影 NLS。

    给定 (ED50, b)，响应关于 (bot, top) 线性 → 闭式最小二乘；外层对 (ED50, b)
    网格粗搜 + 区间细化 3 轮。返回 ED50、Hill b、top、bot、sse、r2。
    """
    n = len(log_dose)
    lo_x, hi_x = min(log_dose), max(log_dose)

    def design(ed50, b):
        z = [1.0 / (1.0 + 2.0 ** (-b * (x - ed50))) for x in log_dose]
        return z

    def proj_sse(ed50, b):
        z = design(ed50, b)
        # y = bot*(1-z) + top*z
        s00 = sum((1 - zi) ** 2 for zi in z)
        s11 = sum(zi * zi for zi in z)
        s01 = sum((1 - zi) * zi for zi in z)
        t0 = sum(y * (1 - zi) for y, zi in zip(response, z))
        t1 = sum(y * zi for y, zi in zip(response, z))
        det = s00 * s11 - s01 * s01
        if abs(det) < 1e-18:
            return float("inf"), 0.0, 0.0
        top = (s00 * t1 - s01 * t0) / det
        bot = (s11 * t0 - s01 * t1) / det
        sse = sum((y - (bot + (top - bot) * zi)) ** 2 for y, zi in zip(response, z))
        return sse, bot, top

    est_ed, est_b = 0.5 * (lo_x + hi_x), 1.0
    est_ed_rng, est_b_rng = (lo_x - 2.0, hi_x + 2.0), (0.05, 6.0)
    best = (float("inf"), est_ed, est_b)
    for _round in range(6):
        ne, nb = 41, 33
        for ie in range(ne + 1):
            ed = est_ed_rng[0] + (est_ed_rng[1] - est_ed_rng[0]) * ie / ne
            for ib in range(nb + 1):
                b = est_b_rng[0] + (est_b_rng[1] - est_b_rng[0]) * ib / nb
                sse, _, _ = proj_sse(ed, b)
                if sse < best[0]:
                    best = (sse, ed, b)
        _, est_ed, est_b = best
        ded = (est_ed_rng[1] - est_ed_rng[0]) / 8.0
        db = (est_b_rng[1] - est_b_rng[0]) / 8.0
        est_ed_rng = (est_ed - ded, est_ed + ded)
        est_b_rng = (max(0.05, est_b - db), est_b + db)
    sse, bot, top = proj_sse(best[1], best[2])
    ybar = _mean(response)
    sst = sum((y - ybar) ** 2 for y in response)
    return {"model": "4PL-loglogit(base2)", "ED50_log2dose": best[1], "hill_b": best[2],
            "top": top, "bottom": bot, "sse": sse,
            "r2": 1.0 - sse / sst if sst > 0 else 1.0}


# ---------------------------------------------------------------- T-504 GMT

def gmt(log2_a, log2_ctrl):
    mean_a, mean_c = _mean(log2_a), _mean(log2_ctrl)
    return {"GMT_immunized": 2.0 ** mean_a, "GMT_control": 2.0 ** mean_c,
            "fold_change_vs_control": 2.0 ** (mean_a - mean_c),
            "low_n": len(log2_a) < LOW_N or len(log2_ctrl) < LOW_N}


# ---------------------------------------------------------------- T-505 保护效力

def fisher_exact_1sided(a, b, c, d):
    """1 尾 Fisher 精确检验 P(X >= a | 边际固定)，超几何精确式。表 [[a,b],[c,d]]。"""
    n1, n2 = a + b, c + d
    k, nn = a + c, a + b + c + d

    def lchoose(n, r):
        return math.lgamma(n + 1) - math.lgamma(r + 1) - math.lgamma(n - r + 1)

    logdenom = lchoose(nn, k)
    p = 0.0
    for x in range(max(0, k - n2), min(k, n1) + 1):
        if x < a:
            continue
        p += math.exp(lchoose(n1, x) + lchoose(n2, k - x) - logdenom)
    return min(1.0, p)


def protection(loads_vax, loads_ctrl, threshold):
    """保护 = 攻毒后载量 < threshold。返回保护率、1 尾 Fisher p、载量对数降幅（效应量）。"""
    pv = sum(1 for x in loads_vax if x < threshold)
    nv = len(loads_vax)
    pc = sum(1 for x in loads_ctrl if x < threshold)
    nc = len(loads_ctrl)
    p = fisher_exact_1sided(pv, nv - pv, pc, nc - pc)
    med_v = sorted(loads_vax)[nv // 2] if nv % 2 else 0.5 * sum(sorted(loads_vax)[nv // 2 - 1:nv // 2 + 1])
    med_c = sorted(loads_ctrl)[nc // 2] if nc % 2 else 0.5 * sum(sorted(loads_ctrl)[nc // 2 - 1:nc // 2 + 1])
    log_reduction = math.log10(med_c / med_v) if med_v > 0 and med_c > 0 else None
    return {"protection_vax": [pv, nv], "protection_ctrl": [pc, nc],
            "protection_rate_vax": pv / nv, "protection_rate_ctrl": pc / nc,
            "fisher_1sided_p": p, "median_log10_load_reduction": log_reduction,
            "low_n": min(nv, nc) < LOW_N}


# ---------------------------------------------------------------- T-506 ELISpot

def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else 0.5 * (s[n // 2 - 1] + s[n // 2])


def elispot_compare(sfc_vax, sfc_ctrl):
    u = mannwhitney_u(sfc_vax, sfc_ctrl)
    return {"median_vax_SFC_per_1e6": median(sfc_vax), "median_ctrl_SFC_per_1e6": median(sfc_ctrl),
            "median_difference": median(sfc_vax) - median(sfc_ctrl),
            "U": u["U"], "p": u["p"], "low_n": u["low_n"]}


# ---------------------------------------------------------------- T-507 产出

def demo_dataset():
    """演示级样本（§7.2：接入真实动物批次数据后替换）。口径与 §3.4 手算样例锁定。"""
    return {
        "serum_od": {  # 演示 OD 序列锁定 §3.4 锚点1：终点滴度 3.43 log2（cut-off=0.21）
            "neg_mean_od": 0.10,
            "example_series": [[1, 0.85], [2, 0.60], [3, 0.35], [4, 0.024], [5, 0.012]],
        },
        # log2 终点滴度（由 endpoint_titre 对每只动物序列计算；此处直接给每只动物插值结果）
        "log2_titre_vax": [14.1, 14.5, 14.9, 15.2, 15.6, 14.8],
        "log2_titre_naive": [2.737, 3.237, 3.737, 4.237, 4.737],
        "dose_response_4pl": {  # 合成数据：真值 ED50=8.0(log2 dose), b=1.5, top=80, bot=0
            "x": [2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0],
            "y": [0.0 + 80.0 / (1.0 + 2.0 ** (-1.5 * (x - 8.0)))
                  for x in [2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0]],
        },
        "challenge_loads": {   # 攻毒后肺载量 log10 RNA copies/mL（阈值 3.0 判保护）
            "threshold": 3.0,
            "vax": [1.8, 2.1, 2.4, 1.5, 2.9, 4.2, 2.2, 2.6],
            "ctrl": [5.1, 4.8, 3.9, 5.5, 4.4, 6.0, 5.2, 4.9],
        },
        "elispot_sfc": {
            "vax": [812, 903, 764, 1011, 888, 950],
            "ctrl": [41, 58, 36, 63, 47, 52],
        },
    }


def run(root=None, dataset=None):
    root = root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ds = dataset or demo_dataset()
    outdir = os.path.join(root, "phase5")
    os.makedirs(outdir, exist_ok=True)

    titre, cutoff = endpoint_titre([(x, y) for x, y in ds["serum_od"]["example_series"]],
                                   ds["serum_od"]["neg_mean_od"])
    vax, nai = ds["log2_titre_vax"], ds["log2_titre_naive"]
    wel = welch_t(vax, nai)
    mwu = mannwhitney_u(vax, nai)
    f4 = four_pl(ds["dose_response_4pl"]["x"], ds["dose_response_4pl"]["y"])
    g = gmt(vax, nai)
    ch = ds["challenge_loads"]
    prot = protection(ch["vax"], ch["ctrl"], ch["threshold"])
    el = elispot_compare(ds["elispot_sfc"]["vax"], ds["elispot_sfc"]["ctrl"])

    report = {
        "alpha": ALPHA, "cutoff": cutoff, "endpoint_titre_log2": titre,
        "welch": wel, "mannwhitney": mwu, "four_pl": f4, "gmt": g,
        "protection": prot, "elispot": el,
        "conclusion_gate": {
            "group_comparison_p": min(wel["p"], mwu["p"]),
            "authoritative_test": "mannwhitney_u (小 n 以非参数为准)",
            "significant": mwu["p"] < ALPHA and not mwu["low_n"],
        },
        "note": "演示级样本（开发计划 §7.2）；接入真实动物批次（每组 n>=8）后重算。",
    }
    with open(os.path.join(outdir, "immunogenicity_report.json"), "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False, sort_keys=True)

    rows = [
        {"metric": "endpoint_titre_log2", "value": titre, "p": "", "note": "cut-off=2.1x阴性均值OD"},
        {"metric": "welch_t", "value": wel["t"], "p": wel["p"], "note": "log2 滴度，双侧"},
        {"metric": "mannwhitney_U", "value": mwu["U"], "p": mwu["p"], "note": "ties+连续性校正，权威口径"},
        {"metric": "ED50_log2dose", "value": f4["ED50_log2dose"], "p": "", "note": "4PL 变量投影 NLS"},
        {"metric": "hill_b", "value": f4["hill_b"], "p": "", "note": "Hill 斜率"},
        {"metric": "GMT_fold_change", "value": g["fold_change_vs_control"], "p": "", "note": "vs 未免疫"},
        {"metric": "protection_rate_vax", "value": prot["protection_rate_vax"], "p": prot["fisher_1sided_p"],
         "note": "1 尾 Fisher + 效应量 log10 载量降幅"},
        {"metric": "elispot_median_diff_SFC", "value": el["median_difference"], "p": el["p"],
         "note": "每百万 PBMC 斑点"},
    ]
    with open(os.path.join(outdir, "immunogenicity_summary.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, ["metric", "value", "p", "note"], lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: (round(v, 6) if isinstance(v, float) else v) for k, v in r.items()})
    return report


def main():
    rep = run()
    print("[phase5] endpoint titre = %.2f log2 (cut-off %.3f)" % (rep["endpoint_titre_log2"], rep["cutoff"]))
    print("[phase5] Welch t=%.3f p=%.3g | MWU U=%.1f p=%.4g" % (
        rep["welch"]["t"], rep["welch"]["p"], rep["mannwhitney"]["U"], rep["mannwhitney"]["p"]))
    print("[phase5] 4PL ED50=%.3f b=%.3f top=%.2f bot=%.2f R2=%.6f" % (
        rep["four_pl"]["ED50_log2dose"], rep["four_pl"]["hill_b"], rep["four_pl"]["top"],
        rep["four_pl"]["bottom"], rep["four_pl"]["r2"]))
    print("[phase5] GMT fold = %.1fx | protection p=%.4f | elispot p=%.4g" % (
        rep["gmt"]["fold_change_vs_control"], rep["protection"]["fisher_1sided_p"], rep["elispot"]["p"]))


if __name__ == "__main__":
    main()
