# Claude 交叉核查 Gemini Pro 解答

用 Claude 独立解题、与 Gemini Pro 的答案对账，把分歧题挑出来送仲裁。

## 为什么不直接让 Claude review

把 `pro_analysis.solution_md` 喂给模型让它挑错，模型会被一份工整的解答锚定，倾向确认而非质疑；细微计算错误正是这样漏过去的。

所以流程强制 Claude 先在**看不到 Gemini 答案**的前提下解题。这一点由 API 保证，不靠 prompt 自觉：`stage: 'solve'` 的响应里根本没有 `pro_analysis` 字段。

## 四个阶段

| 阶段 | 谁看到什么 | 成本 |
| --- | --- | --- |
| `solve` | 只有题目图片。Claude 独立解答，写 `claude_analysis` | 每题一次调用 |
| `extract` | 只有 Gemini 的 `solution_md` + 答案个数。提取最终答案，看不到 Claude 的答案 | 廉价，纯提取 |
| `triage` | Worker 做字符串归一化比对 | **零模型调用** |
| `arbitrate` | 两份解答全见。只处理 triage 判定分歧的题 | 贵，但只落在少数题上 |

`triage` 的归一化（`normalizeAnswer`）刻意保守：`\frac{1}{2}` 和 `1/2` 判相同，但 `1/2` 和 `0.5` 判不同。判错只多花一次仲裁，判对却会放过错误答案 —— 误判方向不对称，所以宁可多花钱。

## API

Base: `https://openmath.toreal.site/api/claude-review`

```
POST /pending    { limit, stage: 'solve'|'extract'|'arbitrate', min_difficulty? }
PUT  /analysis   { exam_id, question_id, claude_analysis, final_answers: string[] }
POST /triage     { gemini_answers: { "exam_id:question_id": string[] } }
PUT  /review     { exam_id, question_id, claude_review }
GET  /stats
GET  /timeline   { mode: 'day'|'week'|'month' }
```

题目图片：`data_url` 是 SHA-256 hash，从 `https://openmath.toreal.site/api/r2/<hash>` 取。

## Routine A — 解答 + 分诊

模型 Sonnet。cron `5 16 * * *`（UTC）= 每天北京时间 00:05。
Routine 的 cron 一律按 UTC 解释，本地时间要减 8 小时。

```
你是一个自动化任务，运行在 Claude Code 云端 session 中，没有人会回答你的提问。
遇到无法判断的情况，跳过该题并在最终报告中说明，不要停下来等待确认。

目标：为 openmath 题库中尚无 Claude 解答的高难度题目生成独立解答，并与 Gemini Pro 的答案对账。

第一步 —— 取题
curl -s -X POST https://openmath.toreal.site/api/claude-review/pending \
  -H 'Content-Type: application/json' \
  -d '{"limit": 15, "stage": "solve", "min_difficulty": 4, "question_type": "解答"}'

question_type 按前缀匹配，"解答" 同时命中库里的 "解答" 和 "解答题" 两种写法。
响应中每题含 exam_id、question_id、data_url（图片的 SHA-256 hash）、difficulty。
响应刻意不包含 Gemini 的解答，这是设计的一部分。

若 count 为 0，说明该难度档已核查完，直接输出报告并结束，不要放宽筛选条件。

第二步 —— 逐题独立解答
对每一道题：
  1. curl -s -o /tmp/q.png https://openmath.toreal.site/api/r2/<data_url>
     然后用 Read 工具读取 /tmp/q.png。
  2. 这是中国大陆高考数学题。独立解答，按高考评分标准书写步骤。
     重点检查两件事：分类讨论是否完备，每一步代数变形是否正确。
     不要去查询这道题的 pro_analysis —— 独立性是整套流程的全部意义。
  3. 写回：
     curl -s -X PUT https://openmath.toreal.site/api/claude-review/analysis \
       -H 'Content-Type: application/json' \
       -d '{
         "exam_id": "...", "question_id": "...",
         "claude_analysis": {
           "picture_ok": true, "difficulty": 1-5, "question_type": "解答",
           "tags": [{"level0": "...", "level1": "..."}],
           "question_md": "题干", "solution_md": "完整解答", "analysis_md": "思路分析"
         },
         "final_answers": ["第(1)问的最终答案", "第(2)问的最终答案"]
       }'
     final_answers 每个小问一项，只填最终结论，不要过程。
     图片不可读或题目残缺时跳过该题，不要写入。

第三步 —— 提取 Gemini 的最终答案
curl -s -X POST https://openmath.toreal.site/api/claude-review/pending \
  -H 'Content-Type: application/json' \
  -d '{"limit": 50, "stage": "extract"}'

对每一道返回的题，从 gemini_solution_md 里把最终答案提取出来。
数量必须等于 expected_answer_count，顺序与小问顺序一致。
这一步只做提取，不做任何对错判断 —— 照抄 Gemini 写的结论，哪怕你认为它是错的。

第四步 —— 分诊
curl -s -X POST https://openmath.toreal.site/api/claude-review/triage \
  -H 'Content-Type: application/json' \
  -d '{"gemini_answers": {"<key>": ["答案1", "答案2"]}}'
key 用第三步响应里的 key 字段（形如 "exam_id:question_id"）。

服务端做字符串归一化比对：答案一致的直接判定 correct，不一致的进入仲裁队列。

第五步 —— 报告
输出：本次解答几题、triage 判定 correct 几题、进入仲裁队列几题（arbitration_keys）、
跳过几题及原因。
```

