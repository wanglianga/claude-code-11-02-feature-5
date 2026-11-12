import fs from 'fs';
import path from 'path';
import { getBrowser } from './browser';
import { one, q } from './db';
import { env } from './env';
import { Steps } from './steps';

/**
 * 任务运行回放（隔离模式）
 *  - 复用同一模拟页面重放浏览器采集步骤（导航/筛选/元素探测/截图）；
 *  - 回放使用平台签发的只读会话（replay=true），绝不使用生产账号密码；
 *  - 所有回放请求带 x-collector-replay-id 标记，写操作被模拟平台 403 拦截；
 *  - 回放只写 run_replays / replay_steps / replay_requests 三张表，
 *    不触碰 source_tasks / task_runs / collected_files / daily_facts，
 *    因此不会污染采集进度与缺报统计。
 */

interface ElementObs { selector: string; found: boolean }
interface FilterObs { platform: string; start: string; end: string; actualStart?: string; actualEnd?: string; valid?: boolean }
interface DownloadObs { file_name: string; revision?: number | null; rows?: number | null; ready?: boolean; source: 'observed' | 'api' }
interface BlockedOp { op: string; status: number }
interface Observations { elements: ElementObs[]; filters: FilterObs[]; downloads: DownloadObs[]; blockedOps: BlockedOp[] }

type RecordFn = (method: string, url: string, status: number, blocked: boolean, note?: string) => Promise<void>;

/** 原始执行的结构化快照（从正式 run_steps / collected_files 派生，只读） */
async function sourceSnapshot(runId: string) {
  const steps = await q<any>(`SELECT seq, name, status, message, meta FROM run_steps WHERE run_id=$1 ORDER BY seq`, [runId]);
  const run = await one<any>(`SELECT id, status, error_code, error_message FROM task_runs WHERE id=$1`, [runId]);
  const files = await q<any>(
    `SELECT file_name, sha256, size_bytes, revision, status FROM collected_files WHERE run_id=$1 ORDER BY created_at`, [runId]);
  const elements: ElementObs[] = [];
  const filters: FilterObs[] = [];
  for (const s of steps) {
    const meta = s.meta || {};
    if (meta.event === 'element_probe' && Array.isArray(meta.elements)) {
      for (const e of meta.elements) elements.push({ selector: e.selector, found: !!e.found });
    }
    if (meta.event === 'filter') {
      filters.push({ platform: meta.platform, start: meta.start, end: meta.end, actualStart: meta.actualStart, actualEnd: meta.actualEnd, valid: meta.valid });
    }
  }
  return { run, steps, files, elements, filters };
}

/** 回放现场 vs 原始执行：页面元素 / 筛选项 / 下载文件 三类变化点 */
function computeReplayDiff(source: Awaited<ReturnType<typeof sourceSnapshot>>, obs: Observations) {
  const elMap = new Map<string, { source: boolean | null; replay: boolean | null }>();
  for (const e of source.elements) elMap.set(e.selector, { source: e.found, replay: null });
  for (const e of obs.elements) {
    const cur = elMap.get(e.selector) ?? { source: null, replay: null };
    cur.replay = e.found;
    elMap.set(e.selector, cur);
  }
  const elements = [...elMap.entries()].map(([selector, v]) => ({
    selector, source: v.source, replay: v.replay,
    changed: v.source !== null && v.replay !== null && v.source !== v.replay,
  }));

  const sf = source.filters[0] ?? null;
  const rf = obs.filters[0] ?? null;
  const filters = {
    source: sf, replay: rf,
    changed: !!(sf && rf && (sf.start !== rf.start || sf.end !== rf.end || sf.valid !== rf.valid)),
  };

  const sourceFiles = source.files.map((f) => ({ file_name: f.file_name, sha256: f.sha256, revision: f.revision, status: f.status }));
  const replayFiles = obs.downloads;
  const downloads = {
    source: sourceFiles,
    replay: replayFiles,
    changed: sourceFiles.length !== replayFiles.length
      || sourceFiles.some((f) => !replayFiles.some((r) => r.file_name === f.file_name)),
    blockedOps: obs.blockedOps,
    note: obs.blockedOps.length ? '回放受隔离保护，未产生正式下载文件（符合预期）' : null,
  };

  return {
    changed: elements.some((e) => e.changed) || filters.changed,
    elements, filters, downloads,
  };
}

