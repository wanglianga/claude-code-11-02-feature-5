<template>
  <div v-if="task">
    <el-card>
      <template #header>
        <div class="head">
          <span>运行回放 · {{ task.store_code }} / {{ task.platform_code }} / {{ task.username }} / {{ task.biz_date }}</span>
          <div>
            <el-button size="small" @click="$router.push(`/tasks/${taskId}`)">返回任务详情</el-button>
            <el-button size="small" type="primary" :disabled="!runId" @click="startReplay">隔离回放本次执行</el-button>
          </div>
        </div>
      </template>
      <el-alert type="info" :closable="false" class="mb"
        title="隔离回放使用平台签发的只读会话复现页面步骤，不使用生产账号密码；回放请求全部带 x-collector-replay-id 标记，写操作被平台拦截，且不写入任务/文件/事实等正式记录，不影响采集进度与缺报统计。" />
      <div class="runbar">
        <span>选择执行：</span>
        <el-select v-model="runId" style="width: 340px" @change="loadTrace">
          <el-option v-for="r in runs" :key="r.id" :value="r.id"
            :label="`#${r.attempt_no} ${STATUS_META[r.status]?.label || r.status} · ${r.started_at}`" />
        </el-select>
        <el-tag v-if="trace?.run" :type="STATUS_META[trace.run.status]?.type || 'info'">
          {{ STATUS_META[trace.run.status]?.label || trace.run.status }}
        </el-tag>
        <el-tag v-if="trace?.run?.error_code" type="danger">{{ trace.run.error_code }}</el-tag>
      </div>
    </el-card>

    <!-- 单次执行的结构化回放轨迹 -->
    <el-card class="mt" v-if="trace">
      <template #header>
        <div class="head">
          <span>执行轨迹（按步骤）</span>
          <span class="tags">
            <el-tag size="small" effect="plain">导航 {{ trace.navigation.length }}</el-tag>
            <el-tag size="small" effect="plain">筛选 {{ trace.filters.length }}</el-tag>
            <el-tag size="small" effect="plain">元素探测 {{ trace.elementChecks.length }}</el-tag>
            <el-tag size="small" effect="plain">截图 {{ trace.screenshots.length }}</el-tag>
            <el-tag size="small" effect="plain">下载文件 {{ trace.downloads.length }}</el-tag>
            <el-tag size="small" effect="plain">解析批次 {{ trace.parse.reduce((n, p) => n + p.batches.length, 0) }}</el-tag>
            <el-tag v-if="trace.failure" size="small" type="danger">失败于 {{ trace.failure.step?.name || '-' }}</el-tag>
          </span>
        </div>
      </template>

      <el-alert v-if="trace.failure" type="error" :closable="false" class="mb"
        :title="`失败位置：步骤「${trace.failure.step?.name ?? '-'}」 · ${trace.failure.error_code || trace.failure.status}`"
        :description="trace.failure.error_message || trace.failure.step?.message || ''" />

      <el-timeline class="timeline">
        <el-timeline-item v-for="s in trace.timeline" :key="s.seq" :timestamp="s.at"
          :type="s.status === 'failed' ? 'danger' : s.status === 'blocked' ? 'warning' : s.status === 'info' ? 'info' : 'success'">
          <div>
            <b>{{ s.name }}</b>
            <el-tag v-if="s.event" size="small" effect="plain" class="ev">{{ EVENT_LABELS[s.event] || s.event }}</el-tag>
            <span v-if="s.message"> — {{ s.message }}</span>
          </div>
          <div v-if="s.event === 'navigation'" class="kv"><code>{{ s.meta.url }}</code></div>
          <div v-if="s.event === 'filter'" class="kv">
            筛选 <el-tag size="small">{{ s.meta.start }} ~ {{ s.meta.end }}</el-tag>
            实际 <el-tag size="small" :type="s.meta.valid ? 'success' : 'danger'">{{ s.meta.actualStart }} ~ {{ s.meta.actualEnd }}</el-tag>
          </div>
          <div v-if="s.event === 'element_probe'" class="kv">
            <el-tag v-for="e in s.meta.elements" :key="e.selector" size="small" :type="e.found ? 'success' : 'danger'" class="ev">
              {{ e.selector }} {{ e.found ? '✓' : '✗' }}
            </el-tag>
          </div>
          <div v-if="s.event === 'download'" class="kv">文件：<code>{{ s.meta.suggested }}</code></div>
          <div v-if="s.screenshot_path" class="shot">
            <el-image :src="`/api/static/${s.screenshot_path}`" :preview-src-list="[`/api/static/${s.screenshot_path}`]"
              fit="contain" style="max-width: 420px; max-height: 220px" preview-teleported />
          </div>
        </el-timeline-item>
      </el-timeline>

      <template v-if="trace.downloads.length">
        <h4>下载文件</h4>
        <el-table :data="trace.downloads" size="small" border>
          <el-table-column prop="file_name" label="文件名" min-width="200" show-overflow-tooltip />
          <el-table-column label="SHA256" width="120">
            <template #default="{ row }"><code>{{ row.sha256.slice(0, 10) }}</code></template>
          </el-table-column>
          <el-table-column prop="revision" label="修订" width="60" />
          <el-table-column prop="status" label="状态" width="110" />
          <el-table-column label="操作" width="90">
            <template #default="{ row }">
              <el-button size="small" link type="primary" @click="downloadEvidence(row.id, row.file_name)">下载</el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>

      <template v-if="trace.parse.length">
        <h4>解析结果</h4>
        <div v-for="p in trace.parse" :key="p.file_id" class="parse">
          <div><code>{{ p.file_name }}</code></div>
          <el-table :data="p.batches" size="small" border>
            <el-table-column prop="status" label="状态" width="90" />
            <el-table-column prop="rows_total" label="总行数" width="80" />
            <el-table-column prop="rows_parsed" label="解析" width="80" />
            <el-table-column prop="rows_skipped" label="跳过" width="80" />
            <el-table-column prop="parser_version" label="解析版本" width="110" />
            <el-table-column prop="mapping_version" label="映射版本" width="130" />
            <el-table-column prop="error" label="错误" show-overflow-tooltip />
          </el-table>
          <el-table v-if="p.issues.length" :data="p.issues" size="small" border class="mt-s">
            <el-table-column prop="issue_type" label="异常类型" width="140" />
            <el-table-column prop="field" label="字段" width="90" />
            <el-table-column prop="message" label="说明" show-overflow-tooltip />
          </el-table>
        </div>
      </template>
    </el-card>

    <!-- 隔离回放 -->
    <el-card class="mt">
      <template #header>
        <div class="head">
          <span>隔离回放（同一模拟页面重放，不触碰正式记录）</span>
          <el-button size="small" type="primary" :disabled="!runId" @click="startReplay">发起隔离回放</el-button>
        </div>
      </template>
      <el-table :data="replays" size="small" border>
        <el-table-column label="回放" width="260">
          <template #default="{ row }"><code>{{ row.id.slice(0, 8) }}</code> · {{ row.created_at }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="REPLAY_META[row.status]?.type || 'info'">{{ REPLAY_META[row.status]?.label || row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="replay_tag" label="请求标记" min-width="220" show-overflow-tooltip />
        <el-table-column label="操作" width="100">
          <template #default="{ row }">
            <el-button size="small" link type="primary" @click="selectReplay(row.id)">查看</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="replayDetail" class="replay-detail">
        <el-alert :type="replayDetail.replay.status === 'failed' ? 'error' : 'success'" :closable="false" class="mb"
          :title="`回放 ${replayDetail.replay.id.slice(0, 8)} · ${REPLAY_META[replayDetail.replay.status]?.label || replayDetail.replay.status} · 标记 ${replayDetail.replay.replay_tag}`"
          :description="replayDetail.replay.error || '以下请求均带隔离标记，仅写入回放审计表，不进入正式任务记录。'" />

        <el-row :gutter="12">
          <el-col :span="14">
            <h4>回放步骤</h4>
            <el-timeline>
              <el-timeline-item v-for="s in replayDetail.steps" :key="s.id" :timestamp="s.created_at"
                :type="s.status === 'failed' ? 'danger' : s.status === 'blocked' ? 'warning' : s.status === 'info' ? 'info' : 'success'">
                <b>{{ s.name }}</b><span v-if="s.message"> — {{ s.message }}</span>
                <div v-if="s.meta?.event === 'element_probe'" class="kv">
                  <el-tag v-for="e in s.meta.elements" :key="e.selector" size="small" :type="e.found ? 'success' : 'danger'" class="ev">
                    {{ e.selector }} {{ e.found ? '✓' : '✗' }}
                  </el-tag>
                </div>
                <div v-if="s.screenshot_path" class="shot">
                  <el-image :src="`/api/static/${s.screenshot_path}`" :preview-src-list="[`/api/static/${s.screenshot_path}`]"
                    fit="contain" style="max-width: 380px; max-height: 200px" preview-teleported />
                </div>
              </el-timeline-item>
            </el-timeline>
          </el-col>
          <el-col :span="10">
            <h4>回放请求（全部带标记）</h4>
            <el-table :data="replayDetail.requests" size="small" border>
              <el-table-column prop="method" label="方法" width="60" />
              <el-table-column prop="url" label="URL" min-width="200" show-overflow-tooltip />
              <el-table-column prop="status" label="HTTP" width="70" />
              <el-table-column label="拦截" width="70">
                <template #default="{ row }">
                  <el-tag v-if="row.blocked" size="small" type="warning">已拦截</el-tag>
                  <span v-else>-</span>
                </template>
              </el-table-column>
            </el-table>
            <template v-if="replayDetail.replay.diff">
              <h4>回放现场 vs 原始执行</h4>
              <ReplayDiff :diff="replayDetail.replay.diff" />
            </template>
          </el-col>
        </el-row>
      </div>
    </el-card>

    <!-- 两次执行对比 -->
    <el-card class="mt">
      <template #header>
        <div class="head">
          <span>两次执行差异对比</span>
          <div>
            <el-select v-model="cmpA" size="small" style="width: 220px" placeholder="执行 A">
              <el-option v-for="r in runs" :key="r.id" :value="r.id" :label="`#${r.attempt_no} ${r.status} · ${r.started_at}`" />
            </el-select>
            <el-select v-model="cmpB" size="small" style="width: 220px; margin-left: 8px" placeholder="执行 B">
              <el-option v-for="r in runs" :key="r.id" :value="r.id" :label="`#${r.attempt_no} ${r.status} · ${r.started_at}`" />
            </el-select>
            <el-button size="small" type="primary" style="margin-left: 8px" :disabled="!cmpA || !cmpB || cmpA === cmpB" @click="doCompare">对比</el-button>
          </div>
        </div>
      </template>
      <div v-if="compare">
        <el-alert :type="compare.diff.changed ? 'warning' : 'success'" :closable="false" class="mb"
          :title="compare.diff.changed
            ? `发现差异：步骤 ${compare.diff.counts.steps} · 页面元素 ${compare.diff.counts.elements} · 筛选项 ${compare.diff.counts.filters} · 下载文件 ${compare.diff.counts.files} · 解析 ${compare.diff.counts.parse} · 失败位置 ${compare.diff.counts.failure}`
            : '两次执行无差异'" />
        <ReplayDiff :diff="compare.diff" />
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, h } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElTag } from 'element-plus';
import { api, STATUS_META, downloadEvidence } from '../api';