## Routine B — 仲裁

模型 Opus。cron `5 21 * * *`（UTC）= 每天北京时间 05:05，在 A 之后 5 小时。

```
ultrathink

你是一个自动化任务，运行在 Claude Code 云端 session 中，没有人会回答你的提问。

目标：仲裁 openmath 题库中 Claude 与 Gemini Pro 答案不一致的题目。这些题已由自动分诊
判定为存在分歧，需要逐题深入验算。

第一步 —— 取仲裁队列
curl -s -X POST https://openmath.toreal.site/api/claude-review/pending \
  -H 'Content-Type: application/json' \
  -d '{"limit": 8, "stage": "arbitrate"}'

每题含 data_url、pro_analysis（Gemini 的解答）、claude_analysis（Claude 的解答）。

第二步 —— 逐题仲裁
对每一道题：
  1. curl -s -o /tmp/q.png https://openmath.toreal.site/api/r2/<data_url>，用 Read 读取。
  2. 先不看两份解答，自己从头独立算一遍。算完再对照。
  3. 定位分歧的确切来源。分歧可能只是等价形式的不同写法
     （如 1/2 与 0.5、[1,3] 与 1≤x≤3），这种情况判 correct。
  4. 写回：
     curl -s -X PUT https://openmath.toreal.site/api/claude-review/review \
       -H 'Content-Type: application/json' \
       -d '{
         "exam_id": "...", "question_id": "...",
         "claude_review": {
           "verdict": "correct|minor_issue|incorrect|unverifiable",
           "confidence": 0.95,
           "claude_answer": "...", "gemini_answer": "...",
           "issues": [{"severity": "typo|calculation|logic|answer",
                       "location": "(2) 第三步", "description": "移项时符号错误"}],
           "corrected_solution_md": "仅当 verdict 为 incorrect 时填写",
           "model_id": "claude-opus-4-8", "effort": "ultrathink"
         }
       }'

verdict 语义：
  correct        Gemini 的最终答案正确（含等价形式不同的情况）
  minor_issue    最终答案正确，但推理过程有瑕疵
  incorrect      Gemini 的最终答案错误
  unverifiable   图片不可读，或题目本身有问题

判 incorrect 前必须自己独立验算确认。不要仅因两份解答不同就采信 Claude 那一方 ——
分歧同样可能是 Claude 算错了，此时正确做法是判 correct。
confidence 低于 0.7 时判 unverifiable，留给人工复核。

第三步 —— 报告
curl -s https://openmath.toreal.site/api/claude-review/stats
输出各 verdict 的分布，并逐条列出本次判定为 incorrect 的题目及错因。
```

## 已创建的 routine

| routine | id | cron (UTC) | 本地 | 模型 |
| --- | --- | --- | --- | --- |
| gksx-claude-solve-triage | `trig_01XQtNpyUBiEPBTsesmYAUps` | `5 16 * * *` | 00:05 | claude-sonnet-5 |
| gksx-claude-arbitrate | `trig_01HCN4gaD1q2e2Zv8NEwBaNs` | `5 21 * * *` | 05:05 | claude-opus-4-8 |

两者都用 `env_01Y41RBodAaXN1E9nPGVSAjb`，工具只开 `Bash` + `Read`，不挂业务 connector。
管理入口 [claude.ai/code/routines](https://claude.ai/code/routines)，或 CLI 的
`/schedule list` / `/schedule update` / `/schedule run`。删除只能在 web 上做。

## 部署

Remote routine 在 [claude.ai/code/routines](https://claude.ai/code/routines)、Desktop、
CLI `/schedule` 三个入口都能建，写的是同一个云端账户。Desktop 里若选 Local，
建出来的是需要开着电脑的本地任务，不是 routine。

### 必须改网络白名单

云环境默认只放行常见包管理器和云厂商域名。`openmath.toreal.site` 与 `r2-gksx.xnscu.com`
都不在其中，不改的话 routine 里每一个 curl 都会返回 `403 x-deny-reason: host_not_allowed`。

白名单挂在**环境**上，不在 routine 上 —— 创建 routine 的 API 只接受一个 `environment_id`。
所以要么改默认环境（影响所有用它的 routine），要么另建一个环境。CLI 的 `/schedule`
两件事都做不了，得在 claude.ai 的环境设置里改。

入口：Network access 改 **Custom** → Allowed domains 填入这两个域名 →
勾选 "Also include default list of common package managers"。

### 其他约束

- Routine 最小间隔 1 小时。
- 每次 run 会 clone 一个 GitHub 仓库，需要先连好 GitHub。
- Routine 消耗订阅额度，另有每日运行次数上限（按 plan 区分，在
  [claude.ai/code/routines](https://claude.ai/code/routines) 查看当前额度）。
- 创建表单只有模型选择器，**没有 thinking effort 选择器**。xhigh / max 是 CLI 交互式
  会话的功能，云端 routine 只能靠 prompt 里的 `ultrathink` 关键词拉高思考预算。
- CLI 里的 `CronCreate` / `/loop` 是另一回事：session-only，要求 REPL 一直开着，
  与 routines 无关。