/** ALPHA / BETA：用回放专用会话在模拟页面上重放（提交动作会被隔离拦截） */
async function replayBrowser(replay: any, steps: Steps, record: RecordFn): Promise<{ observations: Observations; blocked: boolean }> {
  const platform = replay.platform_code as 'ALPHA' | 'BETA';
  const date = replay.biz_date;
  const tag: string = replay.replay_tag;
  const observations: Observations = { elements: [], filters: [], downloads: [], blockedOps: [] };
  let blocked = false;

  // 1. 申请回放专用只读会话（不使用生产账号密码）
  const sessRes = await fetch(`${env.mockBaseUrl}/__replay/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-collector-replay-id': tag, 'x-collector-replay-mode': 'isolated' },
    body: JSON.stringify({ platform, username: replay.username }),
  });
  await record('POST', `${env.mockBaseUrl}/__replay/session`, sessRes.status, false, '申请回放专用只读会话（不使用生产账号密码）');
  if (!sessRes.ok) throw new Error(`回放会话申请失败 HTTP ${sessRes.status}`);
  const sess = await sessRes.json();
  await steps.log('replay_session', 'ok', '已建立隔离回放会话（replay=true，无生产凭据）', undefined,
    { event: 'replay_session', store: sess.store, replayId: tag });

  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { 'x-collector-replay-id': tag, 'x-collector-replay-mode': 'isolated' },
  });
  context.setDefaultTimeout(8000);
  const cookieValue = String(sess.cookie).split('=').slice(1).join('=');
  await context.addCookies([{ name: `sid_${platform}`, value: cookieValue, url: env.mockBaseUrl }]);
  const page = await context.newPage();
  try {
    // 2. 打开报表页（只读 GET）
    const reportUrl = `${env.mockBaseUrl}/${platform}/report?start=${date}&end=${date}`;
    const navResp = await page.goto(reportUrl, { waitUntil: 'domcontentloaded' });
    await record('GET', reportUrl, navResp?.status() ?? 0, false, '打开报表页（只读）');
    await steps.log('navigate', 'info', reportUrl, undefined, { event: 'navigation', phase: 'report', url: reportUrl, platform });
    const reportShot = await steps.shot(page, 'replay_report');
    await steps.log('replay_report_view', 'ok', '回放：报表页截图', reportShot, { event: 'screenshot', url: page.url() });

    // 3. 元素探测 + 筛选条件复现
    const els = await steps.probe(page, '回放·报表页元素', ['#start-date', '#end-date', '#query-btn', platform === 'ALPHA' ? '#export-btn' : '#request-export-btn']);
    observations.elements.push(...els.map((e) => ({ selector: e.selector, found: e.found })));
    const missing = els.filter((e) => !e.found).map((e) => e.selector);
    if (missing.length) {
      const shot = await steps.shot(page, 'replay_element_missing');
      await steps.log('element_check', 'failed', `回放发现元素缺失：${missing.join(', ')}`, shot,
        { event: 'error', kind: 'element_not_found', url: page.url() });
    } else {
      await page.fill('#start-date', date);
      await page.fill('#end-date', date);
      await page.click('#query-btn');
      await page.waitForLoadState('domcontentloaded');
      const actualStart = await page.inputValue('#start-date').catch(() => '');
      const actualEnd = await page.inputValue('#end-date').catch(() => '');
      const valid = actualStart === date && actualEnd === date;
      observations.filters.push({ platform, start: date, end: date, actualStart, actualEnd, valid });
      await steps.log('date_window', valid ? 'ok' : 'failed', `回放筛选条件 ${date}（实际 ${actualStart}~${actualEnd}）`, undefined,
        { event: 'filter', platform, start: date, end: date, actualStart, actualEnd, valid });
      const filteredShot = await steps.shot(page, 'replay_filtered');
      await steps.log('replay_filtered_view', 'ok', '回放：筛选后页面截图', filteredShot, { event: 'screenshot', url: page.url() });
    }

    // 4. 按原流程尝试受保护提交 —— 隔离策略必须拦截（证明不会对生产账号重复提交）
    const submitSel = platform === 'ALPHA' ? '#export-btn' : '#request-export-btn';
    if (await page.locator(submitSel).count()) {
      const respP = page
        .waitForResponse((r) => r.request().method() === 'POST' && r.url().includes(`/${platform}/export`), { timeout: 10000 })
        .catch(() => null);
      await page.click(submitSel).catch(() => undefined);
      const resp = await respP;
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      const status = resp?.status() ?? 0;
      const isBlocked = status === 403;
      blocked = blocked || isBlocked;
      await record('POST', `${env.mockBaseUrl}/${platform}/export`, status, isBlocked,
        isBlocked ? '受保护操作被隔离策略拦截（replay_blocked）' : '警告：回放提交未被拦截');
      if (isBlocked) observations.blockedOps.push({ op: `${platform}/export`, status });
      const guardShot = await steps.shot(page, 'replay_submit_guard');
      await steps.log('export_guard', isBlocked ? 'blocked' : 'failed',
        isBlocked ? '已按原流程尝试导出提交，隔离策略拦截（未对生产账号重复提交）' : `回放提交返回 HTTP ${status}，未被拦截`,
        guardShot, { event: 'guard', selector: submitSel, status, blocked: isBlocked });
    } else {
      await steps.log('export_guard', 'info', `回放页面缺少提交按钮 ${submitSel}，跳过提交重放`);
    }

    // 5. BETA：观察下载中心（只读）
    if (platform === 'BETA') {
      const dlUrl = `${env.mockBaseUrl}/BETA/downloads`;
      const dlResp = await page.goto(dlUrl, { waitUntil: 'domcontentloaded' });
      await record('GET', dlUrl, dlResp?.status() ?? 0, false, '查看下载中心（只读）');
      await steps.log('navigate', 'info', dlUrl, undefined, { event: 'navigation', phase: 'downloads', url: dlUrl, platform });
      const rows: { date: string | null; ready: boolean }[] = await page.locator('tr.dl-row')
        .evaluateAll((trs) => trs.map((tr) => ({ date: tr.getAttribute('data-date'), ready: tr.getAttribute('data-ready') === '1' })))
        .catch(() => []);
      for (const r of rows) {
        observations.downloads.push({ file_name: `BETA_${replay.store_code}_${r.date}`, ready: r.ready, source: 'observed' });
      }
      const dlShot = await steps.shot(page, 'replay_downloads');
      await steps.log('replay_downloads_view', 'ok', `回放：下载中心共 ${rows.length} 条记录`, dlShot,
        { event: 'screenshot', url: page.url(), rows });
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  return { observations, blocked };
}

/** GAMMA：带标记的只读接口回放，响应保存为回放证据（不进入正式文件记录） */
async function replayGamma(replay: any, steps: Steps, record: RecordFn): Promise<{ observations: Observations; blocked: boolean }> {
  const tag: string = replay.replay_tag;
  const observations: Observations = { elements: [], filters: [], downloads: [], blockedOps: [] };
  const url = `${env.mockBaseUrl}/gamma/api/daily-report?store=${replay.store_code}&date=${replay.biz_date}`;
  await steps.log('api_request', 'info', url, undefined, { event: 'api', method: 'GET', url });
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${replay.api_token || ''}`,
      'x-collector-replay-id': tag,
      'x-collector-replay-mode': 'isolated',
    },
  });
  await record('GET', url, res.status, false, '回放接口拉取（只读，带标记）');
  const bodyText = await res.text();
  let body: any = null;
  try { body = JSON.parse(bodyText); } catch { /* 保留原文 */ }

  const dir = path.join(env.dataDir, 'replay_files', replay.id);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `GAMMA_${replay.store_code}_${replay.biz_date}_r${body?.revision ?? 'unknown'}.replay.json`;
  fs.writeFileSync(path.join(dir, fileName), bodyText);

  const rows = Array.isArray(body?.rows) ? body.rows.length : 0;
  const types: Record<string, number> = {};
  if (Array.isArray(body?.rows)) for (const r of body.rows) types[String(r.type)] = (types[String(r.type)] || 0) + 1;
  await steps.log('api_saved', res.ok ? 'ok' : 'failed', `回放响应已保存 ${fileName}（HTTP ${res.status}，${rows} 行）`, undefined,
    {
      event: 'download', suggested: fileName, revision: body?.revision ?? null, status: res.status,
      rows, types, evidencePath: path.join('replay_files', replay.id, fileName),
    });
  observations.downloads.push({ file_name: fileName, revision: body?.revision ?? null, rows, source: 'api' });
  return { observations, blocked: false };
}

