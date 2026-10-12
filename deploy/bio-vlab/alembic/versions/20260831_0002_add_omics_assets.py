"""新增多组学数据资产表 omics_assets（增强报告 §3.2「多组学数据接入层」最小切片）

为多组学数据接入层提供统一资产登记表：OmicsAsset 统一模型承接
RNA-seq / scRNA-seq / 蛋白组 / 基因组 / 代谢组等原始数据上传登记，
文件二进制真实写入 MinIO（对象键 omics/{project_id}/{uuid}/{file_name}），
MinIO 不可用时回退本地存储（storage_type=local）。

新增表：
- omics_assets: 多组学数据资产表
  - id:              资产 ID（UUID 32 位无连字符十六进制）
  - project_id:      所属项目 ID（FK projects.id，NULL=平台级全局资产，admin-only 上传）
  - asset_type:      资产类型 rna_seq/scrna/proteomics/genomics/metabolomics
  - file_name:       原始文件名（已做路径穿越清洗）
  - file_format:     文件格式 fastq/h5ad/vcf/tsv/csv
  - storage_type:    存储类型 minio/local（本地回退模式）
  - bucket:          MinIO 桶名（storage_type=minio 时使用）
  - storage_uri:     存储地址（MinIO 对象键或本地相对路径）
  - size_bytes:      文件大小（字节）
  - sha256:          上传时 hashlib.sha256 真实计算的内容校验和
  - sample_metadata: 样本元数据（自由模式 JSON：sample_id/condition/tissue/species 等）
  - status:          资产状态 uploaded/parsed/failed/unavailable
                     （unavailable=解析依赖缺失如 anndata 未安装，明确状态而非假数据）
  - summary:         解析产出的真实统计（genes/samples/sparse_ratio 等 JSON）；
                     与 sample_metadata 语义分离故独立成列（见服务层评估说明）
  - lineage_ref:     谱系关联预留（JSON）
  - created_by:      上传人用户 ID（FK users.id，SET NULL）
  - created_at:      创建时间（TIMESTAMP(3) 毫秒精度）

新增索引：
- ix_omics_assets_project_id:  按项目检索资产
- ix_omics_assets_asset_type:  按资产类型检索
- ix_omics_assets_status:      按状态检索（待解析/失败队列）

回滚策略：整表删除（本迁移新增独立表，不承载既有业务数据）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260831_0002"
down_revision: Union[str, None] = "20260831_0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建多组学数据资产表 omics_assets 及三个检索索引"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建本表，已存在则整体跳过，保证迁移可安全重放
    if sa.inspect(op.get_bind()).has_table("omics_assets"):
        return
    op.create_table(
        "omics_assets",
        sa.Column("id", sa.String(length=36), nullable=False,
                  comment="UUID 主键"),
        sa.Column("project_id", sa.String(length=36), nullable=True,
                  comment="所属项目 ID（NULL=全局资产）"),
        sa.Column("asset_type", sa.String(length=50), nullable=False,
                  comment="资产类型：rna_seq/scrna/proteomics/genomics/metabolomics"),
        sa.Column("file_name", sa.String(length=255), nullable=False,
                  comment="原始文件名"),
        sa.Column("file_format", sa.String(length=50), nullable=False,
                  comment="文件格式：fastq/h5ad/vcf/tsv/csv"),
        sa.Column("storage_type", sa.String(length=20), nullable=False,
                  comment="存储类型：minio/local"),
        sa.Column("bucket", sa.String(length=100), nullable=True,
                  comment="MinIO 桶名"),
        sa.Column("storage_uri", sa.String(length=500), nullable=False,
                  comment="存储地址（对象键或本地相对路径）"),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False,
                  comment="文件大小（字节）"),
        sa.Column("sha256", sa.String(length=64), nullable=False,
                  comment="SHA256 内容校验和"),
        sa.Column("sample_metadata", sa.JSON(), nullable=True,
                  comment="样本元数据（JSON）"),
        sa.Column("status", sa.String(length=20), nullable=False,
                  comment="状态：uploaded/parsed/failed/unavailable"),
        sa.Column("summary", sa.JSON(), nullable=True,
                  comment="解析统计摘要（JSON）"),
        sa.Column("lineage_ref", sa.JSON(), nullable=True,
                  comment="谱系关联（预留 JSON）"),
        sa.Column("created_by", sa.String(length=36), nullable=True,
                  comment="上传人用户 ID"),
        sa.Column("created_at", mysql.TIMESTAMP(fsp=3), nullable=False,
                  comment="创建时间"),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"],
            ondelete="CASCADE", name="fk_omics_assets_project_id",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"],
            ondelete="SET NULL", name="fk_omics_assets_created_by",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    # 按项目检索资产（项目详情页资产列表）
    op.create_index("ix_omics_assets_project_id", "omics_assets",
                    ["project_id"])
    # 按资产类型检索（RNA-seq / 蛋白组等分类视图）
    op.create_index("ix_omics_assets_asset_type", "omics_assets",
                    ["asset_type"])
    # 按状态检索（待解析 parsed/failed 队列）
    op.create_index("ix_omics_assets_status", "omics_assets", ["status"])


def downgrade() -> None:
    """删除多组学数据资产表 omics_assets 及其索引"""
    op.drop_index("ix_omics_assets_status", table_name="omics_assets")
    op.drop_index("ix_omics_assets_asset_type", table_name="omics_assets")
    op.drop_index("ix_omics_assets_project_id", table_name="omics_assets")
    op.drop_table("omics_assets")
