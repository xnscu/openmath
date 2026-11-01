/**
 * Claude Review Routes
 *
 * Implements a two-stage cross-check of Gemini Pro's answers:
 *
 *   solve      Claude answers the question from the image alone and writes
 *              claude_analysis. The payload deliberately omits pro_analysis so
 *              the solution cannot be anchored on Gemini's.
 *   triage     The Worker compares the two sets of final answers with plain
 *              string normalization. Matches are settled as 'correct' without
 *              any model call. Mismatches are handed back for arbitration.
 *   arbitrate  Claude sees both solutions and writes claude_review.
 *
 * Normalization is intentionally conservative: when it cannot prove two answers
 * are equal it reports a mismatch. A false mismatch only costs one arbitration
 * call, whereas a false match would silently bless a wrong answer.
 */
import { Hono } from 'hono';
import { analysisPrompt } from '../../shared/analysis-prompt.js';

const claudeReviewRoutes = new Hono();

// The same knowledge-point taxonomy Gemini selects its tags from, pulled out of
// Gemini's own prompt so there is a single source of truth. Serving it to the
// solve routine lets Claude choose tags from the identical vocabulary, which is
// what makes the two sides' tags comparable. Extracting rather than duplicating
// keeps Gemini's prompt untouched.
const KNOWLEDGE_DIRECTORY =
  analysisPrompt.match(/<knowledge_directory>\n([\s\S]*?)<\/knowledge_directory>/)?.[1] ?? '';

// exam_position selects questions by their rank within their own exam. The two
// closing questions of a paper are its 压轴 (hardest) problems; a caller can ask
// for just those, or for everything but those, to route them to different models.
const EXAM_POSITION_SQL = {
  final: 'r.rn <= 2',
  non_final: 'r.rn > 2',
};

/**
 * Reduce a mathematical answer to a form that survives cosmetic differences:
 * LaTeX delimiters, \frac{a}{b} vs a/b, spacing, trailing punctuation.
 * Returns '' for anything empty so callers can treat it as "no answer".
 */
function normalizeAnswer(raw) {
  if (typeof raw !== 'string') return '';

  return raw
    .trim()
    // Strip $...$, $$...$$, \(...\), \[...\] wrappers
    .replace(/^\$+|\$+$/g, '')
    .replace(/^\\[([]|\\[)\]]$/g, '')
    // \frac{a}{b} and \dfrac{a}{b} -> (a)/(b); the parens are stripped again
    // below when they turn out to be redundant.
    .replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
    // \left( -> (, \right) -> )
    .replace(/\\left|\\right/g, '')
    // Common equivalent spellings
    .replace(/\\cdot|\\times/g, '*')
    .replace(/\\pi/g, 'pi')
    .replace(/\\sqrt/g, 'sqrt')
    .replace(/\\infty/g, 'inf')
    // Drop LaTeX spacing macros, including "\ " (backslash-space)
    .replace(/\\[,;:!\s]|\\quad|\\qquad/g, '')
    // Drop all whitespace and braces
    .replace(/[{}\s]/g, '')
    // Unify unicode minus and full-width punctuation
    .replace(/[−－]/g, '-')
    .replace(/[，]/g, ',')
    // Unwrap parens that hold a single atom, so \frac{1}{2} -> (1)/(2) -> 1/2
    // and matches a plainly written 1/2. Contents with an operator keep their
    // parens because (a+b)/c differs from a+b/c. Contents with a comma keep
    // them too, so the interval (1,2) never collapses onto the set {1,2}.
    .replace(/\(([^()+\-*/^,]+)\)/g, '$1')
    // Trailing period / Chinese full stop adds nothing
    .replace(/[.。]+$/, '')
    .toLowerCase();
}

/**
 * Compare two answer lists positionally. Both must be non-empty and the same
 * length, otherwise we cannot claim agreement.
 */
function answersAgree(claudeAnswers, geminiAnswers) {
  if (!Array.isArray(claudeAnswers) || !Array.isArray(geminiAnswers)) return false;
  if (claudeAnswers.length === 0 || claudeAnswers.length !== geminiAnswers.length) return false;

  return claudeAnswers.every((a, i) => {
    const left = normalizeAnswer(a);
    const right = normalizeAnswer(geminiAnswers[i]);
    return left !== '' && left === right;
  });
}