const EVENT_LABELS: Record<string, string> = {
  navigation: '导航', filter: '筛选', element_probe: '元素探测', screenshot: '截图',
  submit: '提交', download: '下载', api: '接口', file_verify: '文件校验', error: '失败',
  replay_start: '回放开始', replay_session: '回放会话', guard: '隔离拦截', replay_finish: '回放结束',
};
const REPLAY_META: Record<string, { label: string; type: string }> = {
  queued: { label: '排队中', type: 'info' },
  running: { label: '回放中', type: 'primary' },
  succeeded: { label: '回放完成', type: 'success' },
  blocked: { label: '完成(写操作已拦截)', type: 'warning' },
  failed: { label: '回放失败', type: 'danger' },
};

/** 差异块渲染（页面元素 / 筛选项 / 下载文件 / 解析 / 失败位置 / 步骤） */
const ReplayDiff = (props: { diff: any }) => {
  const d = props.diff || {};
  const tag = (txt: string, type: string) => h(ElTag, { size: 'small', type, effect: 'plain', style: 'margin:2px 4px 2px 0' }, () => txt);
  const yn = (v: any) => (v === null || v === undefined ? '—' : v ? '✓' : '✗');
  const section = (title: string, changed: boolean, children: any[]) =>
    h('div', { style: 'margin-bottom:10px' }, [
      h('div', { style: 'font-weight:600;margin-bottom:4px' }, [
        `${title} `,
        changed ? tag('有变化', 'warning') : tag('无变化', 'success'),
      ]),
      ...children,
    ]);
  const rows = (list: any[], cols: [string, (r: any) => any][]) =>
    h('table', { class: 'diff-table' }, [
      h('tr', cols.map(([t]) => h('th', t))),
      ...list.map((r) => h('tr', { class: r.changed ? 'changed' : '' }, cols.map(([, f]) => h('td', f(r))))),
    ]);
  const kids: any[] = [];
  if (d.elements) {
    kids.push(section('页面元素', d.elements.some((e: any) => e.changed), [
      rows(d.elements, [
        ['选择器', (r: any) => h('code', r.selector)],
        ['执行A', (r: any) => yn(r.a ?? r.source)],
        ['执行B/回放', (r: any) => yn(r.b ?? r.replay)],
        ['变化', (r: any) => (r.changed ? tag('变化', 'danger') : '—')],
      ]),
    ]));
  }
  if (d.filters) {
    const fmt = (f: any) => (f ? `${f.start} ~ ${f.end}${f.valid === false ? '（未生效）' : ''}` : '—');
    kids.push(section('筛选项', !!d.filters.changed, [
      h('div', [tag(`A: ${fmt(d.filters.a ?? d.filters.source)}`, 'info'), tag(`B/回放: ${fmt(d.filters.b ?? d.filters.replay)}`, 'info')]),
    ]));
  }
  if (d.downloads) {
    const list = Array.isArray(d.downloads) ? d.downloads : null;
    const src = d.downloads.source ?? [];
    const rep = d.downloads.replay ?? [];
    kids.push(section('下载文件', list ? list.some((f: any) => f.changed) : !!d.downloads.changed, [
      list
        ? rows(list, [
            ['文件', (r: any) => h('code', r.file_name)],
            ['A 哈希/状态', (r: any) => (r.a ? `${String(r.a.sha256).slice(0, 10)} / ${r.a.status}` : '—')],
            ['B 哈希/状态', (r: any) => (r.b ? `${String(r.b.sha256).slice(0, 10)} / ${r.b.status}` : '—')],
            ['变化', (r: any) => (r.changed ? tag('变化', 'danger') : '—')],
          ])
        : h('div', [
            h('div', `原始执行文件：${src.map((f: any) => f.file_name).join('、') || '无'}`),
            h('div', `回放观察文件：${rep.map((f: any) => f.file_name).join('、') || '无（受隔离保护）'}`),
            d.downloads.note ? h('div', { style: 'color:#e6a23c' }, d.downloads.note) : null,
          ]),
    ]));
  }
  if (d.parse) {
    kids.push(section('解析结果', !!d.parse.changed, [
      h('div', [
        tag(`A: 文件${d.parse.a.files} 行${d.parse.a.rows_total} 解析${d.parse.a.rows_parsed} 跳过${d.parse.a.rows_skipped} 异常${d.parse.a.issues}`, 'info'),
        tag(`B: 文件${d.parse.b.files} 行${d.parse.b.rows_total} 解析${d.parse.b.rows_parsed} 跳过${d.parse.b.rows_skipped} 异常${d.parse.b.issues}`, 'info'),
      ]),
    ]));
  }
  if (d.failure) {
    const fmt = (f: any) => (f ? `${f.status}${f.error_code ? ' · ' + f.error_code : ''}${f.step ? ' · 步骤 ' + f.step : ''}` : '无失败');
    kids.push(section('失败位置', !!d.failure.changed, [
      h('div', [tag(`A: ${fmt(d.failure.a)}`, d.failure.a ? 'danger' : 'success'), tag(`B: ${fmt(d.failure.b)}`, d.failure.b ? 'danger' : 'success')]),
    ]));
  }
  if (d.steps?.length) {
    kids.push(section('步骤差异', true, d.steps.map((s: any) =>
      h('div', { style: 'font-size:12px;color:#606266' }, `${s.name}：A=${JSON.stringify(s.a)} B=${JSON.stringify(s.b)}`))));
  }
  return h('div', kids);
};
ReplayDiff.props = ['diff'];

