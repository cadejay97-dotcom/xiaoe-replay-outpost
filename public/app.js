const state = {
  jobs: [],
  selectedId: null,
  serviceOnline: true,
  submitting: false,
  feishu: { status: 'checking', label: '飞书检查中' },
  feishuCheckedAt: 0,
  feishuChecking: false,
};

const $ = (id) => document.getElementById(id);

const sampleJobs = [
  {
    id: '2026315',
    title: '2026.3.15 新时代视角下的「执行力」新解',
    replayUrl: '你的小鹅通回放链接',
    jobDir: 'output/2026315',
    status: 'recorded',
    isSilent: false,
    duration: 52.032,
    updatedAt: '本地服务未连接，展示最近录音壳',
  },
];

function statusLabel(status) {
  const labels = {
    created: '已创建',
    running: '采集中',
    recorded: '已录音',
    transcribed: '已转写',
    cleaned: '已清洗',
    base_failed: '文档已创建，Base 入库失败',
    postprocessing: '后处理中',
    done: '已入库',
    failed: '失败',
  };
  return labels[status] || status || '未知';
}

function phaseLabel(job) {
  const labels = {
    created: '已创建',
    opening: '打开中',
    running: '采集中',
    recording: '录音中',
    recorded: '已录音',
    transcribing: '转写中',
    transcribed: '已转写',
    cleaning: '清洗中',
    cleaned: '已清洗',
    feishu: '写飞书中',
    base_failed: '文档已创建，Base 入库失败',
    postprocessing: '后处理中',
    done: '已入库',
    failed: '失败',
  };
  return labels[job?.phase] || statusLabel(job?.status);
}

function stepRank(status) {
  const ranks = {
    opening: 1,
    running: 1,
    recording: 2,
    recorded: 2,
    transcribing: 3,
    transcribed: 3,
    postprocessing: 3,
    cleaning: 4,
    cleaned: 4,
    feishu: 5,
    base_failed: 5,
    done: 5,
  };
  return ranks[status] || 0;
}

function pillClass(status) {
  if (['done'].includes(status)) return 'done';
  if (['failed', 'base_failed'].includes(status)) return 'failed';
  return '';
}

function render() {
  renderService();
  renderFeishu();
  renderMetrics();
  renderJobs();
  renderDetail(state.jobs.find((job) => job.id === state.selectedId) || null);
  renderActions();
}

function renderService() {
  const el = $('serviceState');
  el.textContent = state.serviceOnline ? 'Mac Runner 在线' : 'Mac Runner 未连接';
  el.classList.toggle('online', state.serviceOnline);
  el.classList.toggle('offline', !state.serviceOnline);
  $('offlineNotice').classList.toggle('visible', !state.serviceOnline);
}

function renderFeishu() {
  const el = $('feishuState');
  if (!el) return;
  const status = state.feishu?.status || 'checking';
  el.textContent = state.feishu?.label || '飞书检查中';
  el.classList.toggle('online', status === 'connected');
  el.classList.toggle('offline', ['unauthorized', 'keychain', 'error', 'offline'].includes(status));
}

function renderMetrics() {
  const recorded = state.jobs.filter((job) => ['recorded', 'transcribed', 'cleaned', 'done'].includes(job.status)).length;
  const done = state.jobs.filter((job) => ['done', 'base_failed'].includes(job.status)).length;
  const failed = state.jobs.filter((job) => job.status === 'failed').length;
  const selected = state.jobs.find((job) => job.id === state.selectedId);
  $('metricRecorded').textContent = recorded;
  $('metricDone').textContent = done;
  $('metricFailed').textContent = failed;
  $('metricCurrent').textContent = selected?.title || '等待任务';
}

function hasActiveJob() {
  return state.jobs.some((job) => ['running', 'postprocessing'].includes(job.status));
}

function renderActions() {
  const busy = state.submitting || hasActiveJob();
  $('runBtn').disabled = busy || !state.serviceOnline;
  $('postprocessBtn').disabled = busy || !state.serviceOnline;
  $('retryBaseBtn').disabled = busy || !state.serviceOnline || !canRetryBase();
  $('runBtn').textContent = busy ? '任务进行中' : '开始采集';
  $('postprocessBtn').textContent = busy ? '请稍候' : '处理现有录音';
  $('retryBaseBtn').textContent = busy ? '请稍候' : '重试入库';
}

