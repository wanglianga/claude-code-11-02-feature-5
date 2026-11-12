import {
  BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import crypto from 'crypto';
import { one, q } from './db';
import { replayQueue } from './queues';

/**
 * 任务运行回放 API
 *  - GET  /runs/:id/trace            单次执行的结构化回放轨迹（导航/筛选/元素/截图/文件/解析/失败位置）
 *  - POST /runs/:id/replay           在隔离模式重放（只写回放表，请求带标记，不污染正式记录）
 *  - GET  /replays                   回放列表（?runId= / ?taskId=）
 *  - GET  /replays/:id               回放详情（步骤 + 带标记请求审计）
 *  - GET  /tasks/:id/replay/compare  同一任务两次执行的差异对比（runA/runB）
 */

interface TraceStep {
  seq: number; name: string; status: string; message: string | null;
  screenshot_path: string | null; meta: any; created_at: string;
}

/** 由 run_steps 的结构化 meta 派生回放轨迹 */
async function buildRunTrace(runId: string) {
  const run = await one<any>(
    `SELECT r.id, r.task_id, r.attempt_no, r.status, r.error_code, r.error_message, r.worker_id, r.started_at, r.finished_at,
            t.biz_date::text, t.source_kind, t.status AS task_status,
            s.code AS store_code, s.name AS store_name,
            p.code AS platform_code, p.name AS platform_name, a.username
     FROM task_runs r
     JOIN source_tasks t ON t.id = r.task_id
     JOIN stores s ON s.id = t.store_id
     JOIN platforms p ON p.id = t.platform_id
     JOIN platform_accounts a ON a.id = t.account_id
     WHERE r.id = $1`, [runId]);
  if (!run) return null;
  const steps: TraceStep[] = await q(`SELECT * FROM run_steps WHERE run_id=$1 ORDER BY seq`, [runId]);
  const files: any[] = await q(
    `SELECT id, run_id, origin, file_name, sha256, size_bytes, downloaded_at, revision, status, meta
     FROM collected_files WHERE run_id=$1 ORDER BY created_at`, [runId]);
  const fileIds = files.map((f) => f.id);
  const batches: any[] = fileIds.length
    ? await q(`SELECT * FROM parse_batches WHERE file_id = ANY($1) ORDER BY created_at`, [fileIds]) : [];
  const issues: any[] = fileIds.length
    ? await q(`SELECT * FROM mapping_issues WHERE file_id = ANY($1) ORDER BY id`, [fileIds]) : [];
  const interventions: any[] = await q(`SELECT * FROM interventions WHERE run_id=$1 ORDER BY created_at`, [runId]);

  const navigation = steps
    .filter((s) => s.meta?.event === 'navigation')
    .map((s) => ({ seq: s.seq, url: s.meta.url, phase: s.meta.phase, platform: s.meta.platform, at: s.created_at }));
  const filters = steps
    .filter((s) => s.meta?.event === 'filter')
    .map((s) => ({ seq: s.seq, ...s.meta }));
  const elementChecks = steps
    .filter((s) => s.meta?.event === 'element_probe')
    .flatMap((s) => (s.meta.elements || []).map((e: any) => ({
      seq: s.seq, label: s.meta.label, url: s.meta.url, selector: e.selector, found: !!e.found,
    })));
  const screenshots = steps
    .filter((s) => s.screenshot_path)
    .map((s) => ({ seq: s.seq, name: s.name, path: s.screenshot_path }));
  const downloads = files.map((f) => ({
    id: f.id, file_name: f.file_name, sha256: f.sha256, size_bytes: f.size_bytes,
    revision: f.revision, status: f.status, origin: f.origin, downloaded_at: f.downloaded_at,
  }));
  const parse = files.map((f) => ({
    file_id: f.id,
    file_name: f.file_name,
    batches: batches.filter((b) => b.file_id === f.id).map((b) => ({
      id: b.id, status: b.status, rows_total: b.rows_total, rows_parsed: b.rows_parsed,
      rows_skipped: b.rows_skipped, parser_version: b.parser_version, mapping_version: b.mapping_version, error: b.error,
    })),
    issues: issues.filter((i) => i.file_id === f.id).map((i) => ({
      id: i.id, issue_type: i.issue_type, field: i.field, message: i.message, status: i.status,
    })),
  }));
  const failedSteps = steps.filter((s) => s.status === 'failed');
  const failure = ['failed', 'waiting_human', 'interrupted'].includes(run.status) || failedSteps.length
    ? {
        status: run.status,
        error_code: run.error_code,
        error_message: run.error_message,
        step: failedSteps[0] ?? null, // 第一个失败步骤即失败位置
        intervention: interventions[0] ?? null,
      }
    : null;

  return {
    run, steps, navigation, filters, elementChecks, screenshots, downloads, parse, failure,
    timeline: steps.map((s) => ({
      seq: s.seq, name: s.name, status: s.status, message: s.message,
      screenshot_path: s.screenshot_path, event: s.meta?.event ?? null, meta: s.meta ?? null, at: s.created_at,
    })),
  };
}

type Trace = NonNullable<Awaited<ReturnType<typeof buildRunTrace>>>;

/** 同一任务两次执行的差异：页面元素 / 筛选项 / 下载文件 / 解析结果 / 失败位置 / 步骤 */
function diffTraces(a: Trace, b: Trace) {
  // 步骤：按名称分组对比状态与消息
  const groupSteps = (t: Trace) => {
    const m = new Map<string, { status: string; message: string | null }[]>();
    for (const s of t.steps) {
      const arr = m.get(s.name) || [];
      arr.push({ status: s.status, message: s.message });
      m.set(s.name, arr);
    }
    return m;
  };
  const ga = groupSteps(a);
  const gb = groupSteps(b);
  const stepNames = [...new Set([...ga.keys(), ...gb.keys()])];
  const steps = stepNames
    .map((name) => {
      const sa = ga.get(name) ?? [];
      const sb = gb.get(name) ?? [];
      return { name, a: sa, b: sb, changed: JSON.stringify(sa) !== JSON.stringify(sb) };
    })
    .filter((d) => d.changed);

  // 页面元素
  const elMap = new Map<string, { a: boolean | null; b: boolean | null }>();
  for (const e of a.elementChecks) elMap.set(e.selector, { a: e.found, b: null });
  for (const e of b.elementChecks) {
    const cur = elMap.get(e.selector) ?? { a: null, b: null };
    cur.b = e.found;
    elMap.set(e.selector, cur);
  }
  const elements = [...elMap.entries()].map(([selector, v]) => ({
    selector, a: v.a, b: v.b, changed: v.a !== v.b,
  }));

  // 筛选项
  const fa = a.filters[0] ?? null;
  const fb = b.filters[0] ?? null;
  const filters = { a: fa, b: fb, changed: JSON.stringify(fa) !== JSON.stringify(fb) };

  // 下载文件
  const fileMap = new Map<string, { a: any; b: any }>();
  const pick = (f: any) => ({ sha256: f.sha256, size_bytes: f.size_bytes, revision: f.revision, status: f.status, origin: f.origin });
  for (const f of a.downloads) fileMap.set(f.file_name, { a: pick(f), b: null });
  for (const f of b.downloads) {
    const cur = fileMap.get(f.file_name) ?? { a: null, b: null };
    cur.b = pick(f);
    fileMap.set(f.file_name, cur);
  }
  const files = [...fileMap.entries()].map(([file_name, v]) => ({
    file_name, a: v.a, b: v.b,
    changed: !v.a || !v.b || v.a.sha256 !== v.b.sha256 || v.a.status !== v.b.status || v.a.revision !== v.b.revision,
  }));

  // 解析结果
  const parseSummary = (t: Trace) => {
    const batches = t.parse.flatMap((p) => p.batches);
    const issues = t.parse.flatMap((p) => p.issues);
    return {
      files: t.parse.length,
      rows_total: batches.reduce((s, b) => s + (b.rows_total || 0), 0),
      rows_parsed: batches.reduce((s, b) => s + (b.rows_parsed || 0), 0),
      rows_skipped: batches.reduce((s, b) => s + (b.rows_skipped || 0), 0),
      issues: issues.length,
      issue_types: [...new Set(issues.map((i) => i.issue_type))].sort(),
    };
  };
  const pa = parseSummary(a);
  const pb = parseSummary(b);
  const parse = { a: pa, b: pb, changed: JSON.stringify(pa) !== JSON.stringify(pb) };

  // 失败位置
  const failOf = (t: Trace) => (t.failure
    ? { status: t.failure.status, error_code: t.failure.error_code, step: t.failure.step?.name ?? null }
    : null);
  const fla = failOf(a);
  const flb = failOf(b);
  const failure = { a: fla, b: flb, changed: JSON.stringify(fla) !== JSON.stringify(flb) };

  const counts = {
    steps: steps.length,
    elements: elements.filter((e) => e.changed).length,
    filters: filters.changed ? 1 : 0,
    files: files.filter((f) => f.changed).length,
    parse: parse.changed ? 1 : 0,
    failure: failure.changed ? 1 : 0,
  };
  return {
    changed: Object.values(counts).some((n) => n > 0),
    counts, steps, elements, filters, files, parse, failure,
  };
}

@Controller()
export class ReplayController {
  /** 单次执行的结构化回放轨迹 */
  @Get('runs/:id/trace')
  async trace(@Param('id') id: string) {
    const trace = await buildRunTrace(id);
    if (!trace) throw new NotFoundException('执行记录不存在');
    return trace;
  }

  /** 发起隔离回放 */
  @Post('runs/:id/replay')
  async start(@Param('id') id: string, @Body() body: { mode?: string }) {
    const mode = body?.mode ?? 'isolated';
    if (mode !== 'isolated') {
      throw new BadRequestException('仅支持隔离模式回放（mode=isolated），禁止直接对生产账号重复提交');
    }
    const run = await one<any>(`SELECT id, task_id FROM task_runs WHERE id=$1`, [id]);
    if (!run) throw new NotFoundException('执行记录不存在');
    const active = await one<any>(
      `SELECT id FROM run_replays WHERE source_run_id=$1 AND status IN ('queued','running')`, [id]);
    if (active) return { ok: true, replayId: active.id, reused: true };
    const tag = `replay-${crypto.randomUUID()}`;
    const replay = await one<{ id: string }>(
      `INSERT INTO run_replays(task_id, source_run_id, mode, replay_tag) VALUES($1,$2,'isolated',$3) RETURNING id`,
      [run.task_id, id, tag],
    );
    await replayQueue.add('replay', { replayId: replay!.id });
    return { ok: true, replayId: replay!.id };
  }

  /** 回放列表 */
  @Get('replays')
  async list(@Query() query: any) {
    const cond: string[] = [];
    const params: any[] = [];
    if (query.runId) { params.push(query.runId); cond.push(`rp.source_run_id = $${params.length}`); }
    if (query.taskId) { params.push(query.taskId); cond.push(`rp.task_id = $${params.length}`); }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    return q(
      `SELECT rp.id, rp.task_id, rp.source_run_id, rp.mode, rp.status, rp.replay_tag, rp.error,
              rp.created_at, rp.started_at, rp.finished_at,
              t.biz_date::text, s.code AS store_code, p.code AS platform_code, a.username
       FROM run_replays rp
       JOIN source_tasks t ON t.id = rp.task_id
       JOIN stores s ON s.id = t.store_id
       JOIN platforms p ON p.id = t.platform_id
       JOIN platform_accounts a ON a.id = t.account_id
       ${where} ORDER BY rp.created_at DESC LIMIT 100`, params);
  }

  /** 回放详情：步骤 + 带标记请求审计 */
  @Get('replays/:id')
  async detail(@Param('id') id: string) {
    const replay = await one<any>(
      `SELECT rp.*, t.biz_date::text, t.source_kind,
              s.code AS store_code, p.code AS platform_code, a.username
       FROM run_replays rp
       JOIN source_tasks t ON t.id = rp.task_id
       JOIN stores s ON s.id = t.store_id
       JOIN platforms p ON p.id = t.platform_id
       JOIN platform_accounts a ON a.id = t.account_id
       WHERE rp.id=$1`, [id]);
    if (!replay) throw new NotFoundException('回放不存在');
    const [steps, requests] = await Promise.all([
      q(`SELECT * FROM replay_steps WHERE replay_id=$1 ORDER BY seq`, [id]),
      q(`SELECT * FROM replay_requests WHERE replay_id=$1 ORDER BY seq`, [id]),
    ]);
    return { replay, steps, requests };
  }

  /** 同一任务两次执行的差异对比 */
  @Get('tasks/:id/replay/compare')
  async compare(@Param('id') taskId: string, @Query('runA') runA: string, @Query('runB') runB: string) {
    if (!runA || !runB) throw new BadRequestException('runA/runB 必填');
    if (runA === runB) throw new BadRequestException('请选择两次不同的执行');
    const [a, b] = await Promise.all([buildRunTrace(runA), buildRunTrace(runB)]);
    if (!a || !b) throw new NotFoundException('执行记录不存在');
    if (a.run.task_id !== taskId || b.run.task_id !== taskId) {
      throw new BadRequestException('两次执行必须属于同一任务');
    }
    return {
      task_id: taskId,
      a: { run: a.run },
      b: { run: b.run },
      diff: diffTraces(a, b),
    };
  }
}
