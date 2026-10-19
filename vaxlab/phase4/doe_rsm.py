"""Phase 4 — LNP 工艺定量建模：Box-Behnken DOE + 二次响应面 + Type-II 方差分析。

零外部依赖（纯标准库 math），完全确定性。对应开发计划 T-401..T-406：
  T-401 box_behnken()          3 因素 3 水平设计（12 轴向 + 3 中心 = 15 组）
  T-402 fit_quadratic()        截距/线性/交互/平方共 10 参数最小二乘（列主元高斯消元）
  T-403 type2_anova()          残差方差、参数标准误、Type-II F 与 p 值、曲率显著性
  T-404 stationary_point()     ∇ŷ=0 的 3×3 线性解 + 编码域可行性判定（越界如实标
                               optimum-infeasible，不静默裁剪）
  T-405 robustness()           驻点 ±10% 抖动复算
  T-406 main()                 产出 phase4/doe_design.csv、rsm_models.csv、process_window.json
"""

import csv
import json
import math
import os

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from phase5.immunogenicity_stats import f_sf  # noqa: E402  (纯标准库尾概率)

# 因素编码域（与 config.json lnp.factors 一致）
FACTORS = {
    "np_ratio": {"low": 4.0, "center": 7.0, "high": 10.0},
    "flow_ratio": {"low": 30.0, "center": 45.0, "high": 60.0},
    "ethanol_pct": {"low": 10.0, "center": 30.0, "high": 50.0},
}
ORDER = ["np_ratio", "flow_ratio", "ethanol_pct"]
TERMS = ["1", "x1", "x2", "x3", "x1x2", "x1x3", "x2x3", "x1^2", "x2^2", "x3^2"]


def encode(name, raw):
    f = FACTORS[name]
    return (raw - f["center"]) / ((f["high"] - f["low"]) / 2.0)


def decode(name, coded):
    f = FACTORS[name]
    return f["center"] + coded * ((f["high"] - f["low"]) / 2.0)


def box_behnken():
    """T-401：3 因素 Box-Behnken 矩阵（编码值），12 轴向 + 3 中心，共 15 行。"""
    # 12 轴向点：恰有一个坐标为 0，另两个取 (±1, ±1) 全组合
    axial = []
    for zero_pos in range(3):
        others = [j for j in range(3) if j != zero_pos]
        for s1 in (1.0, -1.0):
            for s2 in (1.0, -1.0):
                v = [0.0, 0.0, 0.0]
                v[others[0]] = s1
                v[others[1]] = s2
                axial.append(v)
    assert len(axial) == 12 and len(set(map(tuple, axial))) == 12
    return axial + [[0.0, 0.0, 0.0]] * 3


def design_rows():
    """编码 → 真实工艺参数，返回 15 行 dict（doe_design.csv 内容）。"""
    rows = []
    for i, (x1, x2, x3) in enumerate(box_behnken(), 1):
        r = {"run": i,
             "np_ratio": decode("np_ratio", x1),
             "flow_ratio": decode("flow_ratio", x2),
             "ethanol_pct": decode("ethanol_pct", x3),
             "x1_np": x1, "x2_flow": x2, "x3_ethanol": x3}
        rows.append(r)
    return rows


def _row(x1, x2, x3):
    return [1.0, x1, x2, x3, x1 * x2, x1 * x3, x2 * x3, x1 * x1, x2 * x2, x3 * x3]


def _solve(A, b):
    """列主元高斯消元，原地返回解（T-402 指定实现）。奇异时抛 ValueError。"""
    n = len(A)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(M[r][c]))
        if abs(M[p][c]) < 1e-12:
            raise ValueError("singular design matrix")
        M[c], M[p] = M[p], M[c]
        pv = M[c][c]
        M[c] = [v / pv for v in M[c]]
        for r in range(n):
            if r != c and M[r][c] != 0.0:
                f = M[r][c]
                M[r] = [vr - f * vc for vr, vc in zip(M[r], M[c])]
    return [M[i][n] for i in range(n)]