const route = useRoute();
const taskId = String(route.params.id);
const task = ref<any>(null);
const runs = ref<any[]>([]);
const runId = ref<string>('');
const trace = ref<any>(null);
const replays = ref<any[]>([]);
const replayDetail = ref<any>(null);
const cmpA = ref<string>('');
const cmpB = ref<string>('');
const compare = ref<any>(null);
let pollTimer: any = null;

async function loadTask() {
  const d = (await api.get(`/tasks/${taskId}`)).data;
  task.value = d.task;
  runs.value = d.runs;
  if (!runId.value) {
    runId.value = String(route.query.run || d.runs[0]?.id || '');
  }
  if (runs.value.length >= 2) {
    cmpA.value = cmpA.value || runs.value[1].id;
    cmpB.value = cmpB.value || runs.value[0].id;
  }
}
async function loadTrace() {
  if (!runId.value) return;
  trace.value = (await api.get(`/runs/${runId.value}/trace`)).data;
  await loadReplays();
}
async function loadReplays() {
  replays.value = (await api.get('/replays', { params: { runId: runId.value } })).data;
}
async function startReplay() {
  const r = await api.post(`/runs/${runId.value}/replay`, { mode: 'isolated' });
  ElMessage.success('已发起隔离回放（请求带标记，不写入正式记录）');
  await loadReplays();
  await selectReplay(r.data.replayId);
}
async function selectReplay(id: string) {
  replayDetail.value = (await api.get(`/replays/${id}`)).data;
  if (['queued', 'running'].includes(replayDetail.value.replay.status)) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(() => selectReplay(id), 2000);
  }
}
async function doCompare() {
  compare.value = (await api.get(`/tasks/${taskId}/replay/compare`, { params: { runA: cmpA.value, runB: cmpB.value } })).data;
}

onMounted(async () => {
  await loadTask();
  await loadTrace();
});
onUnmounted(() => clearTimeout(pollTimer));
</script>

<style scoped>
.mt { margin-top: 12px; }
.mb { margin-bottom: 12px; }
.mt-s { margin-top: 6px; }
.head { display: flex; justify-content: space-between; align-items: center; }
.runbar { display: flex; gap: 10px; align-items: center; }
.tags { display: flex; gap: 6px; flex-wrap: wrap; }
.timeline { margin-top: 8px; }
.ev { margin-left: 6px; }
.kv { margin-top: 4px; font-size: 12px; color: #606266; }
.shot { margin-top: 6px; }
.parse { margin-bottom: 10px; }
.replay-detail { margin-top: 12px; }
h4 { margin: 12px 0 6px; }
:deep(.diff-table) { border-collapse: collapse; font-size: 12px; }
:deep(.diff-table th), :deep(.diff-table td) { border: 1px solid #e4e7ed; padding: 3px 10px; }
:deep(.diff-table tr.changed td) { background: #fdf6ec; }
</style>
