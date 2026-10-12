"""
新增远程 GPU 节点 Host 与镜像仓库 ContainerRegistry 表，并扩展 Docker 组件与 GPU 设备外键

包含：
- hosts: 远程 GPU 节点连接信息、mTLS 证书元数据
- container_registries: Harbor 等私有镜像仓库凭据（密码加密存储）
- docker_components: 新增 host_id / registry_id 外键
- gpu_devices: 新增 host_id 外键
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260730_0001"
down_revision: Union[str, None] = "20260729_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建 Host、ContainerRegistry 表，并为 Docker 组件和 GPU 设备添加外键关联"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建本批表与列，已全部就位则整体跳过，保证迁移可安全重放
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("hosts") and inspector.has_table("container_registries"):
        dc_cols = {c["name"] for c in inspector.get_columns("docker_components")}
        gd_cols = {c["name"] for c in inspector.get_columns("gpu_devices")}
        if "host_id" in dc_cols and "registry_id" in dc_cols and "host_id" in gd_cols:
            return


    # hosts 表
    op.create_table(
        "hosts",
        sa.Column("id", sa.String(length=32), nullable=False, comment="UUID 主键"),
        sa.Column(
            "name", sa.String(length=128), nullable=False, comment="节点显示名称"
        ),
        sa.Column(
            "hostname", sa.String(length=256), nullable=False, comment="内网 IP 或域名"
        ),
        sa.Column("port", sa.Integer(), nullable=True, comment="Agent 服务端口"),
        sa.Column("is_local", sa.Boolean(), nullable=True, comment="是否为本地伪节点"),
        sa.Column("status", sa.String(length=32), nullable=True, comment="节点状态"),
        sa.Column("labels", sa.JSON(), nullable=True, comment="节点标签列表"),
        sa.Column(
            "ca_cert_path",
            sa.String(length=512),
            nullable=True,
            comment="CA 证书文件路径",
        ),
        sa.Column(
            "server_cert_path",
            sa.String(length=512),
            nullable=True,
            comment="服务端证书文件路径",
        ),
        sa.Column(
            "server_key_path",
            sa.String(length=512),
            nullable=True,
            comment="服务端私钥文件路径（仅路径）",
        ),
        sa.Column(
            "client_cert_path",
            sa.String(length=512),
            nullable=True,
            comment="客户端证书文件路径",
        ),
        sa.Column(
            "client_key_path",
            sa.String(length=512),
            nullable=True,
            comment="客户端私钥文件路径（仅路径）",
        ),
        sa.Column("ca_cert_pem", sa.Text(), nullable=True, comment="CA 公钥证书 PEM"),
        sa.Column(
            "server_cert_pem", sa.Text(), nullable=True, comment="服务端公钥证书 PEM"
        ),
        sa.Column(
            "client_cert_pem", sa.Text(), nullable=True, comment="客户端公钥证书 PEM"
        ),
        sa.Column(
            "cert_serial", sa.String(length=64), nullable=True, comment="证书序列号"
        ),
        sa.Column(
            "cert_not_before",
            mysql.TIMESTAMP(fsp=3),
            nullable=True,
            comment="证书生效时间",
        ),
        sa.Column(
            "cert_not_after",
            mysql.TIMESTAMP(fsp=3),
            nullable=True,
            comment="证书过期时间",
        ),
        sa.Column(
            "cert_auto_rotate", sa.Boolean(), nullable=True, comment="是否自动轮换证书"
        ),
        sa.Column(
            "cert_revoked", sa.Boolean(), nullable=True, comment="证书是否已吊销"
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
        sa.UniqueConstraint("name", name="ix_hosts_name"),
        sa.Index("ix_hosts_status", "status"),
        sa.Index("ix_hosts_is_local", "is_local"),
        comment="GPU 节点表",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # container_registries 表
    op.create_table(
        "container_registries",
        sa.Column("id", sa.String(length=32), nullable=False, comment="UUID 主键"),
        sa.Column(
            "name", sa.String(length=128), nullable=False, comment="仓库显示名称"
        ),
        sa.Column(
            "server_url",
            sa.String(length=512),
            nullable=False,
            comment="仓库服务器地址",
        ),
        sa.Column(
            "username", sa.String(length=256), nullable=False, comment="仓库登录用户名"
        ),
        sa.Column(
            "password_encrypted",
            sa.Text(),
            nullable=False,
            comment="AES-GCM 加密后的密码（JSON）",
        ),
        sa.Column("is_default", sa.Boolean(), nullable=True, comment="是否为默认仓库"),
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
        sa.UniqueConstraint("name", name="ix_container_registries_name"),
        comment="容器镜像仓库表",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )

    # docker_components 表新增 host_id / registry_id 列与外键
    op.add_column(
        "docker_components",
        sa.Column(
            "host_id",
            sa.String(length=32),
            nullable=True,
            comment="所属 GPU 节点 ID（空表示本地）",
        ),
    )
    op.add_column(
        "docker_components",
        sa.Column(
            "registry_id",
            sa.String(length=32),
            nullable=True,
            comment="使用的镜像仓库 ID",
        ),
    )
    op.create_foreign_key(
        "fk_docker_components_host_id",
        "docker_components",
        "hosts",
        ["host_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_docker_components_registry_id",
        "docker_components",
        "container_registries",
        ["registry_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_docker_components_host_id", "docker_components", ["host_id"])
    op.create_index(
        "ix_docker_components_registry_id", "docker_components", ["registry_id"]
    )

    # gpu_devices 表新增 host_id 列与外键
    op.add_column(
        "gpu_devices",
        sa.Column(
            "host_id",
            sa.String(length=32),
            nullable=True,
            comment="所属 GPU 节点 ID（空表示本地）",
        ),
    )
    op.create_foreign_key(
        "fk_gpu_devices_host_id",
        "gpu_devices",
        "hosts",
        ["host_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_gpu_devices_host_id", "gpu_devices", ["host_id"])


def downgrade() -> None:
    """回滚：删除新增外键、列与表"""

    # 回滚 gpu_devices 扩展
    op.drop_index("ix_gpu_devices_host_id", table_name="gpu_devices")
    op.drop_constraint("fk_gpu_devices_host_id", "gpu_devices", type_="foreignkey")
    op.drop_column("gpu_devices", "host_id")

    # 回滚 docker_components 扩展
    op.drop_index("ix_docker_components_registry_id", table_name="docker_components")
    op.drop_index("ix_docker_components_host_id", table_name="docker_components")
    op.drop_constraint(
        "fk_docker_components_registry_id", "docker_components", type_="foreignkey"
    )
    op.drop_constraint(
        "fk_docker_components_host_id", "docker_components", type_="foreignkey"
    )
    op.drop_column("docker_components", "registry_id")
    op.drop_column("docker_components", "host_id")

    # 回滚新增表
    op.drop_table("container_registries")
    op.drop_table("hosts")
