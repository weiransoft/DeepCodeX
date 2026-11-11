"""OpenDDE REST 契约适配网关

为 bio-vlab backend 的 OpenDDETool 提供其期望的 REST 契约：
  GET  /health                       -> 200（探针 ready 判定）
  POST /api/predict                  -> {job_id}          （入参 input/model/sample/step/cycle...）
  GET  /api/predict/{job_id}         -> {status, pdb_content, plddt, ptm, iptm, ...}
  POST /api/predict/{job_id}/cancel  -> 200

底层以子进程串行调用镜像自带 `opendde pred` CLI（A800 GPU 单机串行）。
status 词表与 backend OpenDDEJobStatus 对齐：pending/running/completed/failed/cancelled。
completed 时内嵌 pdb_content（PDB 文本，B-factor 列即 pLDDT），跨容器免文件共享。
"""
from __future__ import annotations

import asyncio
import glob
import json
import os
import shutil
import signal
import time
import uuid
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

APP_ROOT = os.environ.get("OPENDDE_GATEWAY_WORK", "/work")
CKPT_V1 = os.environ.get("OPENDDE_CKPT_V1", "/opendde_data/checkpoint/opendde.pt")
CKPT_ABAG = os.environ.get("OPENDDE_CKPT_ABAG", "")
OPENDDE_BIN = os.environ.get("OPENDDE_BIN", "opendde")
MAX_JOBS_KEPT = int(os.environ.get("OPENDDE_GATEWAY_MAX_JOBS", "200"))

app = FastAPI(title="OpenDDE Contract Gateway")

# job_id -> 状态记录（内存态；重启丢队列可接受，调用方轮询会拿到 404 并按失败降级）
JOBS: Dict[str, Dict[str, Any]] = {}
_PROC: Optional[asyncio.subprocess.Process] = None
_PROC_JOB: Optional[str] = None
_LOCK = asyncio.Lock()


class PredictReq(BaseModel):
    input: Any  # AF3 风格 JSON 数组（backend to_input_json 输出），直接落盘喂 CLI
    model: str = "opendde_v1"
    use_msa: bool = False
    use_template: bool = False
    use_rna_msa: bool = False
    sample: int = 1
    step: int = 200
    cycle: int = 10


def _ckpt_for(model: str) -> Optional[str]:
    if model == "opendde_abag" and CKPT_ABAG and os.path.exists(CKPT_ABAG):
        return CKPT_ABAG
    if CKPT_V1 and os.path.exists(CKPT_V1):
        return CKPT_V1
    return None  # 交给 CLI 依 OPENDDE_ROOT_DIR 自行解析


def _mean_plddt_from_pdb(path: str) -> Optional[float]:
    vals = []
    try:
        with open(path) as f:
            for line in f:
                if line.startswith(("ATOM", "HETATM")):
                    try:
                        vals.append(float(line[60:66]))
                    except ValueError:
                        pass
    except OSError:
        return None
    return round(sum(vals) / len(vals), 2) if vals else None


def _collect_result(job_dir: str) -> Dict[str, Any]:
    """在任务输出目录递归找 PDB 结构与置信度文件并归一化。"""
    out: Dict[str, Any] = {}
    pdbs = sorted(glob.glob(f"{job_dir}/**/*.pdb", recursive=True))
    cifs = sorted(glob.glob(f"{job_dir}/**/*.cif", recursive=True))
    confs = sorted(glob.glob(f"{job_dir}/**/*confidence*.json", recursive=True))
    struct = pdbs[0] if pdbs else (cifs[0] if cifs else None)
    if not struct:
        raise FileNotFoundError(f"未在 {job_dir} 找到结构文件(.pdb/.cif)")
    out["structure_file"] = struct
    if struct.endswith(".pdb"):
        with open(struct, encoding="utf-8", errors="replace") as f:
            out["pdb_content"] = f.read()
    else:  # cif → mmcif_data 位（backend finalize 对 opendde 分支读 pdb_content，此处双写）
        with open(struct, encoding="utf-8", errors="replace") as f:
            out["pdb_content"] = f.read()
    plddt = _mean_plddt_from_pdb(struct) if struct.endswith(".pdb") else None
    ptm = iptm = None
    for cf in confs:
        try:
            with open(cf) as f:
                cj = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        if "ptm" in cj:
            ptm = float(cj["ptm"])
        if "iptm" in cj:
            iptm = float(cj["iptm"])
        # opendde/AF3 summary_confidence 顶层 plddt 字段（官方输出格式）
        for key in ("plddt", "confidence"):
            c = cj.get(key)
            if plddt is None and isinstance(c, (int, float)):
                plddt = round(float(c), 2)
    out["plddt"] = plddt
    out["ptm"] = ptm
    out["iptm"] = iptm
    out["output_dir"] = job_dir
    return out


