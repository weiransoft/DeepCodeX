"""
新增 Docker 组件管理相关表（2026-07-29）

包含：
- docker_components: Docker 组件元数据与运行时状态
- docker_component_events: 组件生命周期事件
- docker_component_health_checks: 健康检查记录
- docker_scheduler_rules: 任务驱动的组件调度策略
- gpu_devices: GPU 设备信息缓存
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260729_0001"
down_revision: Union[str, None] = "20260713_0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建 Docker 组件管理相关表"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建本批表，已全部存在则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    if all(
        inspector.has_table(t)
        for t in (
            "docker_components",
            "docker_component_events",
            "docker_component_health_checks",
            "docker_scheduler_rules",
            "gpu_devices",
        )
    ):
        return


    # docker_components 表
    op.create_table(
        "docker_components",
        sa.Column("id", sa.String(length=36), nullable=False, comment="UUID 主键"),
        sa.Column(
            "component_id",
            sa.String(length=50),
            nullable=False,
            comment="组件业务唯一标识",
        ),
        sa.Column(
            "name", sa.String(length=200), nullable=False, comment="组件显示名称"
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, comment="是否启用"),
        sa.Column("category", sa.String(length=50), nullable=False, comment="组件类别"),
        sa.Column("provider", sa.String(length=100), nullable=True, comment="提供方"),
        sa.Column("tags", sa.JSON(), nullable=True, comment="标签列表"),
        sa.Column(
            "runtime_type", sa.String(length=30), nullable=False, comment="运行时类型"
        ),
        sa.Column("runtime_config", sa.JSON(), nullable=False, comment="运行时配置"),
        sa.Column(
            "lifecycle_config", sa.JSON(), nullable=False, comment="生命周期配置"
        ),
        sa.Column(
            "healthcheck_config", sa.JSON(), nullable=True, comment="健康检查配置"
        ),
        sa.Column("resources_config", sa.JSON(), nullable=True, comment="资源限额配置"),
        sa.Column("env", sa.JSON(), nullable=True, comment="环境变量模板"),
        sa.Column("volumes", sa.JSON(), nullable=True, comment="挂载卷配置"),
        sa.Column("dependencies", sa.JSON(), nullable=True, comment="依赖组件列表"),
        sa.Column("metadata", sa.JSON(), nullable=True, comment="组件元数据"),
        sa.Column(
            "auto_stop_enabled",
            sa.Boolean(),
            nullable=False,
            comment="是否允许空闲自动停止",
        ),
        sa.Column(
            "is_resident", sa.Boolean(), nullable=False, comment="是否为常驻组件"
        ),
        sa.Column("status", sa.String(length=20), nullable=False, comment="当前状态"),
        sa.Column(
            "container_id",
            sa.String(length=100),
            nullable=True,
            comment="容器 ID 或进程 PID",
        ),
        sa.Column(
            "allocated_gpus",
            sa.JSON(),
            nullable=True,
            comment="当前分配的 GPU 设备索引",
        ),
        sa.Column(
            "last_health_check_at",
            mysql.TIMESTAMP(fsp=3),
            nullable=True,
            comment="最近一次健康检查时间",
        ),
        sa.Column(
            "last_health_check_result",
            sa.JSON(),
            nullable=True,
            comment="最近一次健康检查结果",
        ),
        sa.Column(
            "config_file_path",
            sa.String(length=500),
            nullable=True,
            comment="来源配置文件路径",
        ),
        sa.Column(
            "created_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            comment="创建时间",
        ),
        sa.Column(
            "updated_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            comment="更新时间",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("component_id", name="ix_docker_components_component_id"),
        sa.Index("ix_docker_components_status", "status"),
        sa.Index("ix_docker_components_category", "category"),
        sa.Index("ix_docker_components_enabled", "enabled"),
        comment="Docker 组件表",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # docker_component_events 表
    op.create_table(
        "docker_component_events",
        sa.Column("id", sa.String(length=36), nullable=False, comment="UUID 主键"),
        sa.Column(
            "component_id", sa.String(length=36), nullable=False, comment="关联组件 ID"
        ),
        sa.Column(
            "event_type", sa.String(length=50), nullable=False, comment="事件类型"
        ),
        sa.Column("status", sa.String(length=20), nullable=False, comment="事件状态"),
        sa.Column("message", sa.Text(), nullable=True, comment="事件描述"),
        sa.Column("detail", sa.JSON(), nullable=True, comment="事件详情"),
        sa.Column(
            "user_id", sa.String(length=36), nullable=True, comment="触发用户 ID"
        ),
        sa.Column(
            "ip_address", sa.String(length=45), nullable=True, comment="操作者 IP"
        ),
        sa.Column(
            "created_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            comment="事件发生时间",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["component_id"], ["docker_components.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.Index("ix_docker_component_events_component_id", "component_id"),
        sa.Index("ix_docker_component_events_event_type", "event_type"),
        sa.Index("ix_docker_component_events_created_at", "created_at"),
        comment="Docker 组件事件表",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # docker_component_health_checks 表
    op.create_table(
        "docker_component_health_checks",
        sa.Column("id", sa.String(length=36), nullable=False, comment="UUID 主键"),
        sa.Column(
            "component_id", sa.String(length=36), nullable=False, comment="关联组件 ID"
        ),
        sa.Column("is_healthy", sa.Boolean(), nullable=False, comment="是否健康"),
        sa.Column("latency_ms", sa.Float(), nullable=True, comment="检查耗时毫秒"),
        sa.Column("error_message", sa.Text(), nullable=True, comment="错误信息"),
        sa.Column(
            "checked_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            comment="检查时间",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(
            ["component_id"], ["docker_components.id"], ondelete="CASCADE"
        ),
        sa.Index("ix_docker_component_health_checks_component_id", "component_id"),
        sa.Index("ix_docker_component_health_checks_checked_at", "checked_at"),
        comment="Docker 组件健康检查记录表",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # docker_scheduler_rules 表
    op.create_table(
        "docker_scheduler_rules",
        sa.Column("id", sa.String(length=36), nullable=False, comment="UUID 主键"),
        sa.Column("name", sa.String(length=200), nullable=False, comment="策略名称"),
        sa.Column(
            "workflow_types", sa.JSON(), nullable=True, comment="触发任务类型列表"
        ),
        sa.Column(
            "component_ids", sa.JSON(), nullable=False, comment="目标组件 ID 列表"
        ),
        sa.Column("mode", sa.String(length=20), nullable=False, comment="调度模式"),
        sa.Column(
            "idle_shutdown_minutes",
            sa.Integer(),
            nullable=True,
            comment="空闲自动停止时间（分钟）",
        ),
        sa.Column(
            "cron_expression",
            sa.String(length=100),
            nullable=True,
            comment="Cron 表达式",
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False, comment="是否启用"),
        sa.Column(
            "created_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            comment="创建时间",
        ),
        sa.Column(
            "updated_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            comment="更新时间",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.Index("ix_docker_scheduler_rules_enabled", "enabled"),
        sa.Index("ix_docker_scheduler_rules_mode", "mode"),
        comment="Docker 组件调度策略表",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # gpu_devices 表
    op.create_table(
        "gpu_devices",
        sa.Column("id", sa.String(length=36), nullable=False, comment="UUID 主键"),
        sa.Column("device_index", sa.Integer(), nullable=False, comment="设备索引"),
        sa.Column(
            "device_uuid", sa.String(length=100), nullable=False, comment="设备唯一标识"
        ),
        sa.Column("name", sa.String(length=200), nullable=False, comment="GPU 型号"),
        sa.Column("vendor", sa.String(length=20), nullable=False, comment="厂商"),
        sa.Column("memory_total_mb", sa.Integer(), nullable=True, comment="总显存 MB"),
        sa.Column("memory_used_mb", sa.Integer(), nullable=True, comment="已用显存 MB"),
        sa.Column(
            "utilization_percent", sa.Float(), nullable=True, comment="利用率百分比"
        ),
        sa.Column(
            "driver_version", sa.String(length=100), nullable=True, comment="驱动版本"
        ),
        sa.Column(
            "runtime_version",
            sa.String(length=100),
            nullable=True,
            comment="运行时版本",
        ),
        sa.Column("components", sa.JSON(), nullable=True, comment="当前占用组件列表"),
        sa.Column(
            "collected_at",
            mysql.TIMESTAMP(fsp=3),
            server_default=sa.text("CURRENT_TIMESTAMP(3)"),
            comment="采集时间",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("device_uuid", name="ix_gpu_devices_device_uuid"),
        sa.Index("ix_gpu_devices_vendor", "vendor"),
        comment="GPU 设备信息缓存表",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )


def downgrade() -> None:
    """回滚：删除 Docker 组件管理相关表"""
    op.drop_table("gpu_devices")
    op.drop_table("docker_scheduler_rules")
    op.drop_table("docker_component_health_checks")
    op.drop_table("docker_component_events")
    op.drop_table("docker_components")
