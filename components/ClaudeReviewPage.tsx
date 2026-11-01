import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { resolveImageUrl } from "../services/r2Service";
import { ReviewVerdict } from "../types";

const PAGE_SIZE = 24;

// 'pending_arbitration' is written by the server-side triage as a marker, not a
// real verdict, so it is listed here alongside the four terminal verdicts.
type FilterValue = ReviewVerdict | "pending_arbitration" | "unreviewed" | "";
type TimelineMode = "day" | "week" | "month" | "all";

interface ReviewQuestion {
  question_id: string;
  exam_id: string;
  data_url: string;
  page_number: number;
  exam_name: string;
  difficulty: number | null;
  question_type: string | null;
  verdict: FilterValue | null;
  confidence: number | null;
  effort: string | null;
  claude_answer: string | null;
  gemini_answer: string | null;
  claude_final_answers: string[];
  reviewed_at?: string | null;
  solved_at?: string | null;
  completed_at?: string | null;
}

interface Stats {
  by_verdict: { verdict: string; count: number }[];
  claude_solved: number;
  target: { total: number; solved: number; reviewed: number };
  activity?: {
    today: number;
    this_week: number;
    this_month: number;
    active_days: number;
  };
}

interface TimelinePeriod {
  key: string;
  label: string;
  start_date: string | null;
  end_date: string | null;
  total: number;
  by_verdict: {
    correct: number;
    minor_issue: number;
    incorrect: number;
    unverifiable: number;
    pending_arbitration: number;
    unreviewed: number;
  };
  exams: string[];
  exam_count: number;
}

interface TimelineResponse {
  mode: "day" | "week" | "month";
  periods: TimelinePeriod[];
  summary: {
    total_solved: number;
    today: number;
    this_week: number;
    this_month: number;
    active_days: number;
  };
}

const VERDICT_STYLE: Record<string, { label: string; cls: string; dotCls: string }> = {
  correct: {
    label: "Gemini 正确",
    cls: "bg-emerald-50 text-emerald-700 border-emerald-200",
    dotCls: "bg-emerald-500",
  },
  minor_issue: {
    label: "过程有瑕疵",
    cls: "bg-amber-50 text-amber-700 border-amber-200",
    dotCls: "bg-amber-500",
  },
  incorrect: {
    label: "Gemini 错误",
    cls: "bg-rose-50 text-rose-700 border-rose-200",
    dotCls: "bg-rose-500",
  },
  unverifiable: {
    label: "无法判定",
    cls: "bg-slate-100 text-slate-600 border-slate-200",
    dotCls: "bg-slate-400",
  },
  pending_arbitration: {
    label: "待仲裁",
    cls: "bg-indigo-50 text-indigo-700 border-indigo-200",
    dotCls: "bg-indigo-500",
  },
};

const FILTERS: { value: FilterValue; label: string }[] = [
  { value: "", label: "全部" },
  { value: "correct", label: "Gemini 正确" },
  { value: "incorrect", label: "Gemini 错误" },
  { value: "minor_issue", label: "过程有瑕疵" },
  { value: "pending_arbitration", label: "待仲裁" },
  { value: "unverifiable", label: "无法判定" },
  { value: "unreviewed", label: "未分诊" },
];

/**
 * Format ISO datetime into Beijing time string (YYYY-MM-DD HH:mm)
 */
function formatBeijingDateTime(isoStr?: string | null): string {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .format(d)
      .replace(/\//g, "-");
  } catch {
    return "";
  }
}

const VerdictBadge: React.FC<{ verdict: string | null }> = ({ verdict }) => {
  const style = verdict ? VERDICT_STYLE[verdict] : null;
  if (!style) {
    return (
      <span className="px-2 py-0.5 text-xs rounded-full border bg-white text-slate-400 border-slate-200">
        未分诊
      </span>
    );
  }
  return <span className={`px-2 py-0.5 text-xs rounded-full border ${style.cls}`}>{style.label}</span>;
};