const STAGES = ['solve', 'extract', 'arbitrate'];

// POST /pending - Questions awaiting a given stage.
// body: { limit: number, stage: 'solve' | 'extract' | 'arbitrate', min_difficulty?: number }
claudeReviewRoutes.post('/pending', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();

  const limit = Number.isInteger(body?.limit) ? body.limit : null;
  const stage = body?.stage;

  if (limit === null || !STAGES.includes(stage)) {
    return c.json({ error: `Invalid request: expected { limit: number, stage: ${STAGES.join('|')} }` }, 400);
  }

  const minDifficulty = Number.isInteger(body?.min_difficulty) ? body.min_difficulty : 1;

  if (stage === 'solve') {
    // Matched as a prefix: the column holds both '解答' and '解答题' for the same
    // kind of question, likewise 选择/选择题 and 填空/填空题.
    const typePrefix = typeof body?.question_type === 'string' ? body.question_type : null;

    const examPosition = body?.exam_position ?? null;
    if (examPosition !== null && !(examPosition in EXAM_POSITION_SQL)) {
      return c.json({ error: `exam_position must be one of ${Object.keys(EXAM_POSITION_SQL).join(', ')}` }, 400);
    }

    // pro_analysis must exist -- there is nothing to cross-check otherwise.
    // data_url only: withholding pro_analysis is what keeps the solve independent.
    let result;
    if (examPosition) {
      // 压轴 selection needs each question's rank within its exam. The rank is
      // computed over the whole solution set (not just unsolved rows), so
      // already-solved questions don't shift what counts as the final two.
      // exam_position implies a question type; default to 解答 since 压轴 is a
      // solution-question concept.
      const rankType = typePrefix ?? '解答';
      result = await db.prepare(`
        WITH ranked AS (
          SELECT
            q.id, q.exam_id, q.data_url, q.claude_analysis, q.page_number,
            json_extract(q.pro_analysis, '$.difficulty') AS difficulty,
            json_extract(q.pro_analysis, '$.question_type') AS question_type,
            ROW_NUMBER() OVER (
              PARTITION BY q.exam_id ORDER BY CAST(q.id AS INTEGER) DESC
            ) AS rn
          FROM questions q
          WHERE q.pro_analysis IS NOT NULL
            AND json_extract(q.pro_analysis, '$.question_type') LIKE ? || '%'
        )
        SELECT r.id AS question_id, r.exam_id, r.data_url, r.difficulty,
               r.question_type, e.name AS exam_name
        FROM ranked r
        JOIN exams e ON e.id = r.exam_id
        WHERE r.claude_analysis IS NULL
          AND COALESCE(r.difficulty, 1) >= ?
          AND ${EXAM_POSITION_SQL[examPosition]}
        ORDER BY r.difficulty DESC, e.timestamp DESC, r.page_number
        LIMIT ?
      `).bind(rankType, minDifficulty, limit).all();
    } else {
      result = await db.prepare(`
        SELECT
          q.id AS question_id,
          q.exam_id,
          q.data_url,
          json_extract(q.pro_analysis, '$.difficulty') AS difficulty,
          json_extract(q.pro_analysis, '$.question_type') AS question_type,
          e.name AS exam_name
        FROM questions q
        JOIN exams e ON e.id = q.exam_id
        WHERE q.pro_analysis IS NOT NULL
          AND q.claude_analysis IS NULL
          AND COALESCE(json_extract(q.pro_analysis, '$.difficulty'), 1) >= ?
          AND (? IS NULL OR json_extract(q.pro_analysis, '$.question_type') LIKE ? || '%')
        ORDER BY json_extract(q.pro_analysis, '$.difficulty') DESC, e.timestamp DESC, q.page_number
        LIMIT ?
      `).bind(minDifficulty, typePrefix, typePrefix, limit).all();
    }

    return c.json({ stage, questions: result.results, count: result.results.length });
  }

  if (stage === 'extract') {
    // Gemini's final answers live inside prose, so a caller has to pull them out
    // before triage can compare. Safe to expose pro_analysis here: claude_analysis
    // is already committed and is never rewritten by this stage.
    //
    // Claude's own answers are withheld. An extractor that could see them would
    // be free to read Gemini's prose as saying the same thing, which is exactly
    // the agreement triage is supposed to test. Only the count goes out, so the
    // two lists can be compared positionally.
    const result = await db.prepare(`
      SELECT
        q.id AS question_id,
        q.exam_id,
        json_extract(q.pro_analysis, '$.solution_md') AS gemini_solution_md,
        json_array_length(json_extract(q.claude_analysis, '$.final_answers')) AS expected_answer_count
      FROM questions q
      WHERE q.claude_analysis IS NOT NULL
        AND q.claude_review IS NULL
      LIMIT ?
    `).bind(limit).all();

    return c.json({
      stage,
      questions: result.results.map(q => ({ ...q, key: `${q.exam_id}:${q.question_id}` })),
      count: result.results.length,
    });
  }

  // arbitrate: triage has already flagged these as disagreeing.
  const result = await db.prepare(`
    SELECT
      q.id AS question_id,
      q.exam_id,
      q.data_url,
      q.pro_analysis,
      q.claude_analysis,
      e.name AS exam_name
    FROM questions q
    JOIN exams e ON e.id = q.exam_id
    WHERE q.claude_analysis IS NOT NULL
      AND json_extract(q.claude_review, '$.verdict') = 'pending_arbitration'
    ORDER BY e.timestamp DESC, q.page_number
    LIMIT ?
  `).bind(limit).all();

  return c.json({
    stage,
    questions: result.results.map(q => ({
      ...q,
      pro_analysis: q.pro_analysis ? JSON.parse(q.pro_analysis) : null,
      claude_analysis: q.claude_analysis ? JSON.parse(q.claude_analysis) : null,
    })),
    count: result.results.length,
  });
});