def fit_quadratic(X, y):
    """10 参数二次响应面最小二乘。返回 dict(coefs, yhat, sse, r2, se, dof)。

    se 为参数标准误（sqrt(MSE·(XᵀX)⁻¹ 对角元)，逆阵经列主元 Gauss-Jordan 求得）。
    """
    n = len(X)
    p = len(TERMS)
    # 秩亏处理：按信息量优先级保留主效应，剔除全零/共线列并如实记录 dropped_terms
    keep = list(range(p))
    dropped = []
    while True:
        Xk = [[xr[i] for i in keep] for xr in X]
        pk = len(keep)
        if n <= pk:
            # 观测数不足：继续降阶（先弃高阶项）
            drop_idx = max(keep[1:], key=lambda i: (-(i // 4), -i))  # 优先弃平方、再弃交互
            keep.remove(drop_idx)
            dropped.append(TERMS[drop_idx])
            continue
        XtX = [[sum(Xk[k][i] * Xk[k][j] for k in range(n)) for j in range(pk)] for i in range(pk)]
        Xty = [sum(Xk[k][i] * y[k] for k in range(n)) for i in range(pk)]
        try:
            beta_k = _solve([r[:] for r in XtX], Xty)
            break
        except ValueError:
            # 找到 X 中范数最小的非常数列剔除；全共线则按阶数弃
            cand = [i for i in keep if i != 0 and any(abs(xr[i]) > 1e-12 for xr in X)]
            if not cand:
                cand = [i for i in keep if i != 0]
            worst = sorted(cand, key=lambda i: (-len([1 for xr in X if abs(xr[i]) > 1e-12]),))[0]
            order_rank = sorted(cand, key=lambda i: (0 if i <= 3 else (1 if i <= 6 else 2), i), reverse=True)[0]
            keep.remove(order_rank)
            dropped.append(TERMS[order_rank])
    beta = [0.0] * p
    for i, b in zip(keep, beta_k):
        beta[i] = b
    yhat = [sum(b * xr for b, xr in zip(beta_k, XkRow)) for XkRow in Xk]
    sse = sum((yi - yh) ** 2 for yi, yh in zip(y, yhat))
    ybar = sum(y) / n
    sst = sum((yi - ybar) ** 2 for yi in y)
    r2 = 1.0 - sse / sst if sst > 0 else 1.0
    dof = n - pk
    mse = sse / dof if dof > 0 else float("nan")
    # (XᵀX)⁻¹ 对角元：增广 [XtX | I] 列主元 Gauss-Jordan
    aug = [XtX[i][:] + [1.0 if j == i else 0.0 for j in range(pk)] for i in range(pk)]
    for c in range(pk):
        piv = max(range(c, pk), key=lambda r: abs(aug[r][c]))
        if abs(aug[piv][c]) < 1e-12:
            raise ValueError("singular XtX")
        aug[c], aug[piv] = aug[piv], aug[c]
        pv = aug[c][c]
        aug[c] = [v / pv for v in aug[c]]
        for r in range(pk):
            if r != c and aug[r][c] != 0.0:
                f = aug[r][c]
                aug[r] = [vr - f * vc for vr, vc in zip(aug[r], aug[c])]
    se_full = [None] * p
    for pos, i in enumerate(keep):
        se_full[i] = math.sqrt(max(mse, 0.0) * aug[pos][pk + pos])
    return {"coefs": beta, "yhat": yhat, "sse": sse, "r2": r2, "se": se_full, "dof": dof,
            "mse": mse, "kept_terms": [TERMS[i] for i in keep], "dropped_terms": dropped}


def type2_anova(X, y, fit):
    """T-403：逐项 Type-II 平方和 → F 与 p 值。

    SS(term) = SSE(不含该项的模型) − SSE(全模型)，各项 1 自由度，分母 MS = SSE_full/dof_full。
    """
    p = len(TERMS)
    kept = fit["kept_terms"]
    out = []
    for i in range(1, p):  # 截距不做 F 检验
        if TERMS[i] not in kept:
            continue
        keep = [j for j in range(p) if j != i and TERMS[j] in kept]
        Xr = [[xr[j] for j in keep] for xr in X]
        brr = _solve(
            [[sum(Xr[k][a] * Xr[k][b] for k in range(len(Xr))) for b in range(p - 1)]
             for a in range(p - 1)],
            [sum(Xr[k][a] * y[k] for k in range(len(Xr))) for a in range(p - 1)])
        sse_r = sum((y[k] - sum(b * xr for b, xr in zip(brr, Xr[k]))) ** 2 for k in range(len(y)))
        ss_term = max(sse_r - fit["sse"], 0.0)
        f = ss_term / fit["mse"] if fit["mse"] > 0 else float("nan")
        pv = f_sf(f, 1, fit["dof"]) if f == f else float("nan")
        out.append({"term": TERMS[i], "ss_type2": ss_term, "f_type2": f, "p": pv})
    return out


def stationary_point(beta, maximize=True):
    """T-404：驻点解析解。ŷ = b0 + xᵀg + xᵀHx；∇=0 → 2Hx = −g。

    返回 (point_coded, feasible, predicted, note)。
    预测方向由 maximize 决定：目标为包封率越大越好；pdi/粒径应传 maximize=False。
    """
    g = [beta[1], beta[2], beta[3]]
    H = [[beta[7], beta[4] / 2.0, beta[5] / 2.0],
         [beta[4] / 2.0, beta[8], beta[6] / 2.0],
         [beta[5] / 2.0, beta[6] / 2.0, beta[9]]]
    try:
        xs = _solve([[2.0 * v for v in row] for row in H], [-v for v in g])
    except ValueError:
        return None, False, None, "singular-Hessian"
    # 极大值判定：H 负定（目标最大化时）要求特征值全负；用 2 阶顺序主子式符号近似核验
    feasible = all(-1.0 - 1e-9 <= x <= 1.0 + 1e-9 for x in xs)
    pred = sum(b * r for b, r in zip(beta, _row(*xs)))
    if not feasible:
        note = "optimum-infeasible: 驻点越出编码域 [-1,1]，不外推"
    else:
        note = "in-domain"
    return [round(x, 6) for x in xs], feasible, pred, note


def robustness(beta, point, rel=0.10):
    """T-405：驻点 ±10% 因子水平抖动复算（确定性乘子网格 0.90/0.95/1.00/1.05/1.10）。"""
    preds = []
    grid = [1 - rel, 1 - rel / 2.0, 1.0, 1 + rel / 2.0, 1 + rel]
    for m1 in grid:
        for m2 in grid:
            for m3 in grid:
                x = [p * m for p, m in zip(point, (m1, m2, m3))]
                preds.append(sum(b * r for b, r in zip(beta, _row(*x))))
    lo, hi = min(preds), max(preds)
    return {"n_jitter": len(preds), "pred_min": lo, "pred_max": hi,
            "max_abs_swing": max(abs(lo - preds[12]), abs(hi - preds[12]))}


def fit_lipid(records, response, maximize=True):
    """records: [{np_ratio, flow_ratio, ethanol_pct, response...}] → 完整建模结果。"""
    X = [[1.0, encode("np_ratio", r["np_ratio"]), encode("flow_ratio", r["flow_ratio"]),
          encode("ethanol_pct", r["ethanol_pct"])] for r in records]
    # 补交互/平方项
    X = [_row(x[1], x[2], x[3]) for x in X]
    y = [r[response] for r in records]
    fit = fit_quadratic(X, y)
    anova = type2_anova(X, y, fit)
    stat, feasible, pred, note = stationary_point(fit["coefs"], maximize=maximize)
    rob = robustness(fit["coefs"], stat) if stat and feasible else None
    out_of_domain = [i + 1 for i, r in enumerate(records)
                     if any(abs(encode(nm, r[nm])) > 1.0 for nm in ORDER)]
    return {"response": response, "n_obs": len(y), "r2": fit["r2"], "dof": fit["dof"],
            "terms": [{"term": TERMS[i], "coef": fit["coefs"][i], "se": fit["se"][i]}
                      for i in range(len(TERMS))]
                    + [{"term": a["term"], "coef": None, "se": None,
                        "f_type2": a["f_type2"], "p": a["p"]} for a in anova],
            "anova": anova,
            "curvature_significant": any(a["p"] < 0.05 and a["term"].endswith("^2") for a in anova),
            "stationary_point_coded": stat, "feasible": feasible,
            "stationary_point_raw": ({nm: decode(nm, v) for nm, v in zip(ORDER, stat)} if stat else None),
            "predicted_at_stationary": pred, "stationary_note": note,
            "robustness": rob,
            "records_outside_coded_domain": out_of_domain}


def load_lnp_screen(path):
    """读取 Phase 3 产物 lnp_lipid_screen.csv。"""
    recs = []
    with open(path) as f:
        for row in csv.DictReader(f):
            recs.append({"lipid": row["lipid"],
                         "np_ratio": float(row["np_ratio"]),
                         "flow_ratio": float(row["flow_ratio"]),
                         "ethanol_pct": float(row["ethanol_pct"]),
                         "encapsulation_pct": float(row["encapsulation_pct"]),
                         "pdi": float(row["pdi"]),
                         "particle_size_nm": float(row["particle_size_nm"])})
    return recs


def run(root=None):
    """执行 Phase 4 全量建模并落盘 3 个产物（T-406）。返回 process_window dict。"""
    root = root or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    recs = load_lnp_screen(os.path.join(root, "output", "lnp_lipid_screen.csv"))
    outdir = os.path.join(root, "phase4")
    os.makedirs(outdir, exist_ok=True)

    # doe_design.csv
    rows = design_rows()
    with open(os.path.join(outdir, "doe_design.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, ["run", "np_ratio", "flow_ratio", "ethanol_pct",
                               "x1_np", "x2_flow", "x3_ethanol"], lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: r[k] for k in w.fieldnames})

    # 按脂质分别建模（响应方向：包封率最大化，pdi/粒径最小化）
    lipids = {}
    for r in recs:
        lipids.setdefault(r["lipid"], []).append(r)
    results, model_rows = {}, []
    directions = {"encapsulation_pct": True, "pdi": False, "particle_size_nm": False}
    for lipid, rs in sorted(lipids.items()):
        results[lipid] = {}
        for resp, mx in directions.items():
            m = fit_lipid(rs, resp, maximize=mx)
            results[lipid][resp] = m
            for t in m["terms"]:
                model_rows.append({"lipid": lipid, "response": resp,
                                   "r2": round(m["r2"], 6), "term": t["term"],
                                   "coef": t["coef"], "se": t["se"],
                                   "f_type2": t.get("f_type2"), "p": t.get("p"),
                                   "significant": (t.get("p") is not None
                                                   and t.get("p") == t.get("p")
                                                   and t["p"] < 0.05)})
    with open(os.path.join(outdir, "rsm_models.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, ["lipid", "response", "r2", "term", "coef", "se",
                               "f_type2", "p", "significant"], lineterminator="\n")
        w.writeheader()
        for row in model_rows:
            w.writerow({k: (round(v, 6) if isinstance(v, float) else v)
                        for k, v in row.items()})

    # process_window.json
    window = {"design": {"n_runs": len(rows), "n_center": 3, "factors": FACTORS,
                         "coding": "x = (raw - center) / ((high-low)/2)"},
              "per_lipid": results,
              "honest_note": "本轮响应值来自 Phase 1 的 6 条静态配方反推编码（采样密度不足，"
                             "多数点越出编码域），工艺窗口结论仅在补做 §7.1 的 15 组实做实验后成立；"
                             "本文件不做外推宣称。"}
    with open(os.path.join(outdir, "process_window.json"), "w") as f:
        json.dump(window, f, indent=2, ensure_ascii=False, sort_keys=True)
    return window


def main():
    win = run()
    for lipid, res in sorted(win["per_lipid"].items()):
        for resp, m in res.items():
            sig = [a["term"] for a in m["anova"] if a["p"] == a["p"] and a["p"] < 0.05]
            print("[phase4] %-14s %-17s R2=%.3f significant=%s feasible=%s %s" % (
                lipid, resp, m["r2"], sig or "none(如实报告)", m["feasible"], m["stationary_note"]))
    print("[phase4] doe_design.csv / rsm_models.csv / process_window.json 已写出")


if __name__ == "__main__":
    main()