const ProgressBar: React.FC<{ stats: Stats }> = ({ stats }) => {
  const { total, solved, reviewed } = stats.target;
  if (!total) return null;

  const solvedPct = (solved / total) * 100;
  const reviewedPct = (reviewed / total) * 100;

  // At 15 questions per daily run, the remaining work is this many days out.
  const remaining = total - solved;
  const daysLeft = Math.ceil(remaining / 15);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-700">
          核查总进度
          <span className="ml-2 font-normal text-slate-400">难度 ≥4 的解答题</span>
        </h2>
        <span className="text-sm text-slate-500 font-medium">
          {solved} / {total}
        </span>
      </div>

      <div className="relative h-3 bg-slate-100 rounded-full overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 bg-indigo-200 transition-all"
          style={{ width: `${solvedPct}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 bg-indigo-600 transition-all"
          style={{ width: `${reviewedPct}%` }}
        />
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs text-slate-500">
        <span>
          <span className="inline-block w-2 h-2 rounded-full bg-indigo-200 mr-1.5 align-middle" />
          已解答 {solved}
        </span>
        <span>
          <span className="inline-block w-2 h-2 rounded-full bg-indigo-600 mr-1.5 align-middle" />
          已核查 {reviewed}
        </span>
        <span>剩余 {remaining}，按每天 15 道约需 {daysLeft} 天</span>
      </div>

      <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-slate-100">
        {stats.by_verdict
          .filter((v) => v.verdict !== "not_reviewed")
          .map((v) => (
            <div key={v.verdict} className="flex items-center gap-1.5">
              <VerdictBadge verdict={v.verdict} />
              <span className="text-sm font-medium text-slate-700 tabular-nums">{v.count}</span>
            </div>
          ))}
      </div>
    </div>
  );
};

export const ClaudeReviewPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  // Mode: 'day' | 'week' | 'month' | 'all'
  const mode = (searchParams.get("mode") || "day") as TimelineMode;
  const period = searchParams.get("period") || "";
  const verdict = (searchParams.get("verdict") || "") as FilterValue;
  const page = Math.max(parseInt(searchParams.get("page") || "1", 10) || 1, 1);
  const offset = (page - 1) * PAGE_SIZE;

  const [stats, setStats] = useState<Stats | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [questions, setQuestions] = useState<ReviewQuestion[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoadingTimeline, setIsLoadingTimeline] = useState(false);
  const [isLoadingQuestions, setIsLoadingQuestions] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // URL State Helpers
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === "") {
          next.delete(k);
        } else {
          next.set(k, v);
        }
      }
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  const handleModeChange = useCallback(
    (nextMode: TimelineMode) => {
      if (nextMode === "all") {
        updateUrlParams({ mode: "all", period: null, page: null });
      } else {
        updateUrlParams({ mode: nextMode, period: null, page: null });
      }
    },
    [updateUrlParams],
  );

  const handlePeriodChange = useCallback(
    (nextPeriod: string) => {
      updateUrlParams({ period: nextPeriod, page: null });
    },
    [updateUrlParams],
  );

  const handleVerdictFilter = useCallback(
    (nextVerdict: FilterValue) => {
      updateUrlParams({ verdict: nextVerdict || null, page: null });
    },
    [updateUrlParams],
  );

  const setPage = useCallback(
    (nextPage: number) => {
      updateUrlParams({ page: nextPage > 1 ? String(nextPage) : null });
    },
    [updateUrlParams],
  );

  // 1. Fetch overall stats once
  useEffect(() => {
    fetch("/api/claude-review/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  // 2. Fetch timeline when in day / week / month mode
  useEffect(() => {
    if (mode === "all") {
      setTimeline(null);
      return;
    }

    setIsLoadingTimeline(true);
    fetch(`/api/claude-review/timeline?mode=${mode}`)
      .then((r) => {
        if (!r.ok) throw new Error("获取时间线失败");
        return r.json();
      })
      .then((data: TimelineResponse) => {
        setTimeline(data);

        // If no period is specified in URL, automatically select the first (most recent) period
        if (!period && data.periods.length > 0) {
          const firstPeriod = data.periods[0].key;
          updateUrlParams({ period: firstPeriod });
        }
      })
      .catch(() => {})
      .finally(() => setIsLoadingTimeline(false));
  }, [mode, period, updateUrlParams]);

  // 3. Fetch questions matching current period & verdict
  useEffect(() => {
    setIsLoadingQuestions(true);
    setError(null);

    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });

    if (verdict) params.set("verdict", verdict);

    if (mode !== "all" && period) {
      params.set("mode", mode);
      params.set("period", period);
    }

    fetch(`/api/claude-review/questions?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`请求题目失败 (${r.status})`);
        return r.json();
      })
      .then((data) => {
        setQuestions(data.questions || []);
        setTotal(data.total || 0);
      })
      .catch((e) => setError(e.message))
      .finally(() => setIsLoadingQuestions(false));
  }, [mode, period, verdict, offset]);

  // Find currently selected period object
  const activePeriod = useMemo(() => {
    if (!timeline || !period) return null;
    return timeline.periods.find((p) => p.key === period) || null;
  }, [timeline, period]);

  // Current period index and adjacent period keys for stepping through
  const { prevPeriodKey, nextPeriodKey } = useMemo(() => {
    if (!timeline || !period) return { prevPeriodKey: null, nextPeriodKey: null };
    const idx = timeline.periods.findIndex((p) => p.key === period);
    if (idx === -1) return { prevPeriodKey: null, nextPeriodKey: null };
    // periods are sorted descending (latest first)
    // "prev" in chronological order means older (idx + 1)
    // "next" in chronological order means newer (idx - 1)
    const prevKey = idx < timeline.periods.length - 1 ? timeline.periods[idx + 1].key : null;
    const nextKey = idx > 0 ? timeline.periods[idx - 1].key : null;
    return { prevPeriodKey: prevKey, nextPeriodKey: nextKey };
  }, [timeline, period]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Activity summary stats
  const activitySummary = timeline?.summary || stats?.activity;

  return (
    <div className="max-w-7xl mx-auto py-8 px-4 sm:px-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <span>Claude 核查</span>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 font-medium">
              独立解题与对账
            </span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Claude 独立解答后与 Gemini Pro 对账，按天、按周、按月随时追踪完成进度与题目明细
          </p>
        </div>
        <Link
          to="/"
          className="inline-flex items-center text-sm font-medium text-slate-500 hover:text-indigo-600 transition-colors"
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          返回首页
        </Link>
      </div>

      {/* Progress & KPI Metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2">
          {stats && <ProgressBar stats={stats} />}
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm flex flex-col justify-between">
          <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center justify-between">
            <span>工作量统计</span>
            <span className="text-xs font-normal text-slate-400">北京时间 (UTC+8)</span>
          </h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
              <div className="text-xs text-slate-500">今日完成</div>
              <div className="text-xl font-bold text-slate-800 tabular-nums mt-0.5">
                {activitySummary?.today ?? 0}
                <span className="text-xs font-normal text-slate-400 ml-1">道</span>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
              <div className="text-xs text-slate-500">本周完成</div>
              <div className="text-xl font-bold text-indigo-600 tabular-nums mt-0.5">
                {activitySummary?.this_week ?? 0}
                <span className="text-xs font-normal text-slate-400 ml-1">道</span>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
              <div className="text-xs text-slate-500">本月完成</div>
              <div className="text-xl font-bold text-slate-800 tabular-nums mt-0.5">
                {activitySummary?.this_month ?? 0}
                <span className="text-xs font-normal text-slate-400 ml-1">道</span>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
              <div className="text-xs text-slate-500">累计解答</div>
              <div className="text-xl font-bold text-slate-800 tabular-nums mt-0.5">
                {stats?.claude_solved ?? 0}
                <span className="text-xs font-normal text-slate-400 ml-1">道</span>
              </div>
            </div>
          </div>
          {activitySummary?.active_days ? (
            <div className="mt-3 pt-3 border-t border-slate-100 text-xs text-slate-400 text-center">
              已累计连续在 <span className="font-semibold text-slate-600">{activitySummary.active_days}</span> 个自然日执行核查
            </div>
          ) : null}
        </div>
      </div>

      {/* Main Dimension Switcher Tabs */}
      <div className="bg-white rounded-2xl border border-slate-200 p-2 mb-6 shadow-sm flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 p-1 bg-slate-100 rounded-xl">
          <button
            onClick={() => handleModeChange("day")}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all flex items-center gap-1.5 ${
              mode === "day"
                ? "bg-white text-indigo-600 shadow-sm font-semibold"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <span>📅</span> 按天查看
          </button>
          <button
            onClick={() => handleModeChange("week")}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all flex items-center gap-1.5 ${
              mode === "week"
                ? "bg-white text-indigo-600 shadow-sm font-semibold"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <span>🗓️</span> 按周查看
          </button>
          <button
            onClick={() => handleModeChange("month")}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all flex items-center gap-1.5 ${
              mode === "month"
                ? "bg-white text-indigo-600 shadow-sm font-semibold"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <span>📊</span> 按月查看
          </button>
          <button
            onClick={() => handleModeChange("all")}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all flex items-center gap-1.5 ${
              mode === "all"
                ? "bg-white text-indigo-600 shadow-sm font-semibold"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            <span>📋</span> 全部题目
          </button>
        </div>

        {/* Step through periods controls */}
        {mode !== "all" && timeline && timeline.periods.length > 0 && (
          <div className="flex items-center gap-2 pr-2">
            <button
              onClick={() => prevPeriodKey && handlePeriodChange(prevPeriodKey)}
              disabled={!prevPeriodKey}
              className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 bg-white text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed hover:border-indigo-300 transition-colors flex items-center gap-1"
              title="切换到上一期"
            >
              <span>◀</span>
              <span>上一{mode === "day" ? "天" : mode === "week" ? "周" : "月"}</span>
            </button>

            <select
              value={period}
              onChange={(e) => handlePeriodChange(e.target.value)}
              className="text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 cursor-pointer"
            >
              {timeline.periods.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label} ({p.total}题)
                </option>
              ))}
            </select>

            <button
              onClick={() => nextPeriodKey && handlePeriodChange(nextPeriodKey)}
              disabled={!nextPeriodKey}
              className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 bg-white text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed hover:border-indigo-300 transition-colors flex items-center gap-1"
              title="切换到下一期"
            >
              <span>下一{mode === "day" ? "天" : mode === "week" ? "周" : "月"}</span>
              <span>▶</span>
            </button>
          </div>
        )}
      </div>

      {/* Timeline Periods Carousel / List */}
      {mode !== "all" && (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2.5 px-1">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              {mode === "day"
                ? "每日任务完成记录"
                : mode === "week"
                ? "每周任务完成记录"
                : "每月任务完成记录"}
              {timeline && (
                <span className="ml-2 font-normal text-slate-400 lowercase">
                  (共 {timeline.periods.length} 个时段)
                </span>
              )}
            </h3>
            {period && (
              <button
                onClick={() => updateUrlParams({ period: null, mode: "all" })}
                className="text-xs text-indigo-600 hover:text-indigo-800 transition-colors"
              >
                查看全部题目 &rarr;
              </button>
            )}
          </div>

          {isLoadingTimeline ? (
            <div className="h-28 bg-white rounded-2xl border border-slate-200 flex items-center justify-center text-sm text-slate-400">
              加载时段数据中…
            </div>
          ) : timeline?.periods.length === 0 ? (
            <div className="h-28 bg-white rounded-2xl border border-slate-200 flex items-center justify-center text-sm text-slate-400">
              暂无已记录日期的完成任务
            </div>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-slate-200">
              {timeline?.periods.map((p) => {
                const isSelected = p.key === period;
                const correctCount = p.by_verdict.correct;
                const incorrectCount = p.by_verdict.incorrect;
                const minorCount = p.by_verdict.minor_issue;
                const unreviewedCount = p.by_verdict.unreviewed;

                return (
                  <button
                    key={p.key}
                    onClick={() => handlePeriodChange(p.key)}
                    className={`shrink-0 w-60 text-left p-3.5 rounded-xl border transition-all text-xs ${
                      isSelected
                        ? "bg-indigo-50/60 border-indigo-600 ring-2 ring-indigo-500/20 shadow-sm"
                        : "bg-white border-slate-200 hover:border-indigo-300 hover:shadow-sm"
                    }`}
                  >
                    <div className="flex items-baseline justify-between mb-1">
                      <span className={`font-semibold truncate ${isSelected ? "text-indigo-900" : "text-slate-800"}`} title={p.label}>
                        {p.label}
                      </span>
                      <span className={`font-bold text-sm tabular-nums ml-2 shrink-0 ${isSelected ? "text-indigo-600" : "text-slate-700"}`}>
                        {p.total} <span className="text-xs font-normal text-slate-400">题</span>
                      </span>
                    </div>

                    {/* Miniature verdict distribution bar */}
                    <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden flex my-2">
                      {correctCount > 0 && (
                        <div
                          style={{ width: `${(correctCount / p.total) * 100}%` }}
                          className="bg-emerald-500"
                          title={`正确: ${correctCount}`}
                        />
                      )}
                      {minorCount > 0 && (
                        <div
                          style={{ width: `${(minorCount / p.total) * 100}%` }}
                          className="bg-amber-400"
                          title={`瑕疵: ${minorCount}`}
                        />
                      )}
                      {incorrectCount > 0 && (
                        <div
                          style={{ width: `${(incorrectCount / p.total) * 100}%` }}
                          className="bg-rose-500"
                          title={`错误: ${incorrectCount}`}
                        />
                      )}
                      {unreviewedCount > 0 && (
                        <div
                          style={{ width: `${(unreviewedCount / p.total) * 100}%` }}
                          className="bg-slate-300"
                          title={`未分诊: ${unreviewedCount}`}
                        />
                      )}
                    </div>

                    {/* Breakdown pills */}
                    <div className="flex items-center gap-2 text-[11px] text-slate-500 mb-2 tabular-nums">
                      {correctCount > 0 && (
                        <span className="text-emerald-700 font-medium">
                          ✓ {correctCount}
                        </span>
                      )}
                      {incorrectCount > 0 && (
                        <span className="text-rose-600 font-medium">
                          ✗ {incorrectCount}
                        </span>
                      )}
                      {minorCount > 0 && (
                        <span className="text-amber-700 font-medium">
                          ⚠ {minorCount}
                        </span>
                      )}
                      {unreviewedCount > 0 && (
                        <span className="text-slate-400">
                          待分诊 {unreviewedCount}
                        </span>
                      )}
                    </div>

                    {/* Exams worked on */}
                    {p.exams.length > 0 && (
                      <div className="text-[11px] text-slate-400 truncate pt-1.5 border-t border-slate-100/80">
                        {p.exams.slice(0, 2).join(" · ")}
                        {p.exam_count > 2 ? ` 等${p.exam_count}套` : ""}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Active Period / Filter Banner */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 mb-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-bold text-slate-800">
              {mode === "all"
                ? "全部题目明细"
                : activePeriod
                ? `${activePeriod.label} 完成的题目`
                : "题目明细"}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium tabular-nums">
              共 {total} 道
            </span>
            {activePeriod?.exams && activePeriod.exams.length > 0 && (
              <div className="hidden md:flex items-center gap-1 ml-2 text-xs text-slate-400">
                <span>涉及试卷：</span>
                <span className="text-slate-600">{activePeriod.exams.slice(0, 3).join("、")}</span>
                {activePeriod.exam_count > 3 && <span>等{activePeriod.exam_count}套试卷</span>}
              </div>
            )}
          </div>

          {period && mode !== "all" && (
            <button
              onClick={() => updateUrlParams({ period: null, mode: "all" })}
              className="text-xs text-indigo-600 hover:text-indigo-800 transition-colors self-start sm:self-auto"
            >
              清除时段，查看全部 &rarr;
            </button>
          )}
        </div>

        {/* Verdict Filter Buttons */}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
          {FILTERS.map((f) => {
            const isFilterActive = verdict === f.value;
            // Calculate count for this filter within current period if available
            let countForFilter: number | null = null;
            if (activePeriod) {
              if (f.value === "") countForFilter = activePeriod.total;
              else if (f.value === "correct") countForFilter = activePeriod.by_verdict.correct;
              else if (f.value === "incorrect") countForFilter = activePeriod.by_verdict.incorrect;
              else if (f.value === "minor_issue") countForFilter = activePeriod.by_verdict.minor_issue;
              else if (f.value === "pending_arbitration") countForFilter = activePeriod.by_verdict.pending_arbitration;
              else if (f.value === "unverifiable") countForFilter = activePeriod.by_verdict.unverifiable;
              else if (f.value === "unreviewed") countForFilter = activePeriod.by_verdict.unreviewed;
            }

            return (
              <button
                key={f.value || "all"}
                onClick={() => handleVerdictFilter(f.value)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-all flex items-center gap-1.5 ${
                  isFilterActive
                    ? "bg-indigo-600 text-white border-indigo-600 shadow-sm font-medium"
                    : "bg-white text-slate-600 border-slate-200 hover:border-indigo-300"
                }`}
              >
                <span>{f.label}</span>
                {countForFilter !== null && (
                  <span
                    className={`px-1.5 py-0.2 rounded-full text-[10px] tabular-nums ${
                      isFilterActive ? "bg-indigo-700/80 text-white" : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {countForFilter}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm mb-6">
          {error}
        </div>
      )}

      {/* Questions List */}
      {isLoadingQuestions ? (
        <div className="py-24 text-center text-slate-400 bg-white rounded-2xl border border-slate-200">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-4 border-indigo-600 border-t-transparent mb-3" />
          <div>加载题目中…</div>
        </div>
      ) : questions.length === 0 ? (
        <div className="py-24 text-center text-slate-400 bg-white rounded-2xl border border-slate-200 px-4">
          <div className="text-4xl mb-2">📭</div>
          <div className="font-medium text-slate-600 mb-1">该时段没有符合筛选条件的题目</div>
          <div className="text-xs text-slate-400">
            {verdict ? "可以尝试切换上方结论筛选（如切换为全部）" : "该时段 Claude 未处理题目或该分类暂无数据"}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {questions.map((q) => {
              const completedTimeStr = formatBeijingDateTime(q.completed_at || q.reviewed_at || q.solved_at);

              return (
                <Link
                  key={`${q.exam_id}:${q.question_id}`}
                  to={`/claude-review/${encodeURIComponent(q.exam_id)}/${encodeURIComponent(q.question_id)}`}
                  className="group bg-white rounded-2xl border border-slate-200 overflow-hidden hover:border-indigo-300 hover:shadow-lg transition-all flex flex-col"
                >
                  <div className="h-44 bg-slate-50 overflow-hidden border-b border-slate-100 relative">
                    <img
                      src={resolveImageUrl(q.data_url)}
                      alt={`第 ${q.question_id} 题`}
                      loading="lazy"
                      className="w-full h-full object-cover object-top group-hover:scale-[1.02] transition-transform"
                    />
                    {completedTimeStr && (
                      <span className="absolute bottom-2 right-2 bg-slate-900/70 backdrop-blur-sm text-white text-[11px] px-2 py-0.5 rounded-md font-mono">
                        {completedTimeStr}
                      </span>
                    )}
                  </div>

                  <div className="p-4 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-semibold text-slate-700">
                          第 {q.question_id} 题
                          {q.difficulty != null && (
                            <span className="ml-2 text-xs font-normal text-slate-400">
                              难度 {q.difficulty}
                            </span>
                          )}
                        </span>
                        <VerdictBadge verdict={q.verdict} />
                      </div>

                      <div className="text-xs text-slate-400 truncate mb-2" title={q.exam_name}>
                        {q.exam_name}
                      </div>

                      {q.claude_answer && q.gemini_answer && (
                        <div className="space-y-1.5 text-xs pt-2.5 border-t border-slate-100">
                          <div className="flex gap-2 items-baseline">
                            <span className="text-indigo-600 font-semibold shrink-0 w-12 text-[11px]">Claude</span>
                            <span className="text-slate-700 truncate font-mono text-[11px]" title={q.claude_answer}>
                              {q.claude_answer}
                            </span>
                          </div>
                          <div className="flex gap-2 items-baseline">
                            <span className="text-slate-400 font-medium shrink-0 w-12 text-[11px]">Gemini</span>
                            <span className="text-slate-500 truncate font-mono text-[11px]" title={q.gemini_answer}>
                              {q.gemini_answer}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>

                    {q.effort && (
                      <div className="mt-3 pt-2 border-t border-slate-50 flex items-center justify-between text-[11px] text-slate-400">
                        <span>模式: {q.effort}</span>
                        {q.confidence != null && (
                          <span>置信度: {Math.round(q.confidence * 100)}%</span>
                        )}
                      </div>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-8">
              <button
                onClick={() => setPage(page - 1)}
                disabled={page <= 1}
                className="px-4 py-2 text-sm rounded-lg border border-slate-200 bg-white text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed hover:border-indigo-300 transition-colors"
              >
                上一页
              </button>
              <span className="text-sm text-slate-500 tabular-nums">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(page + 1)}
                disabled={page >= totalPages}
                className="px-4 py-2 text-sm rounded-lg border border-slate-200 bg-white text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed hover:border-indigo-300 transition-colors"
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};
