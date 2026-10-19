"""VaxLab Phase 4/5 全链路回归测试（python3 -m unittest，零依赖，已知答案锁死口径）。

覆盖（对应开发计划 §6）：
  1. t / F 分布尾概率（含对照值）
  2. Mann-Whitney U 精确值与 Fisher 精确检验已知答案
  3. 4PL 变量投影 NLS 还原合成真值（ED50=8.0, b=1.5, top=80, bot=0）
  4. Box-Behnken 平衡性 + RSM 恢复已知系数
  5. doe_design.csv 落盘：15 行、水平均衡、3 中心点
  6. 终点滴度线性插值 = 3.43（§3.4 锚点 1）
  7. GMT 倍数变化
  8. 一次完整 5 阶段管线运行 + 报告一致性 + 两次运行逐字节确定性
"""

import csv
import hashlib
import json
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from phase4 import doe_rsm  # noqa: E402
from phase5 import immunogenicity_stats as imm  # noqa: E402


class TestDistributions(unittest.TestCase):
    def test_t_and_f_tail_probabilities(self):
        # t(10) 双侧 p=0.05 临界 2.228 → 尾概率回到 ~0.05
        self.assertAlmostEqual(imm.t_sf_two_sided(2.228, 10), 0.05, delta=2e-3)
        # F(1,7) 在 f=5.59 → p≈0.05；f=12.25 → p≈0.01
        self.assertAlmostEqual(imm.f_sf(5.59, 1, 7), 0.05, delta=2e-3)
        self.assertAlmostEqual(imm.f_sf(12.25, 1, 7), 0.01, delta=1e-3)
        # betai(1,1,x) = x（均匀分布恒等式）
        self.assertAlmostEqual(imm.betai(1.0, 1.0, 0.37), 0.37, places=12)


class TestExactTests(unittest.TestCase):
    def test_mannwhitney_known_values(self):
        # 3v3 完全分离 → 精确双侧 p = 0.1
        self.assertAlmostEqual(imm.mannwhitney_u([4, 5, 6], [1, 2, 3])["p"], 0.1, places=4)
        # 4v4 完全分离 → 0.0286
        self.assertAlmostEqual(imm.mannwhitney_u([5, 6, 7, 8], [1, 2, 3, 4])["p"], 0.0286, places=4)
        r = imm.mannwhitney_u([8.75, 13.4, 14.9, 16.1, 20.37], [2.737, 3.237, 3.737, 4.237, 4.737])
        self.assertEqual(r["U"], 0.0)
        self.assertAlmostEqual(r["p"], 0.00794, places=4)  # 5v5 U=0 精确双侧
        self.assertEqual(r["p_method"], "exact")

    def test_fisher_exact(self):
        # 8/10 vs 2/10，1 尾精确值 = [C(10,8)C(10,2)+C(10,9)C(10,1)+C(10,10)C(10,0)]/C(20,10)
        # = 2126/184756 = 0.011507。注：计划文档 §3.4 锚点 0.0167 不能由超几何精确式复现，
        # 依诚实性条款以真实计算值锁死口径。
        self.assertAlmostEqual(imm.fisher_exact_1sided(8, 2, 2, 8), 2126.0 / 184756.0, places=10)
        # 10/10 vs 0/10 → p = 1/C(20,10) = 5.4e-6
        self.assertAlmostEqual(imm.fisher_exact_1sided(10, 0, 0, 10),
                               1.0 / 184756.0, places=8)


class TestFourPL(unittest.TestCase):
    def test_recovers_synthetic_truth(self):
        xs = [float(i) for i in range(2, 15)]
        ys = [80.0 / (1.0 + 2.0 ** (-1.5 * (x - 8.0))) for x in xs]
        f = imm.four_pl(xs, ys)
        self.assertAlmostEqual(f["ED50_log2dose"], 8.0, delta=0.05)   # 真值 8.000
        self.assertAlmostEqual(f["hill_b"], 1.5, delta=0.05)          # 真值 1.500
        self.assertAlmostEqual(f["top"], 80.0, delta=0.5)
        self.assertAlmostEqual(f["bottom"], 0.0, delta=0.5)
        self.assertGreater(f["r2"], 0.999)