/** 回放任务处理器 */
export async function processReplay(job: { data: { replayId: string } }) {
  const { replayId } = job.data;
  const replay = await one<any>(
    `SELECT rp.id, rp.task_id, rp.source_run_id, rp.status, rp.replay_tag,
            t.biz_date::text, t.source_kind,
            s.code AS store_code, p.code AS platform_code, a.username, a.api_token
     FROM run_replays rp
     JOIN source_tasks t ON t.id = rp.task_id
     JOIN stores s ON s.id = t.store_id
     JOIN platforms p ON p.id = t.platform_id
     JOIN platform_accounts a ON a.id = t.account_id
     WHERE rp.id = $1`, [replayId]);
  if (!replay || !['queued', 'running'].includes(replay.status)) return;

  await q(`UPDATE run_replays SET status='running', started_at=now(), worker_id=$2 WHERE id=$1`, [replayId, env.workerId]);
  const steps = new Steps(replayId, { table: 'replay_steps', dir: 'replay_shots' });
  const tag: string = replay.replay_tag;
  let reqSeq = 0;
  const record: RecordFn = async (method, url, status, blocked, note) => {
    reqSeq++;
    await q(
      `INSERT INTO replay_requests(replay_id, seq, method, url, status, blocked, replay_tag, note) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [replayId, reqSeq, method, url, status ?? null, blocked, tag, note ?? null],
    );
  };
  const evidenceDir = path.join('replay_files', replayId);

  try {
    await steps.log('replay_start', 'info',
      `隔离模式回放（tag=${tag}）：使用回放专用会话，不写入正式任务记录`,
      undefined, { event: 'replay_start', mode: 'isolated', replayTag: tag, sourceRunId: replay.source_run_id });
    const source = await sourceSnapshot(replay.source_run_id);
    const out = replay.source_kind === 'api'
      ? await replayGamma(replay, steps, record)
      : await replayBrowser(replay, steps, record);
    const diff = computeReplayDiff(source, out.observations);
    const status = out.blocked ? 'blocked' : 'succeeded';
    await q(
      `UPDATE run_replays SET status=$2, diff=$3, evidence_dir=$4, finished_at=now() WHERE id=$1`,
      [replayId, status, JSON.stringify(diff), evidenceDir],
    );
    await steps.log('replay_finish', out.blocked ? 'blocked' : 'ok',
      out.blocked ? '回放完成：受保护操作已被隔离拦截，未对生产账号重复提交' : '回放完成',
      undefined, { event: 'replay_finish', changed: diff.changed });
  } catch (e: any) {
    await q(
      `UPDATE run_replays SET status='failed', error=$2, evidence_dir=$3, finished_at=now() WHERE id=$1`,
      [replayId, String(e?.message ?? e).slice(0, 500), evidenceDir],
    );
    await steps.log('replay_finish', 'failed', `回放失败：${e?.message ?? e}`).catch(() => undefined);
  }
}