// PUT /analysis - Store Claude's independent solution.
// body: { exam_id, question_id, claude_analysis, final_answers: string[] }
claudeReviewRoutes.put('/analysis', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();

  if (!body?.exam_id || !body?.question_id || !body?.claude_analysis) {
    return c.json({ error: 'Invalid request: expected { exam_id, question_id, claude_analysis, final_answers }' }, 400);
  }

  if (!Array.isArray(body.final_answers) || body.final_answers.length === 0) {
    return c.json({ error: 'final_answers must be a non-empty array, one entry per sub-question' }, 400);
  }

  const solvedAt = body.claude_analysis?.solved_at || new Date().toISOString();
  const payload = { ...body.claude_analysis, final_answers: body.final_answers, solved_at: solvedAt };

  const result = await db.prepare(`
    UPDATE questions SET claude_analysis = ? WHERE exam_id = ? AND id = ?
  `).bind(JSON.stringify(payload), body.exam_id, body.question_id).run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'Question not found' }, 404);
  }

  return c.json({ success: true });
});

// POST /triage - Compare final answers, settle the matches, flag the rest.
// body: { limit?: number, gemini_answers: { [question_key]: string[] } }
//
// gemini_answers is supplied by the caller because pro_analysis stores prose
// (solution_md), not a structured answer list. The caller extracts them; a cheap
// extraction-only model is enough since no judgement is involved.
claudeReviewRoutes.post('/triage', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();

  const geminiAnswers = body?.gemini_answers;
  if (!geminiAnswers || typeof geminiAnswers !== 'object') {
    return c.json({ error: 'Invalid request: expected { gemini_answers: { "exam_id:question_id": string[] } }' }, 400);
  }

  const limit = Number.isInteger(body?.limit) ? body.limit : 100;

  const pending = await db.prepare(`
    SELECT q.id AS question_id, q.exam_id, q.claude_analysis
    FROM questions q
    WHERE q.claude_analysis IS NOT NULL
      AND q.claude_review IS NULL
    LIMIT ?
  `).bind(limit).all();

  const reviewedAt = new Date().toISOString();
  const settled = [];
  const needsArbitration = [];
  const statements = [];

  for (const row of pending.results) {
    const key = `${row.exam_id}:${row.question_id}`;
    const supplied = geminiAnswers[key];
    if (!supplied) continue; // caller did not extract this one yet

    const claudeAnalysis = JSON.parse(row.claude_analysis);
    const claudeFinal = claudeAnalysis.final_answers || [];

    const agree = answersAgree(claudeFinal, supplied);

    const review = agree
      ? {
          verdict: 'correct',
          confidence: 1,
          claude_answer: claudeFinal.join(' | '),
          gemini_answer: supplied.join(' | '),
          issues: [],
          model_id: 'triage/normalized-compare',
          effort: 'triage',
          reviewed_at: reviewedAt,
        }
      : {
          // Not a verdict yet -- a marker that /pending?stage=arbitrate selects on.
          verdict: 'pending_arbitration',
          confidence: 0,
          claude_answer: claudeFinal.join(' | '),
          gemini_answer: supplied.join(' | '),
          issues: [],
          model_id: 'triage/normalized-compare',
          effort: 'triage',
          reviewed_at: reviewedAt,
        };

    statements.push(
      db.prepare(`UPDATE questions SET claude_review = ? WHERE exam_id = ? AND id = ?`)
        .bind(JSON.stringify(review), row.exam_id, row.question_id)
    );

    (agree ? settled : needsArbitration).push(key);
  }

  if (statements.length > 0) {
    await db.batch(statements);
  }

  return c.json({
    settled_correct: settled.length,
    needs_arbitration: needsArbitration.length,
    arbitration_keys: needsArbitration,
  });
});

