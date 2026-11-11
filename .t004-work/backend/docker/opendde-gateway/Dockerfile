# OpenDDE 契约适配网关：在官方 opendde 镜像上叠加 FastAPI 契约层
# 契约与 bio-vlab backend OpenDDETool 对齐（/health、/api/predict*）
FROM aurekaresearch/opendde:v1

WORKDIR /code

RUN apt-get update && apt-get install -y --no-install-recommends python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir --break-system-packages \
       "fastapi>=0.115,<0.116" "uvicorn[standard]>=0.24"

COPY ./app /code/app

ENV OPENDDE_GATEWAY_WORK=/work \
    OPENDDE_CKPT_V1=/opendde_data/checkpoint/opendde.pt \
    TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1

EXPOSE 8090
# 单 worker：GPU 串行 + 内存态任务表要求单进程
CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "1"]
