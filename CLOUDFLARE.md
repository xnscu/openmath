# GKSX - Cloudflare Worker 部署指南

本项目已改造为支持 Cloudflare Workers + D1 数据库，实现前后端一体化部署，并支持 IndexedDB 与 D1 双向同步。

## 项目结构

```
├── src/
│   └── worker.mjs          # Cloudflare Worker 后端 API
├── services/
│   ├── storageService.ts   # 本地 IndexedDB 存储服务
│   └── syncService.ts      # 双向同步服务
├── hooks/
│   └── useSync.ts          # React 同步状态 Hook
├── components/
│   └── SyncStatus.tsx      # 同步状态 UI 组件
├── schema.sql              # D1 数据库表结构
├── wrangler.toml           # Cloudflare Worker 配置
└── deploy.sh               # 部署脚本
```

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 初始化 D1 数据库

```bash
# 本地开发环境
pnpm db:init:local

# 远程 Cloudflare 环境
pnpm db:init
```

### 3. 一键启动开发环境

使用 `@cloudflare/vite-plugin`，只需一个命令即可同时启动前端和 Worker：

```bash
pnpm dev
```

这会在 http://localhost:3000 启动开发服务器，同时运行 Worker 提供 API 服务。

### 4. 部署到 Cloudflare

```bash
pnpm deploy
```

或使用部署脚本：

```bash
chmod +x deploy.sh
./deploy.sh
```

## API 端点

Worker 提供以下 REST API 端点：

### Exams（试卷）

| 方法   | 端点                       | 描述                   |
| ------ | -------------------------- | ---------------------- |
| GET    | `/api/exams`               | 获取所有试卷元数据列表 |
| GET    | `/api/exams/:id`           | 获取单个试卷完整数据   |
| POST   | `/api/exams`               | 创建或更新试卷         |
| DELETE | `/api/exams/:id`           | 删除试卷               |
| POST   | `/api/exams/batch-delete`  | 批量删除试卷           |
| PUT    | `/api/exams/:id/questions` | 更新试卷的题目         |

### Sync（同步）

| 方法 | 端点               | 描述               |
| ---- | ------------------ | ------------------ |
| GET  | `/api/sync/status` | 获取同步状态       |
| POST | `/api/sync/push`   | 推送本地更改到云端 |
| POST | `/api/sync/pull`   | 从云端拉取更改     |

## 数据同步

### 同步模式

项目支持三种同步模式：

1. **自动同步**：每 5 分钟自动执行双向同步
2. **手动同步**：通过 UI 按钮触发立即同步
3. **离线队列**：离线时操作会被记录，上线后自动同步

### 在组件中使用

```tsx
import SyncStatus from "./components/SyncStatus";

function App() {
  return (
    <div>
      <SyncStatus />
      {/* 其他内容 */}
    </div>
  );
}
```

或使用 Hook：

```tsx
import { useSync } from "./hooks/useSync";

function MyComponent() {
  const { status, sync, forceUpload, forceDownload } = useSync();

  return (
    <div>
      <p>在线状态: {status.isOnline ? "在线" : "离线"}</p>
      <p>待同步: {status.pendingCount} 项</p>
      <button onClick={sync}>同步</button>
      <button onClick={forceUpload}>上传全部</button>
      <button onClick={forceDownload}>下载全部</button>
    </div>
  );
}
```

### 使用带同步的存储函数

```tsx
import * as syncService from "./services/syncService";

// 保存并同步
await syncService.saveExamWithSync(fileName, rawPages, questions);

// 删除并同步
await syncService.deleteExamWithSync(id);

// 更新题目并同步
await syncService.updateQuestionsWithSync(fileName, questions);

// 强制上传所有本地数据
await syncService.forceUploadAll();

// 强制下载所有云端数据
await syncService.forceDownloadAll();
```

## 数据结构

### ExamRecord（试卷记录）

```typescript
interface ExamRecord {
  id: string; // 唯一标识
  name: string; // 文件名
  timestamp: number; // 时间戳
  pageCount: number; // 页数
  rawPages: DebugPageData[]; // 原始页面数据
  questions: QuestionImage[]; // 题目图片
}
```

### D1 数据库表

- **exams**: 试卷元数据
- **raw_pages**: 原始页面数据（包含检测框）
- **questions**: 切割后的题目图片
- **sync_log**: 同步日志（用于冲突检测）

## 环境变量

可以通过 `.env` 文件或 Cloudflare Dashboard 设置：

```env
# Vite 前端环境变量
VITE_API_URL=/api        # API 基础 URL
# VITE_CDN_URL=https://openmath.toreal.site/api/r2/  # CDN 域名（生产环境图片URL，可选）

# Cloudflare Worker 环境变量（在 wrangler.toml 中配置）
ENVIRONMENT=production
```

**注意**：如果设置了 `VITE_CDN_URL`，生产环境中的图片URL将使用CDN域名而不是workers路由。这可以提高图片加载性能并减少Worker的负载。

## 冲突处理

当同一条记录在本地和云端都被修改时，同步服务会检测到冲突：

1. 同步会返回冲突列表
2. 默认行为是保留本地版本
3. 可以通过 `forceDownload` 覆盖本地数据

## 故障排除

### 数据库初始化失败

确保已经在 Cloudflare Dashboard 创建了 D1 数据库，并且 `wrangler.toml` 中的 `database_id` 正确。

### 同步失败

1. 检查网络连接
2. 查看浏览器控制台错误信息
3. 尝试使用 `forceUpload` 或 `forceDownload` 重新同步

### 离线模式不工作

确保 `syncService.initSyncService()` 在应用启动时被调用。

## 开发注意事项

1. **本地 IndexedDB 优先**：所有操作首先写入本地，确保离线可用
2. **数据一致性**：sync_log 表记录所有变更，支持增量同步
3. **大文件处理**：Base64 图片数据可能很大，注意 D1 的大小限制
4. **CORS**：Worker 已配置跨域支持，开发时可能需要调整
