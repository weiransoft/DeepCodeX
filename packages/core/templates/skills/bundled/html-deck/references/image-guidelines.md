# 图片获取与使用指南

本指南说明如何通过 `trae-api-cn.mchost.guru` 图片生成 API 获取演示文稿所需图片，以及图片的命名、存储与引用规范。

所有外部图片必须在编写 HTML 之前生成并验证完毕。数据图表使用内联 HTML/CSS 实现，无需预生成图片。

## 资产类型决策表

| 视觉类型 | 推荐方式 | 是否需预生成图片 |
|---|---|---|
| 柱状图 / 折线图 / 饼图 / 雷达图 | 内联 HTML/CSS（用 `chart-bar.html` 等版式） | 否 |
| 流程图 / 架构图 / 思维导图 | 内联 HTML/CSS（用 `flow-diagram`、`arch-diagram` 版式） | 否 |
| 封面背景 / Hero 图 | 图片生成 API | 是 |
| 插画 / 抽象视觉 | 图片生成 API | 是 |
| 头像 / 产品图 | 图片生成 API | 是 |
| 真实品牌 Logo / 商标 | 仅当无法生成时使用网络下载（最后手段） | 是 |

**原则**：能用 HTML/CSS 实现的就不生成图片。图片仅用于插画、背景、Hero 等无法用代码绘制的视觉。

## 图片命名规范（必须遵守）

所有生成图片必须存入 deck 的 `assets/` 子目录，文件名包含尺寸：

```
assets/{name}_{width}x{height}.png
```

示例：
- `assets/hero_1024x576.png` — 1024×576 的 Hero 图
- `assets/illustration_1024x768.png` — 1024×768 的插画
- `assets/headshot_1024x1024.png` — 1024×1024 的头像

## 尺寸选择

按用途选择图片尺寸（与 API 的 `image_size` 参数对应）：

| 用途 | 尺寸参数 | 实际像素 | 宽高比 |
|---|---|---|---|
| 全屏背景 / 封面 | `landscape_16_9` | 1024×576 | 16:9 |
| 内容区插画 | `landscape_4_3` | 1024×768 | 4:3 |
| 头像 / 方形图标 | `square_hd` | 1024×1024 | 1:1 |
| 竖版人像 | `portrait_3_4` | 768×1024 | 3:4 |
| 高竖版 | `portrait_9_16` | 576×1024 | 9:16 |

## 图片生成 API 用法

### 端点

```
POST https://trae-api-cn.mchost.guru/api/plan/v3/images/generations
```

### 认证

在请求头中携带 API Key（Bearer Token）：

```
Authorization: Bearer <YOUR_API_KEY>
```

API Key 通过环境变量 `ARK_API_KEY` 或 Trae Agent Plan 配置获取。

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 模型名，如 `doubao-seedream-3-0-t2i-250415` |
| `prompt` | string | 是 | 图片描述提示词 |
| `image_size` | string | 否 | 尺寸标识，见上表，默认 `landscape_16_9` |
| `response_format` | string | 否 | `url`（返回 URL）或 `b64_json`（返回 base64），默认 `url` |
| `n` | integer | 否 | 生成数量，默认 1 |

### 调用示例（curl）

```bash
# 生成封面背景图，返回 URL
curl -X POST https://trae-api-cn.mchost.guru/api/plan/v3/images/generations \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "doubao-seedream-3-0-t2i-250415",
    "prompt": "抽象几何插画，深蓝紫渐变背景，柔和光晕，极简风格，适合科技演讲封面",
    "image_size": "landscape_16_9",
    "response_format": "url"
  }'
```

### 响应格式

```json
{
  "data": [
    {
      "url": "https://.../generated_image.png",
      "b64_json": null
    }
  ],
  "usage": { "generated_images": 1 }
}
```

### 下载并重命名

API 返回 URL 后，下载到 deck 的 `assets/` 目录并按命名规范重命名：

```bash
# 解析返回的 URL 并下载
IMAGE_URL=$(curl -s -X POST https://trae-api-cn.mchost.guru/api/plan/v3/images/generations \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"doubao-seedream-3-0-t2i-250415","prompt":"...","image_size":"landscape_16_9"}' \
  | grep -oE '"url":"[^"]+"' | head -1 | cut -d'"' -f4)

# 下载并重命名（尺寸与 image_size 对应）
curl -s -o assets/hero_1024x576.png "$IMAGE_URL"
```

