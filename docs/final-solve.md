你是一个自动化定时任务，运行在 ZCode 的无人值守 session 中，没有人会回答你的提问。遇到无法判断的情况，跳过该题并在报告中说明，不要停下等待确认。本任务用最高推理深度逐题攻克。

本任务不需要工作区里的任何代码，只调用下面的 HTTP 接口。不要阅读工作区文件，不要创建分支或提交。

目标：为 openmath 题库中每份卷子的最后两道压轴解答题生成高质量独立解答。压轴题最难，用最高推理深度逐题攻。本任务只负责解答（写 claude_analysis 字段），不做对账分诊 —— 分诊由每天凌晨 4 点的非压轴题分诊任务统一处理。

第零步 —— 计时
最开始运行 `date -u +%Y-%m-%dT%H:%M:%SZ`，记住这个开始时间戳，最后的报告要用。

准备 —— 知识点目录
curl -s https://openmath.toreal.site/api/claude-review/knowledge
后续打 tags 时从这份目录选，不要自造。

第一步 —— 取压轴题
curl -s -X POST https://openmath.toreal.site/api/claude-review/pending \
 -H 'Content-Type: application/json' \
 -d '{"limit": 6, "stage": "solve", "question_type": "解答", "exam_position": "final"}'
exam_position=final 表示每份卷子按题号最大的两道解答题（即压轴）。
若返回 403 或 host_not_allowed，立即停止并原文输出错误和 HTTP 状态码，不要重试。
若 count 为 0，输出报告（含耗时）并结束。
响应不含 Gemini 解答，这是设计的一部分。

第二步 —— 逐题独立解答（用最高推理深度）
对每一道题依次执行 A→E。图片获取与转录按下面的已验证流程做，不要走捷径（曾有批次因并行下载、shell 循环拼 URL、直接读 JPEG 而失败）。

A. 下载题目图片（串行，一次一张）：
curl -s --retry 3 --retry-delay 2 -o /tmp/q*<exam_id前6位>*<question_id>.png https://openmath.toreal.site/api/r2/<data_url>

- 文件名必须带 exam_id 前缀：不同卷子的 question_id 会重复，只用 question_id 命名会互相覆盖。
- 禁止并行 curl（会 DNS 解析失败 exit 6）；禁止用 shell 循环 + 变量拼 URL（zsh 不做分词，会生成带空格的错文件名），逐题写显式 curl 命令。
- 下载后用 file 命令确认是图片数据（JPEG/PNG）；若是 HTML 文本说明失败，重试该张。

B. 读取与转录：

- 先直接 Read 图片文件。若报 Unable to decode image data，用 sips 转换后再 Read：sips -s format png /tmp/q*<...>.png --out /tmp/q*<...>\_c.png
- 本环境中 Read 图片返回的是 CDN URL 而非直接展示图像。取到 URL 后用视觉分析工具 analyze_image（imageSource 传该 CDN URL）逐字转录题目，转录 prompt 要求：逐字符抄写题干和全部小问（(1)(2) 或（Ⅰ）（Ⅱ））、公式用 LaTeX、有立体图形则详细描述图中所有点线标注，禁止解答、概括或凭记忆补全。
- 每张图转录后立即做自洽性检查：题干条件与小问要求是否兼容（如递推式与所证"等比/等差"结论是否匹配、条件是否使问题退化、数值是否使答案非高考风格）。发现矛盾说明转录有错，进入 C；未发现矛盾则采信，进入 D。

C. 转录核验（仅当 B 中怀疑有误时）：

- 换一个角度的 prompt 再读一次原图；或 sips -z 把图放大 3 倍后用 sips --cropOffset 分上下半幅裁剪、分别读取。
- 两次独立读取结果完全一致才采信，进入 D。仍互相矛盾则该题按"图片不可读"跳过（不写入任何数据），在报告中记录卷名、题号和冲突的转录版本摘要。

D. 独立解答：
中国大陆高考数学压轴题。彻底独立解答，按高考评分标准分步书写。压轴题的难点在长链符号计算和分类讨论的完备性 —— 每一步变形都要验算，每一种情形都要讨论到。不要查询 pro_analysis。

E. 写回与计时：
payload 较长，先写入临时 JSON 文件再提交（避免命令行引号转义出错）：
curl -s -X PUT https://openmath.toreal.site/api/claude-review/analysis \
 -H 'Content-Type: application/json' --data-binary @/tmp/payload_q.json
payload 结构：
{"exam_id":"...","question_id":"...",
"claude_analysis":{"picture_ok":true,"difficulty":5,"question_type":"解答",
"tags":[{"level0":"...","level1":"..."}],
"question_md":"题干","solution_md":"完整解答","analysis_md":"思路分析"},
"final_answers":["第(1)问结论","第(2)问结论"]}
tags 从知识点目录选，level0/level1 对应章/节，可多选。
final_answers 格式规范（服务端要做字符串比对）：每小问一项只写最终结论；不写描述前缀；证明题只写被证结论如 "N ≤ 11"；区间写 [a,b] / (a,b)；集合写 (-∞,-2] ∪ [2,+∞)；下标用 ASCII a_1、q^m。
每解完一题，运行一次 `date -u +%Y-%m-%dT%H:%M:%SZ` 记下单题完成时间，报告要用。

第三步 —— 报告
再次运行 `date -u +%Y-%m-%dT%H:%M:%SZ` 取结束时间。
报告开头先给计时：开始时间（UTC）、结束时间（UTC）、总耗时（分钟）、每题耗时（分钟）、平均每题耗时。
然后输出：解答几题、跳过几题及原因（跳过的题给出卷名、题号、原因）。不要做 extract/triage/仲裁，那些由后续的分诊任务和仲裁任务处理。
