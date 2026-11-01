# Pro Analysis Server

基于 Gemini Pro 的批量题目解析服务器，运行在 Ubuntu 上，使用 PM2 管理进程。

## 功能

- 从云端 D1 数据库获取待解析的题目（`pro_analysis` 为空）
- 使用 `keys.txt` 中的多个 API key 轮询调用 Gemini Pro
- 并发处理，实时更新结果到云端
- 指数退避策略处理 429/503 错误，避免给 Google 过多无效请求
- 记录每个 key 的调用统计到 D1
- 前端统计页面显示各 key 的调用情况

## 部署步骤

### 1. 安装依赖

```bash
# 确保已安装 Node.js >= 18
node -v

# 安装 PM2（如果尚未安装）
npm install -g pm2

# 进入 server 目录
cd server

# 安装项目依赖
npm install
```

### 2. 配置

```bash
# 复制配置模板
cp .env.example .env

# 编辑配置
nano .env
```

配置项说明：

| 参数                       | 默认值                   | 说明                 |
| -------------------------- | ------------------------ | -------------------- |
| `API_BASE_URL`             | `https://openmath.toreal.site` | 云端 API 地址        |
| `BATCH_SIZE`               | `50`                     | 每批获取的题目数量   |
| `CONCURRENCY`              | `5`                      | 并发处理数量         |
| `INITIAL_DELAY_MS`         | `1000`                   | 初始调用间隔（毫秒） |
| `MAX_DELAY_MS`             | `60000`                  | 最大退避间隔（毫秒） |
| `MAX_RETRIES_PER_QUESTION` | `3`                      | 每题最大重试次数     |
| `MODEL_ID`                 | `gemini-3-pro-preview`   | 使用的模型           |
| `KEYS_FILE`                | `keys.txt`               | API Key 文件路径     |

### 3. 配置 API Keys

```bash
# 创建 keys.txt 文件，每行一个 key
nano keys.txt
```

示例格式：

```
AIzaSyBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1
AIzaSyBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx2
AIzaSyBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx3
# 以 # 开头的行会被忽略
```

### 4. 运行数据库迁移

在部署前端代码之前，需要运行数据库迁移以创建 `api_key_stats` 表：

```bash
# 在项目根目录
cd ..

# 运行迁移
wrangler d1 execute openmath --file=migrations/0004_api_key_stats.sql --remote
```

### 5. 启动服务

**开发模式（直接运行）：**

```bash
npm start
```

**生产模式（PM2 管理）：**

```bash
# 启动
npm run pm2:start

# 查看日志
npm run pm2:logs

# 重启
npm run pm2:restart

# 停止
npm run pm2:stop

# 删除进程
npm run pm2:delete
```

### 6. PM2 开机自启

```bash
# 保存当前进程列表
pm2 save

# 生成开机启动脚本
pm2 startup

# 按照输出的命令执行（需要 sudo）
```

## API 接口

服务器通过以下 API 与云端交互：

### 获取待处理题目

```http
POST /api/pro-analysis/pending
Content-Type: application/json

{
  "limit": 50
}
```

### 更新题目解析

```http
PUT /api/pro-analysis/update
Content-Type: application/json

{
  "exam_id": "xxx",
  "question_id": "xxx",
  "pro_analysis": { ... }
}
```

### 记录 Key 调用统计

```http
POST /api/key-stats/record
Content-Type: application/json

{
  "api_key_prefix": "AIzaSyBx",
  "success": true,
  "duration_ms": 3000,
  "question_id": "xxx",
  "exam_id": "xxx",
  "model_id": "gemini-3-pro-preview"
}
```

### 获取 Key 统计

```http
GET /api/key-stats
GET /api/key-stats?days=7
GET /api/key-stats?days=30
```

## 前端统计页面

在主应用中引入 `ApiKeyStatsPage` 组件：

```tsx
import { ApiKeyStatsPage } from "./components/ApiKeyStatsPage";

// 在路由中添加
<Route path="/key-stats" component={ApiKeyStatsPage} />;
```

访问 `/key-stats` 查看统计数据。

## 策略说明

### 退避策略

当遇到 429 (Rate Limit) 或 503 (Server Error) 时：

1. 记录该 key 的错误
2. 将该 key 的下次调用延迟翻倍（指数退避）
3. 最大延迟为 60 秒
4. 成功调用后重置延迟为初始值

### 轮询策略

- 按顺序轮换使用 keys.txt 中的所有 key
- 每个 key 各自维护独立的退避状态
- 失败的题目会在下一轮继续处理

### 并发控制

- 默认 5 个并发处理
- 可通过 `CONCURRENCY` 环境变量调整
- 建议值：key 数量 × 2

## 日志输出示例

```
╔════════════════════════════════════════════════════════════════╗
║            OpenMath Pro Analysis Server                        ║
║────────────────────────────────────────────────────────────────║
║  API Base:     https://openmath.toreal.site                    ║
║  Batch Size:   50                                              ║
║  Concurrency:  5                                               ║
║  Model:        gemini-3-pro-preview                            ║
╚════════════════════════════════════════════════════════════════╝

════════════════════════════════════════════════════════════════
[Round 1] Fetching pending questions...
[Round 1] Found 50 questions to process

[Batch 1/10] Processing 5 questions...
[Analyzer] ✓ Analyzed question q1 (3245ms) using key AIzaSyBx...
[Analyzer] ✓ Analyzed question q2 (2891ms) using key AIzaSyCd...
[Processor] ✓ Saved pro_analysis for q1
[Processor] ✓ Saved pro_analysis for q2
...

[Round 1] Summary:
  Total processed: 50
  Successful: 48
  Failed: 2
  Pending retry: 2
```

## 故障排除

### 常见问题

1. **全部 key 都报 429**
   - 增加 `INITIAL_DELAY_MS` 值
   - 减少 `CONCURRENCY` 值
   - 检查是否有其他服务在使用相同的 key

2. **连接云端失败**
   - 检查 `API_BASE_URL` 是否正确
   - 检查网络连接
   - 检查 Cloudflare Worker 是否正常运行

3. **keys.txt 读取失败**
   - 确保文件存在于 server 目录
   - 确保文件编码为 UTF-8
   - 确保每行只有一个 key，无多余空格

## 许可证

MIT