// PUT /review - Store the arbitration verdict.
// body: { exam_id, question_id, claude_review }
claudeReviewRoutes.put('/review', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();

  if (!body?.exam_id || !body?.question_id || !body?.claude_review) {
    return c.json({ error: 'Invalid request: expected { exam_id, question_id, claude_review }' }, 400);
  }

  const review = body.claude_review;
  const allowed = ['correct', 'minor_issue', 'incorrect', 'unverifiable'];
  if (!allowed.includes(review.verdict)) {
    return c.json({ error: `verdict must be one of ${allowed.join(', ')}` }, 400);
  }

  const result = await db.prepare(`
    UPDATE questions SET claude_review = ? WHERE exam_id = ? AND id = ?
  `).bind(
    JSON.stringify({ ...review, reviewed_at: review.reviewed_at || new Date().toISOString() }),
    body.exam_id,
    body.question_id
  ).run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'Question not found' }, 404);
  }

  return c.json({ success: true });
});

// The slice of the bank the routines actually work through. Progress is only
// meaningful against this set, not against all 11k questions.
const TARGET_SET = `
  pro_analysis IS NOT NULL
  AND json_extract(pro_analysis, '$.question_type') LIKE '解答%'
  AND COALESCE(json_extract(pro_analysis, '$.difficulty'), 1) >= 4
`;

// GET /knowledge - The knowledge-point taxonomy, as plain text. The solve
// routine fetches this so Claude tags questions from the same vocabulary Gemini
// uses, making the two sides' tags comparable.
claudeReviewRoutes.get('/knowledge', (c) => {
  return c.text(KNOWLEDGE_DIRECTORY);
});