async def _run_job(job_id: str, req: PredictReq) -> None:
    global _PROC, _PROC_JOB
    JOBS[job_id]["_thread_started"] = True
    job_dir = os.path.join(APP_ROOT, job_id)
    os.makedirs(job_dir, exist_ok=True)
    input_file = os.path.join(job_dir, "input.json")
    with open(input_file, "w", encoding="utf-8") as f:
        json.dump(req.input, f)
    ck = _ckpt_for(req.model)
    cmd = [
        OPENDDE_BIN, "pred",
        "-i", input_file,
        "-o", job_dir,
        "-n", req.model,
        "--use_msa", str(bool(req.use_msa)).lower(),
        "--use_template", str(bool(req.use_template)).lower(),
        "--use_rna_msa", str(bool(req.use_rna_msa)).lower(),
        "--sample", str(req.sample),
        "--step", str(req.step),
        "--cycle", str(req.cycle),
    ]
    if ck:
        cmd += ["--load_checkpoint_path", ck]
    JOBS[job_id]["status"] = "running"
    JOBS[job_id]["started_at"] = time.time()
    try:
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=open(os.path.join(job_dir, "stdout.log"), "wb"),
                stderr=open(os.path.join(job_dir, "stderr.log"), "wb"),
            )
        except FileNotFoundError:
            rec = JOBS.get(job_id) or {}
            rec["status"] = "failed"
            rec["error_message"] = f"opendde 可执行文件不存在: {OPENDDE_BIN}"
            return
        _PROC, _PROC_JOB = proc, job_id
        rc = await proc.wait()
        _PROC, _PROC_JOB = None, None
        rec = JOBS.get(job_id) or {}
        if rec.get("cancel_requested"):
            rec["status"] = "cancelled"
            return
        if rc != 0:
            tail = ""
            try:
                tail = open(os.path.join(job_dir, "stderr.log"), errors="replace").read()[-800:]
            except OSError:
                pass
            rec["status"] = "failed"
            rec["error_message"] = f"opendde pred rc={rc}: {tail}"
            return
        rec.update(_collect_result(job_dir))
        rec["status"] = "completed"
        rec["elapsed_seconds"] = round(time.time() - rec.get("started_at", time.time()), 1)
    except FileNotFoundError as e:  # collect 找不到结构
        rec = JOBS.get(job_id) or {}
        rec["status"] = "failed"
        rec["error_message"] = str(e)
    except Exception as e:  # noqa: BLE001
        _PROC, _PROC_JOB = None, None
        rec = JOBS.get(job_id) or {}
        rec["status"] = "failed"
        rec["error_message"] = f"{type(e).__name__}: {e}"
    finally:
        _gc_jobs()
        # P1-fix(2026-10-07): 前序任务结束后自动拉起排队中的队首任务。
        # 原实现仅在 POST /api/predict 且即时空闲时启动，GPU 忙时入队的
        # pending 任务永远不会被启动（孤儿 pending，调用方轮询到超时）。
        _start_next_queued()


def _start_next_queued() -> None:
    import asyncio as _a

    pending = [
        j for j, r in sorted(JOBS.items(), key=lambda kv: kv[1].get("created_at", 0))
        if r.get("status") == "pending" and not r.get("_thread_started")
        and not r.get("cancel_requested") and r.get("req") is not None
    ]
    if not pending:
        return
    if _PROC is not None and _PROC.returncode is None:
        return
    job_id = pending[0]
    req = JOBS[job_id].pop("req")
    task = _a.get_event_loop().create_task(_run_job(job_id, req))
    task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)