若 `response_format` 为 `b64_json`，则直接 base64 解码写入文件：

```bash
# 返回 base64 时直接解码保存
curl -s -X POST https://trae-api-cn.mchost.guru/api/plan/v3/images/generations \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"doubao-seedream-3-0-t2i-250415","prompt":"...","image_size":"square_hd","response_format":"b64_json"}' \
  | grep -oE '"b64_json":"[^"]+"' | head -1 | cut -d'"' -f4 \
  | base64 -d > assets/headshot_1024x1024.png
```

## 提示词编写技巧

### 核心原则

1. **描述风格**：明确艺术风格 — "扁平插画"、"写实航拍"、"等距视图"、"水彩渲染"
2. **指定色调**：匹配 deck 主题色 — "使用赭石与鼠尾草绿的暖色调"、"深蓝紫主色"
3. **构图说明**：描述元素布局 — "左侧为城市天际线，右侧留白用于文字叠加"
4. **情绪定调**：明确氛围 — "专业、克制、极简" 或 "活力、大胆、鲜明"
5. **避免文字**：图片中不含文字 — 生成文字通常模糊不清，文字用 HTML 元素呈现
6. **偏好插画**：AI 生成的照片易显诡异 — 插画、抽象艺术、风格化图形效果更佳

### 提示词模板

**封面背景**：
```
抽象几何插画，{主色调}渐变背景，柔和径向光晕，极简风格，{情绪描述}，
适合{主题}演讲封面，无文字，16:9 宽幅构图，中央留白
```

**内容插画**：
```
{风格}风格的{场景描述}，{色调描述}，{构图说明}，
画面干净不杂乱，适合作为演示文稿配图，无文字
```

**头像 / 人像**：
```
{风格}风格的人物插画，{人物描述}，{服饰与环境}，
自然光线，{情绪}，正面构图，背景简洁
```

### 与主题配色匹配

生成图片时，在提示词中融入 deck 主题色：

| 主题 | 建议提示词色调 |
|---|---|
| `light` | "白色背景，黑色与深灰主色，点缀靛蓝 accent" |
| `dark` | "深蓝紫夜空背景，蓝紫光晕，赛博朋克氛围" |

## 工作流

1. **盘点需求**：根据规划文档列出所有需要图片的幻灯片，每页每个图片槽位独立一项
2. **编写提示词**：为每个图片槽位编写具体提示词，注明尺寸与用途
3. **逐张生成**：调用 API 逐张生成，每个槽位一个文件，禁止合并
4. **下载重命名**：按 `assets/{name}_{w}x{h}.png` 规范保存
5. **HTML 引用**：在幻灯片中用相对路径引用

### HTML 引用示例

```html
<!-- 普通图片 -->
<img src="assets/hero_1024x576.png" alt="Hero 插画">

<!-- 全屏背景图 + 暗色遮罩（保证文字可读） -->
<section class="slide"
  style="background: linear-gradient(rgba(0,0,0,.55), rgba(0,0,0,.55)),
                     url('assets/cover-bg_1024x576.png') center/cover;">
```

## 规则

- **每个图片槽位独立生成**：一页有三张缩略图就生成三个文件，不合并为一张
- **尺寸与槽位匹配**：`image-text-split` 通常需 1 张 4:3 图；`image-grid` 可需多张
- **存入 deck 的 `assets/` 目录**：所有图片用相对路径引用，不外链
- **匹配 deck 配色**：提示词中包含主题色，保证图片与幻灯片视觉统一
- **偏好插画风格**：生成插画比生成照片效果更稳定

## 验证清单

生成所有图片后，进入 HTML 编写前确认：

```bash
# 确认所有图片存在且文件名含尺寸
ls -la assets/*_*x*.png 2>/dev/null

# 验证文件名尺寸与实际尺寸一致
for f in assets/*_*x*.png; do
  echo "$f: $(file "$f" | grep -oE '[0-9]+ x [0-9]+')"
done
```

**全部满足后方可进入 HTML 编写**：

- [ ] 规划文档中所有标记为"需生成图片"的槽位均已生成
- [ ] 文件存在且命名为 `{name}_{width}x{height}.png`
- [ ] 文件名尺寸与实际图片尺寸一致
- [ ] 图片色调与 deck 主题配色协调