// GET /stats - Verdict breakdown, for a dashboard or a routine's summary line.
claudeReviewRoutes.get('/stats', async (c) => {
  const db = c.env.DB;

  const result = await db.prepare(`
    SELECT
      COALESCE(json_extract(claude_review, '$.verdict'), 'not_reviewed') AS verdict,
      COUNT(*) AS count
    FROM questions
    WHERE pro_analysis IS NOT NULL
    GROUP BY verdict
  `).all();

  const solved = await db.prepare(`
    SELECT COUNT(*) AS n FROM questions WHERE claude_analysis IS NOT NULL
  `).first();

  const target = await db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN claude_analysis IS NOT NULL THEN 1 ELSE 0 END) AS solved,
      SUM(CASE WHEN claude_review IS NOT NULL THEN 1 ELSE 0 END) AS reviewed
    FROM questions
    WHERE ${TARGET_SET}
  `).first();

  const timeExpr = `COALESCE(json_extract(q.claude_review, '$.reviewed_at'), json_extract(q.claude_analysis, '$.solved_at'))`;
  const beijingTime = `datetime(${timeExpr}, '+8 hours')`;

  const activity = await db.prepare(`
    SELECT
      SUM(CASE WHEN strftime('%Y-%m-%d', ${beijingTime}) = strftime('%Y-%m-%d', 'now', '+8 hours') THEN 1 ELSE 0 END) AS today_count,
      SUM(CASE WHEN strftime('%Y-W%W', ${beijingTime}) = strftime('%Y-W%W', 'now', '+8 hours') THEN 1 ELSE 0 END) AS this_week_count,
      SUM(CASE WHEN strftime('%Y-%m', ${beijingTime}) = strftime('%Y-%m', 'now', '+8 hours') THEN 1 ELSE 0 END) AS this_month_count,
      COUNT(DISTINCT strftime('%Y-%m-%d', ${beijingTime})) AS active_days
    FROM questions q
    WHERE q.claude_analysis IS NOT NULL
  `).first();

  return c.json({
    by_verdict: result.results,
    claude_solved: solved.n,
    target: {
      total: target.total,
      solved: target.solved,
      reviewed: target.reviewed,
    },
    activity: {
      today: activity?.today_count || 0,
      this_week: activity?.this_week_count || 0,
      this_month: activity?.this_month_count || 0,
      active_days: activity?.active_days || 0,
    },
  });
});

// GET /timeline - Task completion aggregation grouped by day, week, or month.
// query: mode ('day' | 'week' | 'month', default 'day')
claudeReviewRoutes.get('/timeline', async (c) => {
  const db = c.env.DB;
  const mode = c.req.query('mode') || 'day';

  if (!['day', 'week', 'month'].includes(mode)) {
    return c.json({ error: 'mode must be one of day, week, month' }, 400);
  }

  const timeExpr = `COALESCE(json_extract(q.claude_review, '$.reviewed_at'), json_extract(q.claude_analysis, '$.solved_at'))`;
  const beijingTime = `datetime(${timeExpr}, '+8 hours')`;

  let groupExpr;
  let extraSelect = '';

  if (mode === 'day') {
    groupExpr = `strftime('%Y-%m-%d', ${beijingTime})`;
  } else if (mode === 'week') {
    groupExpr = `strftime('%Y-W%W', ${beijingTime})`;
    extraSelect = `,
      date(${beijingTime}, 'weekday 0', '-6 days') AS week_start,
      date(${beijingTime}, 'weekday 0') AS week_end
    `;
  } else {
    // month
    groupExpr = `strftime('%Y-%m', ${beijingTime})`;
  }

  const query = `
    SELECT
      COALESCE(${groupExpr}, 'undated') AS period_key,
      ${extraSelect}
      COUNT(*) AS total,
      SUM(CASE WHEN json_extract(q.claude_review, '$.verdict') = 'correct' THEN 1 ELSE 0 END) AS correct,
      SUM(CASE WHEN json_extract(q.claude_review, '$.verdict') = 'incorrect' THEN 1 ELSE 0 END) AS incorrect,
      SUM(CASE WHEN json_extract(q.claude_review, '$.verdict') = 'minor_issue' THEN 1 ELSE 0 END) AS minor_issue,
      SUM(CASE WHEN json_extract(q.claude_review, '$.verdict') = 'unverifiable' THEN 1 ELSE 0 END) AS unverifiable,
      SUM(CASE WHEN json_extract(q.claude_review, '$.verdict') = 'pending_arbitration' THEN 1 ELSE 0 END) AS pending_arbitration,
      SUM(CASE WHEN q.claude_review IS NULL THEN 1 ELSE 0 END) AS unreviewed,
      GROUP_CONCAT(DISTINCT e.name) AS exam_names
    FROM questions q
    JOIN exams e ON e.id = q.exam_id
    WHERE q.claude_analysis IS NOT NULL
    GROUP BY period_key
    ORDER BY CASE WHEN period_key = 'undated' THEN 1 ELSE 0 END, period_key DESC
  `;

  const rows = await db.prepare(query).all();

  const activity = await db.prepare(`
    SELECT
      COUNT(*) AS total_solved,
      SUM(CASE WHEN strftime('%Y-%m-%d', ${beijingTime}) = strftime('%Y-%m-%d', 'now', '+8 hours') THEN 1 ELSE 0 END) AS today_count,
      SUM(CASE WHEN strftime('%Y-W%W', ${beijingTime}) = strftime('%Y-W%W', 'now', '+8 hours') THEN 1 ELSE 0 END) AS this_week_count,
      SUM(CASE WHEN strftime('%Y-%m', ${beijingTime}) = strftime('%Y-%m', 'now', '+8 hours') THEN 1 ELSE 0 END) AS this_month_count,
      COUNT(DISTINCT strftime('%Y-%m-%d', ${beijingTime})) AS active_days
    FROM questions q
    WHERE q.claude_analysis IS NOT NULL
  `).first();

  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  const periods = rows.results.map((row) => {
    let label = row.period_key;
    let startDate = row.period_key;
    let endDate = row.period_key;

    if (row.period_key === 'undated') {
      label = '历史未记日期';
      startDate = null;
      endDate = null;
    } else if (mode === 'day') {
      const d = new Date(`${row.period_key}T00:00:00+08:00`);
      const dayOfWeek = WEEKDAYS[d.getDay()] || '';
      label = `${row.period_key} (${dayOfWeek})`;
      startDate = row.period_key;
      endDate = row.period_key;
    } else if (mode === 'week') {
      startDate = row.week_start;
      endDate = row.week_end;
      const parts = row.period_key.split('-W');
      const year = parts[0];
      const weekNum = parseInt(parts[1] || '0', 10);
      const startParts = (row.week_start || '').split('-');
      const endParts = (row.week_end || '').split('-');
      const shortStart = startParts.length === 3 ? `${startParts[1]}/${startParts[2]}` : '';
      const shortEnd = endParts.length === 3 ? `${endParts[1]}/${endParts[2]}` : '';
      label = `${year}年第${weekNum}周 (${shortStart} ~ ${shortEnd})`;
    } else if (mode === 'month') {
      const [year, month] = row.period_key.split('-');
      label = `${year}年${parseInt(month, 10)}月`;
      startDate = `${row.period_key}-01`;
      const y = parseInt(year, 10);
      const m = parseInt(month, 10);
      const lastDay = new Date(y, m, 0).getDate();
      endDate = `${row.period_key}-${String(lastDay).padStart(2, '0')}`;
    }

    const examList = row.exam_names ? row.exam_names.split(',').filter(Boolean) : [];

    return {
      key: row.period_key,
      label,
      start_date: startDate,
      end_date: endDate,
      total: row.total,
      by_verdict: {
        correct: row.correct || 0,
        minor_issue: row.minor_issue || 0,
        incorrect: row.incorrect || 0,
        unverifiable: row.unverifiable || 0,
        pending_arbitration: row.pending_arbitration || 0,
        unreviewed: row.unreviewed || 0,
      },
      exams: examList.slice(0, 10),
      exam_count: examList.length,
    };
  });

  return c.json({
    mode,
    periods,
    summary: {
      total_solved: activity?.total_solved || 0,
      today: activity?.today_count || 0,
      this_week: activity?.this_week_count || 0,
      this_month: activity?.this_month_count || 0,
      active_days: activity?.active_days || 0,
    },
  });
});

// GET /questions - Paged list of everything Claude has solved.
// query: verdict, mode, period, start_date, end_date, limit, offset
claudeReviewRoutes.get('/questions', async (c) => {
  const db = c.env.DB;

  const verdict = c.req.query('verdict') || null;
  const limit = Math.min(parseInt(c.req.query('limit') || '24', 10) || 24, 100);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);

  const timeExpr = `COALESCE(json_extract(q.claude_review, '$.reviewed_at'), json_extract(q.claude_analysis, '$.solved_at'))`;
  const beijingTime = `datetime(${timeExpr}, '+8 hours')`;

  const filters = ['q.claude_analysis IS NOT NULL'];
  const params = [];

  // 'unreviewed' means solved but triage has not settled it yet.
  if (verdict === 'unreviewed') {
    filters.push('q.claude_review IS NULL');
  } else if (verdict) {
    filters.push(`json_extract(q.claude_review, '$.verdict') = ?`);
    params.push(verdict);
  }

  // Period / Date filters
  const period = c.req.query('period');
  const mode = c.req.query('mode');
  const startDate = c.req.query('start_date');
  const endDate = c.req.query('end_date');

  if (period === 'undated') {
    filters.push(`${timeExpr} IS NULL`);
  } else if (startDate && endDate) {
    filters.push(`date(${beijingTime}) >= ? AND date(${beijingTime}) <= ?`);
    params.push(startDate, endDate);
  } else if (mode === 'day' && period) {
    filters.push(`strftime('%Y-%m-%d', ${beijingTime}) = ?`);
    params.push(period);
  } else if (mode === 'week' && period) {
    filters.push(`strftime('%Y-W%W', ${beijingTime}) = ?`);
    params.push(period);
  } else if (mode === 'month' && period) {
    filters.push(`strftime('%Y-%m', ${beijingTime}) = ?`);
    params.push(period);
  } else if (period && period.match(/^\d{4}-\d{2}-\d{2}$/)) {
    filters.push(`strftime('%Y-%m-%d', ${beijingTime}) = ?`);
    params.push(period);
  }

  const whereClause = filters.join(' AND ');

  const rows = await db.prepare(`
    SELECT
      q.id AS question_id,
      q.exam_id,
      q.data_url,
      q.page_number,
      e.name AS exam_name,
      json_extract(q.pro_analysis, '$.difficulty') AS difficulty,
      json_extract(q.pro_analysis, '$.question_type') AS question_type,
      json_extract(q.claude_review, '$.verdict') AS verdict,
      json_extract(q.claude_review, '$.confidence') AS confidence,
      json_extract(q.claude_review, '$.effort') AS effort,
      json_extract(q.claude_review, '$.claude_answer') AS claude_answer,
      json_extract(q.claude_review, '$.gemini_answer') AS gemini_answer,
      json_extract(q.claude_analysis, '$.final_answers') AS claude_final_answers,
      json_extract(q.claude_review, '$.reviewed_at') AS reviewed_at,
      json_extract(q.claude_analysis, '$.solved_at') AS solved_at,
      COALESCE(
        json_extract(q.claude_review, '$.reviewed_at'),
        json_extract(q.claude_analysis, '$.solved_at')
      ) AS completed_at
    FROM questions q
    JOIN exams e ON e.id = q.exam_id
    WHERE ${whereClause}
    ORDER BY
      COALESCE(
        json_extract(q.claude_review, '$.reviewed_at'),
        json_extract(q.claude_analysis, '$.solved_at')
      ) DESC,
      e.timestamp DESC,
      q.page_number,
      q.id
    LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all();

  const totalRow = await db.prepare(`
    SELECT COUNT(*) AS n
    FROM questions q
    WHERE ${whereClause}
  `).bind(...params).first();

  return c.json({
    questions: rows.results.map((q) => ({
      ...q,
      claude_final_answers: q.claude_final_answers ? JSON.parse(q.claude_final_answers) : [],
    })),
    total: totalRow.n,
    limit,
    offset,
  });
});

// GET /questions/:examId/:questionId - Everything about one question, for the detail view.
claudeReviewRoutes.get('/questions/:examId/:questionId', async (c) => {
  const db = c.env.DB;

  const row = await db.prepare(`
    SELECT
      q.id AS question_id,
      q.exam_id,
      q.data_url,
      q.page_number,
      q.analysis,
      q.pro_analysis,
      q.claude_analysis,
      q.claude_review,
      e.name AS exam_name
    FROM questions q
    JOIN exams e ON e.id = q.exam_id
    WHERE q.exam_id = ? AND q.id = ?
  `).bind(c.req.param('examId'), c.req.param('questionId')).first();

  if (!row) {
    return c.json({ error: 'Question not found' }, 404);
  }

  const parse = (v) => (v ? JSON.parse(v) : null);

  return c.json({
    ...row,
    analysis: parse(row.analysis),
    pro_analysis: parse(row.pro_analysis),
    claude_analysis: parse(row.claude_analysis),
    claude_review: parse(row.claude_review),
  });
});

export default claudeReviewRoutes;
