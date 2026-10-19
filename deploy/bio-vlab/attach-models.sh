#!/usr/bin/env bash
# =============================================================================
# 将本机模型容器接入应用栈网络（同机部署形态必需，2026-10-10）
#
# 背景（实测根因）：
#   本部署形态下应用栈与模型服务在同一台机器（10.101.20.20/30 均本机）。
#   backend/celery-worker 容器若经宿主 IP:已发布端口 访问模型服务
#   （如 http://10.101.20.30:8011），流量路径 = 容器 → 宿主 INPUT →
#   docker-proxy DNAT → 回容器，而宿主 INPUT 链 policy DROP 且未放行
#   容器网段新流，另外跨 docker 网络还有 DOCKER-ISOLATION-STAGE-* DROP
#   —— 两条路都被内核防火墙静默丢包（表现为 curl 超时，非拒绝）。
#
#   唯一免改防火墙的通路：让模型容器加入应用栈同一 user-defined bridge
#   （bio-net），backend 按容器名直连（容器名 DNS + 同网直连不经过宿主
#   INPUT 与隔离链）。实测 boltz/genosm-cuda/opendde-gateway/alphafold3
#   接入后从 bio-backend 内 curl 全部 200。
#
# 用法：
#   在 docker compose up -d 之后执行（幂等，可重复执行）；模型容器如被
#   重建（docker rm/run 或 compose up --force-recreate），需重新执行。
#     cd /root/bio/appserver-deploy && ./attach-models.sh
#
# 配套 .env 指向（生产已改）：
#   BOLTZ_HOST=boltz
#   OPENDDE_HOST=opendde-gateway
#   GENOSM_API_URL=http://genosm-cuda:8011
#   AF3_HOST=alphafold3
# 拆机部署（应用机 ≠ GPU 机）时改回对方 IP，无需本脚本。
# =============================================================================
set -euo pipefail

NETWORK="${STACK_NETWORK:-appserver-deploy_bio-net}"
MODELS="${MODEL_CONTAINERS:-boltz genosm-cuda opendde-gateway alphafold3}"

for c in $MODELS; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
    echo "SKIP  $c（未运行）"
    continue
  fi
  if docker inspect "$c" -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}
{{end}}' | grep -qx "$NETWORK"; then
    echo "OK    $c 已在 $NETWORK"
  else
    docker network connect "$NETWORK" "$c"
    echo "ADD   $c -> $NETWORK"
  fi
done

# 自检：从 bio-backend 逐个探测已接入容器
if docker ps --format '{{.Names}}' | grep -qx bio-backend; then
  echo "--- 自检（bio-backend 内直连） ---"
  docker exec bio-backend sh -c '
    for u in http://boltz:8000/health http://genosm-cuda:8011/health \
             http://opendde-gateway:8090/health http://alphafold3:8092/health; do
      printf "%-42s " "$u"
      curl -sS -o /dev/null -w "%{http_code}\n" --max-time 4 "$u" 2>/dev/null || echo FAIL
    done'
fi
