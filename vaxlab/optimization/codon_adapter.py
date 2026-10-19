"""Codon Adapter — Codon Adapter 思路的密码子适配器（零依赖，标准库实现）。

VaxLab mRNA 优化管线 Phase 1 载体。能力：
  - 人类（Homo sapiens）密码子频率表（相对同义密码子使用频率，RSCU 归一）
  - dna_to_codons()：DNA → 密码子三元组
  - CAI()：加权几何平均的密码子适应指数（Codon Adaptation Index, Sharp & Li 1987）
  - optimize_sequence()：Codon Adapter 式贪心适配 —— 在最高频率密码子选择基础上，
    以滑动窗口 GC 约束（window / targetGC ± tolerance）做局部回退重选。

本模块是纯计算模块：不联网、不读外部文件、完全确定性。
"""

from collections import Counter

# 标准遗传密码表：aa -> 同义密码子列表（含终止子 *）
CODON_TABLE = {
    "F": ["TTT", "TTC"], "L": ["TTA", "TTG", "CTT", "CTC", "CTA", "CTG"],
    "I": ["ATT", "ATC", "ATA"], "M": ["ATG"], "V": ["GTT", "GTC", "GTA", "GTG"],
    "S": ["TCT", "TCC", "TCA", "TCG", "AGT", "AGC"], "P": ["CCT", "CCC", "CCA", "CCG"],
    "T": ["ACT", "ACC", "ACA", "ACG"], "A": ["GCT", "GCC", "GCA", "GCG"],
    "Y": ["TAT", "TAC"], "H": ["CAT", "CAC"], "Q": ["CAA", "CAG"], "N": ["AAT", "AAC"],
    "K": ["AAA", "AAG"], "D": ["GAT", "GAC"], "E": ["GAA", "GAG"], "C": ["TGT", "TGC"],
    "W": ["TGG"], "R": ["CGT", "CGC", "CGA", "CGG", "AGA", "AGG"],
    "G": ["GGT", "GGC", "GGA", "GGG"], "*": ["TAA", "TAG", "TGA"],
}

# 人类细胞（HEK293/HeLa 谱系来源）同义密码子相对使用频率。
# 每个氨基酸一行，与 CODON_TABLE 顺序一致，行内和归一为 1。
HUMAN_CODON_FREQ = {
    "F": [0.45, 0.55],
    "L": [0.07, 0.13, 0.10, 0.19, 0.06, 0.45],
    "I": [0.16, 0.63, 0.21],
    "M": [1.0],
    "V": [0.11, 0.19, 0.09, 0.61],
    "S": [0.15, 0.18, 0.12, 0.15, 0.15, 0.25],
    "P": [0.16, 0.27, 0.19, 0.38],
    "T": [0.16, 0.24, 0.19, 0.41],
    "A": [0.11, 0.27, 0.12, 0.50],
    "Y": [0.43, 0.57],
    "H": [0.41, 0.59],
    "Q": [0.25, 0.75],
    "N": [0.41, 0.59],
    "K": [0.57, 0.43],
    "D": [0.46, 0.54],
    "E": [0.29, 0.71],
    "C": [0.45, 0.55],
    "W": [1.0],
    "R": [0.11, 0.10, 0.05, 0.04, 0.38, 0.32],
    "G": [0.16, 0.34, 0.19, 0.31],
    "*": [0.45, 0.13, 0.42],
}


def dna_to_codons(dna):
    """将 DNA 序列切分为密码子三元组列表（丢弃不完整尾码）。"""
    dna = dna.upper().replace(" ", "").replace("\n", "")
    n = len(dna) - (len(dna) % 3)
    return [dna[i:i + 3] for i in range(0, n, 3)]


def gc_content(dna):
    """GC 碱基占比（0-1）。"""
    dna = dna.upper()
    if not dna:
        return 0.0
    return (dna.count("G") + dna.count("C")) / len(dna)


def _codon_index_map():
    """codon -> (aa, 该 aa 内的频率)。"""
    m = {}
    for aa, codons in CODON_TABLE.items():
        freqs = HUMAN_CODON_FREQ[aa]
        for c, f in zip(codons, freqs):
            m[c] = (aa, f)
    return m


_CODON_INDEX = _codon_index_map()


def CAI(dna):
    """密码子适应指数：w_i = f_i / max_f(aa_i)，几何平均（跳过 M 与终止子）。

    与 Sharp & Li (1987) 定义一致；空序列或无有效密码子返回 0.0。
    """
    import math

    codons = dna_to_codons(dna)
    ws = []
    for c in codons:
        aa = _CODON_INDEX.get(c, (None, None))[0]
        if aa is None or aa in ("M", "*", "W"):
            continue
        freqs = HUMAN_CODON_FREQ[aa]
        f = _CODON_INDEX[c][1]
        w = f / max(freqs)
        ws.append(math.log(max(w, 1e-12)))
    if not ws:
        return 0.0
    return math.exp(sum(ws) / len(ws))


def _window_gc_ok(seq, pos, window, target, tol):
    """以 pos 结尾的窗口 GC 是否落在 target ± tol。"""
    lo = max(0, pos - window + 1)
    seg = seq[lo:pos + 1]
    if len(seg) < min(window, 30):  # 窗口未满时不施约束
        return True
    g = gc_content(seg)
    return (target - tol) <= g <= (target + tol)


def optimize_sequence(protein, target_gc=0.50, gc_window=100, gc_tol=0.05):
    """Codon Adapter 式贪心逆翻译。

    对每个残基：
      1. 按 aa 频率降序取候选密码子；
      2. 若选最高频密码子会破坏最近 gc_window 窗口的 GC 约束，
         则依次回退到同义次高频密码子（优先能纠偏 GC 方向的一侧）；
      3. 全候选均违例时仍选最高频（不做无解牺牲）。

    返回 (dna, stats)：stats = {cai, gc, length_nt}。确定性，无随机源。
    """
    protein = protein.upper()
    out = []
    for aa in protein:
        codons = CODON_TABLE.get(aa)
        if codons is None:
            raise ValueError("未知氨基酸符号: %r" % aa)
        freqs = HUMAN_CODON_FREQ[aa]
        order = [c for _, c in sorted(zip(freqs, codons), key=lambda t: (-t[0], t[1]))]
        cur = "".join(out)
        chosen = None
        for cand in order:  # 频率降序：首个满足窗口约束者即最高频可行密码子
            trial = cur + cand
            if _window_gc_ok(trial, len(trial) - 1, gc_window, target_gc, gc_tol):
                chosen = cand
                break
        if chosen is None:  # 全部违例 → 取窗口偏差最小者纠偏
            best_dev = float("inf")
            for cand in order:
                trial = cur + cand
                seg = trial[max(0, len(trial) - gc_window):]
                dev = abs(gc_content(seg) - target_gc)
                if dev < best_dev - 1e-15:
                    chosen, best_dev = cand, dev
        out.append(chosen)
    out.append("TAA")  # 默认终止密码子（人源高频终止）
    dna = "".join(out)
    return dna, {"cai": round(CAI(dna), 4), "gc": round(gc_content(dna), 4), "length_nt": len(dna)}