def _gc_jobs() -> None:
    if len(JOBS) <= MAX_JOBS_KEPT:
        return
    done = sorted(
        (jid for jid, r in JOBS.items() if r.get("status") in ("completed", "failed", "cancelled")),
        key=lambda j: JOBS[j].get("created_at", 0),
    )
    for jid in done[: len(JOBS) - MAX_JOBS_KEPT]:
        JOBS.pop(jid, None)
        shutil.rmtree(os.path.join(APP_ROOT, jid), ignore_errors=True)


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {
        "status": "healthy",
        "service": "opendde-gateway",
        "gpu": os.environ.get("NVIDIA_VISIBLE_DEVICES", "all"),
        "active_job": _PROC_JOB,
        "jobs": len(JOBS),
    }


@app.post("/api/predict")
async def predict(req: PredictReq) -> Dict[str, Any]:
    global _PROC_JOB
    job_id = uuid.uuid4().hex[:16]
    JOBS[job_id] = {
        "status": "pending", "created_at": time.time(), "cancel_requested": False,
        "req": req,
    }
    _gc_jobs()
    async with _LOCK:
        # 串行 GPU：前序任务运行中则保持 pending，由其 finally 钩子接力启动
        if _PROC is not None and _PROC.returncode is None:
            return {"job_id": job_id, "status": "pending", "queued": True}
        # FIFO：更早的排队任务未消费完则继续入队等待（created_at 排序）
        if any(
            jid != job_id and r.get("status") == "pending" and not r.get("_thread_started")
            and r.get("created_at", 0) < JOBS[job_id]["created_at"]
            for jid, r in JOBS.items()
        ):
            return {"job_id": job_id, "status": "pending", "queued": True}
        JOBS[job_id]["_thread_started"] = True
        queued = any(
            r.get("status") == "pending" and not r.get("_thread_started")
            for jid, r in JOBS.items() if jid != job_id
        )
        JOBS[job_id].pop("req", None)
        task = asyncio.create_task(_run_job(job_id, req))
        task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
    return {"job_id": job_id, "status": "pending", "queued": queued}


@app.get("/api/predict/{job_id}")
async def get_job(job_id: str) -> Dict[str, Any]:
    rec = JOBS.get(job_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="job not found")
    body: Dict[str, Any] = {
        "job_id": job_id,
        "status": rec.get("status"),
        "output_dir": rec.get("output_dir"),
        "structure_file": rec.get("structure_file"),
        "pdb_content": rec.get("pdb_content"),
        "plddt": rec.get("plddt"),
        "ptm": rec.get("ptm"),
        "iptm": rec.get("iptm"),
        "elapsed_seconds": rec.get("elapsed_seconds"),
        "error_message": rec.get("error_message"),
    }
    if rec.get("status") == "pending":
        async with _LOCK:
            if _PROC is not None and _PROC.returncode is None:
                body["queued"] = True
    return body


@app.post("/api/predict/{job_id}/cancel")
async def cancel_job(job_id: str) -> Dict[str, Any]:
    rec = JOBS.get(job_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="job not found")
    if rec.get("status") in ("completed", "failed", "cancelled"):
        return {"job_id": job_id, "status": rec["status"], "cancelled": False}
    rec["cancel_requested"] = True
    global _PROC, _PROC_JOB
    async with _LOCK:
        if _PROC is not None and _PROC_JOB == job_id and _PROC.returncode is None:
            try:
                os.killpg(os.getpgid(_PROC.pid), signal.SIGKILL)
            except OSError:
                _PROC.kill()
    if rec.get("status") in ("pending", "queued"):
        rec["status"] = "cancelled"
    return {"job_id": job_id, "status": rec.get("status"), "cancelled": True}


@app.post("/api/predict/{job_id}/result")
async def get_result(job_id: str) -> Dict[str, Any]:
    return await get_job(job_id)
