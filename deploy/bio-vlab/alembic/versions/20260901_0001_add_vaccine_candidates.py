"""新增疫苗候选设计表 vaccine_candidates（D2 断点修复：疫苗设计组）

为疫苗设计 API（POST /api/v1/vaccine/design）提供候选登记表：
抗原序列经 IEDB 真实表位预测（bcell/mhc_i）后，产出表位列表与
规则启发式设计建议（佐剂/表位串联），以候选形式登记入库，
供项目内检索与后续湿实验（中和试验/ELISA 结合）验证衔接。

新增表：
- vaccine_candidates: 疫苗候选设计表
  - id:                       候选 ID（UUID 32 位无连字符十六进制）
  - project_id:               所属项目 ID（FK projects.id，NULL=平台级全局
                              候选，admin-only 创建）
  - pathogen_name:            病原体名称（如 "狂犬病毒" / "犬细小病毒"）
  - antigen_sequence_digest:  抗原序列摘要（JSON：{"sha256": <64 位十六进制>,
                              "length": <序列长度>}，不存全序列）
  - epitopes:                 表位预测结果与设计建议（JSON：peptides/top/
                              method/suggestions，epitope_tool 真实产出）
  - status:                   候选状态（designed；后续湿实验验证状态由
                              action_protocol / wetlab 回传链路扩展）
  - created_by:               创建人用户 ID（FK users.id，SET NULL）
  - created_at:               创建时间（TIMESTAMP(3) 毫秒精度）

新增索引：
- ix_vaccine_candidates_project_id:    按项目检索候选（项目详情页列表）
- ix_vaccine_candidates_pathogen_name: 按病原体检索（同病原多抗原对比）
- ix_vaccine_candidates_status:        按状态检索（设计队列视图）

回滚策略：整表删除（本迁移新增独立表，不承载既有业务数据）。
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql


# revision identifiers, used by Alembic.
revision: str = "20260901_0001"
down_revision: Union[str, None] = "20260831_0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """创建疫苗候选设计表 vaccine_candidates 及三个检索索引"""
    # 幂等守卫（2026-10-07 alembic 接入改造补）：init_db() create_all
    # 可能已预建本表，已存在则整体跳过，保证迁移可安全重放
    if sa.inspect(op.get_bind()).has_table("vaccine_candidates"):
        return
    op.create_table(
        "vaccine_candidates",
        sa.Column("id", sa.String(length=36), nullable=False,
                  comment="UUID 主键"),
        sa.Column("project_id", sa.String(length=36), nullable=True,
                  comment="所属项目 ID（NULL=全局候选）"),
        sa.Column("pathogen_name", sa.String(length=255), nullable=False,
                  comment="病原体名称"),
        sa.Column("antigen_sequence_digest", sa.JSON(), nullable=False,
                  comment="抗原序列摘要（sha256 + 长度，不存全序列）"),
        sa.Column("epitopes", sa.JSON(), nullable=True,
                  comment="表位预测结果与设计建议（JSON）"),
        sa.Column("status", sa.String(length=20), nullable=False,
                  comment="状态：designed"),
        sa.Column("created_by", sa.String(length=36), nullable=True,
                  comment="创建人用户 ID"),
        sa.Column("created_at", mysql.TIMESTAMP(fsp=3), nullable=False,
                  comment="创建时间"),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"],
            ondelete="CASCADE", name="fk_vaccine_candidates_project_id",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"],
            ondelete="SET NULL", name="fk_vaccine_candidates_created_by",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    # 按项目检索候选（项目详情页候选列表）
    op.create_index("ix_vaccine_candidates_project_id", "vaccine_candidates",
                    ["project_id"])
    # 按病原体检索（同病原多抗原设计对比）
    op.create_index("ix_vaccine_candidates_pathogen_name", "vaccine_candidates",
                    ["pathogen_name"])
    # 按状态检索（设计队列视图）
    op.create_index("ix_vaccine_candidates_status", "vaccine_candidates",
                    ["status"])


def downgrade() -> None:
    """删除疫苗候选设计表 vaccine_candidates 及其索引"""
    op.drop_index("ix_vaccine_candidates_status", table_name="vaccine_candidates")
    op.drop_index("ix_vaccine_candidates_pathogen_name",
                  table_name="vaccine_candidates")
    op.drop_index("ix_vaccine_candidates_project_id",
                  table_name="vaccine_candidates")
    op.drop_table("vaccine_candidates")