class TestDoEAndRSM(unittest.TestCase):
    def test_box_behnken_balance(self):
        bb = doe_rsm.box_behnken()
        self.assertEqual(len(bb), 15)
        # 12 个互异轴向点 + 3 个刻意重复的中心点（中心重复是 BB 设计要素）
        self.assertEqual(len(set(map(tuple, bb))), 13)
        self.assertEqual(sum(1 for x in bb if x == [0.0, 0.0, 0.0]), 3)  # 3 中心点
        for col in range(3):
            vals = [row[col] for row in bb]
            self.assertEqual(vals.count(1.0), 4)                # 每因素每水平 4 次（轴向）
            self.assertEqual(vals.count(-1.0), 4)

    def test_rsm_recovers_coefficients(self):
        # 用已知系数生成无噪声数据，验证最小二乘恢复
        beta = [10.0, 2.0, -1.0, 0.5, 0.3, -0.2, 0.1, -0.8, -0.4, -0.6]
        X = [doe_rsm._row(*x) for x in doe_rsm.box_behnken()]
        y = [sum(b * r for b, r in zip(beta, xr)) for xr in X]
        fit = doe_rsm.fit_quadratic(X, y)
        self.assertGreater(fit["r2"], 0.999999)
        for i in (1, 2, 3, 7, 8, 9):
            self.assertAlmostEqual(fit["coefs"][i], beta[i], places=5)


class TestDesignFile(unittest.TestCase):
    def test_doe_design_csv(self):
        doe_rsm.run(ROOT)
        with open(os.path.join(ROOT, "phase4", "doe_design.csv")) as f:
            rows = list(csv.DictReader(f))
        self.assertEqual(len(rows), 15)
        self.assertEqual(sum(1 for r in rows if float(r["x1_np"]) == 0.0
                             and float(r["x2_flow"]) == 0.0
                             and float(r["x3_ethanol"]) == 0.0), 3)
        for col, lo, hi in (("np_ratio", 4, 10), ("flow_ratio", 30, 60), ("ethanol_pct", 10, 50)):
            vals = [float(r[col]) for r in rows]
            self.assertTrue(all(lo - 1e-9 <= v <= hi + 1e-9 for v in vals), col)


class TestSerology(unittest.TestCase):
    def test_endpoint_titre_anchor(self):
        # §3.4 锚点 1：cut-off = 2.1 × 阴性均值 OD
        t, c = imm.endpoint_titre([(1, 0.85), (2, 0.60), (3, 0.35), (4, 0.024), (5, 0.012)], 0.10)
        self.assertAlmostEqual(c, 0.21, places=10)
        self.assertAlmostEqual(t, 3.43, places=2)

    def test_gmt_fold_change(self):
        g = imm.gmt([4.0, 5.0, 6.0], [1.0, 2.0, 3.0])
        self.assertAlmostEqual(g["GMT_immunized"], 2.0 ** 5.0, places=9)
        self.assertAlmostEqual(g["fold_change_vs_control"], 8.0, places=9)  # 2^(5-2)


class TestPipelineEndToEnd(unittest.TestCase):
    def test_full_run_report_and_determinism(self):
        import run_pipeline
        rep1 = run_pipeline.run(ROOT)
        h1 = hashlib.sha256(open(os.path.join(ROOT, "output", "pipeline_report.json"), "rb").read()).hexdigest()
        rep2 = run_pipeline.run(ROOT)
        h2 = hashlib.sha256(open(os.path.join(ROOT, "output", "pipeline_report.json"), "rb").read()).hexdigest()
        # 确定性：两次运行报告逐字节一致
        self.assertEqual(h1, h2)
        # 结构与一致性
        self.assertEqual(rep1["run_id"], "vaxlab-5phase-v2")
        self.assertEqual([p["id"] for p in rep1["phases"]], [1, 2, 3, 4, 5])
        self.assertTrue(rep1["overall_pass"])
        self.assertTrue(all(g["pass"] for g in rep1["gates"]))
        p2 = rep1["phases"][1]
        self.assertEqual(p2["length_nt"], 1620)  # 539 aa + 终止 = 540 密码子 = 1620 nt
        self.assertTrue(0.45 <= p2["gc"] <= 0.55)
        best = rep1["phases"][0]["best"]
        self.assertTrue(70 <= best["ea"] <= 80)
        # 磁盘报告与返回值一致
        disk = json.load(open(os.path.join(ROOT, "output", "pipeline_report.json")))
        self.assertEqual(disk["overall_pass"], rep1["overall_pass"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