function canRetryBase() {
  const job = state.jobs.find((item) => item.id === state.selectedId);
  return Boolean(job?.jobDir && job?.feishuDocUrl);
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours} 小时`);
  if (minutes) parts.push(`${minutes} 分钟`);
  if (rest || !parts.length) parts.push(`${rest} 秒`);
  return parts.join(' ');
}

function readRecordSeconds() {
  const hours = Number($('recordHours').value || 0);
  const minutes = Number($('recordMinutes').value || 0);
  const seconds = Number($('recordSeconds').value || 0);
  return Math.max(10, Math.round(hours * 3600 + minutes * 60 + seconds));
}

function updateDurationPreview() {
  const total = readRecordSeconds();
  $('durationPreview').textContent = `完整录制优先；最长保护 ${formatDuration(total)}（${total} 秒）`;
}

function renderJobs() {
  const list = $('jobList');
  $('jobCount').textContent = `${state.jobs.length} 条`;

  if (!state.jobs.length) {
    list.innerHTML = `
      <div class="job-card">
        <div class="job-title">暂无任务</div>
        <div class="job-foot">先开始一次采集或处理现有录音</div>
      </div>
    `;
    state.selectedId = null;
    return;
  }

  if (!state.selectedId || !state.jobs.some((job) => job.id === state.selectedId)) {
    state.selectedId = state.jobs[0].id;
  }

  list.innerHTML = state.jobs.map((job) => `
    <button class="job-card ${job.id === state.selectedId ? 'active' : ''}" data-id="${escapeHtml(job.id)}" type="button">
      <div class="job-title">${escapeHtml(job.title || job.id)}</div>
      <div class="job-foot">
        <span>${escapeHtml(job.updatedAt || '')}</span>
        <span class="pill ${pillClass(job.status)}">${phaseLabel(job)}</span>
      </div>
    </button>
  `).join('');

  [...list.querySelectorAll('.job-card')].forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedId = button.dataset.id;
      render();
    });
  });
}

function renderDetail(job) {
  $('currentStatus').textContent = job ? phaseLabel(job) : '等待任务';
  const rank = stepRank(job?.phase || job?.status);
  [...document.querySelectorAll('.step')].forEach((step, index) => {
    step.classList.toggle('active', index + 1 <= rank);
  });

  if (!job) {
    $('jobMeta').textContent = '还没有任务。';
    setDocLink('');
    $('audioStatus').textContent = '未检测';
    $('jobDir').textContent = '未选择';
    $('errorText').textContent = '无';
    return;
  }

  $('jobMeta').textContent = JSON.stringify({
    id: job.id,
    title: job.title,
    replayUrl: job.replayUrl,
    status: statusLabel(job.status),
    phase: phaseLabel(job),
    duration: formatDuration(job.duration),
    durationSeconds: job.duration,
    feishuBaseStatus: job.feishuBaseStatus,
    updatedAt: job.updatedAt,
    logPath: job.logPath,
  }, null, 2);

  setDocLink(job.feishuDocUrl || '');
  $('audioStatus').textContent = job.isSilent === false ? '声音有效' : job.isSilent === true ? '可能静音' : '未检测';
  $('jobDir').textContent = job.jobDir || '未生成';
  $('errorText').textContent = job.error || job.feishuBaseError || '无';
}

function setDocLink(url) {
  const el = $('docLink');
  if (url) {
    el.textContent = url;
    el.href = url;
    el.classList.remove('disabled');
  } else {
    el.textContent = '暂无飞书文档链接';
    el.href = '#';
    el.classList.add('disabled');
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function refresh() {
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.serviceOnline = true;
    state.jobs = data.jobs || [];
    refreshFeishu();
  } catch {
    state.serviceOnline = false;
    state.jobs = sampleJobs;
    state.feishu = { status: 'offline', label: 'Mac Runner 未连接' };
  }
  render();
}

async function refreshFeishu() {
  if (state.feishuChecking || Date.now() - state.feishuCheckedAt < 15000) return;
  state.feishuChecking = true;
  try {
    const res = await fetch('/api/feishu/check');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.feishu = await res.json();
    state.feishuCheckedAt = Date.now();
    renderFeishu();
  } catch {
    state.feishu = { status: 'error', label: '飞书状态未知' };
    state.feishuCheckedAt = Date.now();
    renderFeishu();
  } finally {
    state.feishuChecking = false;
  }
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

async function startRun() {
  const replayUrl = $('replayUrl').value.trim();
  const title = $('manualTitle').value.trim();
  const recordSeconds = readRecordSeconds();
  if (!state.serviceOnline) {
    alert('先在 Terminal 里运行 npm run serve，再刷新页面。');
    return;
  }
  if (!replayUrl) {
    alert('先填回放链接');
    return;
  }
  state.submitting = true;
  render();
  try {
    await postJson('/api/run', { replayUrl, title, recordSeconds, recordMode: 'complete', forceRerun: true });
    await refresh();
  } finally {
    state.submitting = false;
    render();
  }
}

async function retryBase() {
  if (!state.serviceOnline) {
    alert('先在 Terminal 里运行 npm run serve，再刷新页面。');
    return;
  }
  const selected = state.jobs.find((job) => job.id === state.selectedId);
  if (!selected?.jobDir || !selected?.feishuDocUrl) {
    alert('请先选择一个已经生成飞书文档链接的任务。');
    return;
  }
  state.submitting = true;
  render();
  try {
    await postJson('/api/feishu/retry-base', {
      jobDir: selected.jobDir,
      title: selected.title || selected.id,
    });
    await refresh();
  } finally {
    state.submitting = false;
    render();
  }
}

async function startPostprocess() {
  if (!state.serviceOnline) {
    alert('先在 Terminal 里运行 npm run serve，再刷新页面。');
    return;
  }
  const selected = state.jobs.find((job) => job.id === state.selectedId);
  state.submitting = true;
  render();
  try {
    await postJson('/api/postprocess', {
      jobDir: selected?.jobDir || 'output/2026315',
      title: selected?.title || '2026.3.15 新时代视角下的「执行力」新解',
    });
    await refresh();
  } finally {
    state.submitting = false;
    render();
  }
}

$('refreshBtn').addEventListener('click', refresh);
$('runBtn').addEventListener('click', () => startRun().catch((error) => alert(error.message)));
$('postprocessBtn').addEventListener('click', () => startPostprocess().catch((error) => alert(error.message)));
$('retryBaseBtn').addEventListener('click', () => retryBase().catch((error) => alert(error.message)));
['recordHours', 'recordMinutes', 'recordSeconds'].forEach((id) => {
  $(id).addEventListener('input', updateDurationPreview);
});

updateDurationPreview();
refresh();
setInterval(refresh, 3000);
