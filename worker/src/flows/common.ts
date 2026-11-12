import type { Page } from 'playwright';
import { env } from '../env';
import { FlowError } from '../errors';
import type { Steps } from '../steps';

export interface TaskContext {
  task: {
    id: string;
    biz_date: string;        // YYYY-MM-DD
    source_kind: string;
    store_code: string;
    platform_code: string;
    username: string;
    password: string;
    api_token: string | null;
  };
  runId: string;
  steps: Steps;
}

export interface FlowResult {
  absPath: string;   // 落盘绝对路径
  fileName: string;  // 原始文件名
  wrongFile?: boolean; // 内容校验发现文件与任务不符（保留为证据，状态 rejected）
}

/** 导航留痕：每次页面跳转都记录结构化 navigation 事件，供回放展示 */
export async function navigate(page: Page, steps: Steps, url: string, phase: string, platform?: string) {
  await steps.log('navigate', 'info', url, undefined, { event: 'navigation', phase, url, platform });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
}

/** 登录（ALPHA/BETA 通用）：识别验证码 / 短信 / 登录失效 */
export async function loginFlow(page: Page, ctx: TaskContext, platform: 'ALPHA' | 'BETA') {
  const { steps, task } = ctx;
  await navigate(page, steps, `${env.mockBaseUrl}/${platform}/login`, 'login', platform);
  await steps.probe(page, '登录页元素', ['#username', '#password', '#login-btn', '#captcha-img']);
  if (await page.locator('#captcha-img').count()) {
    const shot = await steps.shot(page, 'captcha');
    await steps.log('login_blocked', 'failed', '登录页出现人机验证', shot);
    throw new FlowError('CAPTCHA_REQUIRED', '登录页出现人机验证，需人工接管', { intervention: 'captcha', retryable: false, screenshot: shot });
  }
  await page.fill('#username', task.username);
  await page.fill('#password', task.password);
  await page.click('#login-btn');
  await page.waitForLoadState('domcontentloaded');

  if (await page.locator('#sms-code').count()) {
    const shot = await steps.shot(page, 'sms');
    await steps.log('login_blocked', 'failed', '需要短信验证码', shot);
    throw new FlowError('SMS_REQUIRED', '平台要求短信验证码，需人工接管', { intervention: 'sms', retryable: false, screenshot: shot });
  }
  const errEl = page.locator('#login-error');
  if (page.url().includes('/login') || (await errEl.count())) {
    const msg = (await errEl.innerText().catch(() => '')) || '登录失败';
    const shot = await steps.shot(page, 'login_failed');
    await steps.log('login_failed', 'failed', msg, shot);
    if (msg.includes('人机验证')) {
      throw new FlowError('CAPTCHA_REQUIRED', msg, { intervention: 'captcha', retryable: false, screenshot: shot });
    }
    throw new FlowError('LOGIN_EXPIRED', `登录失效：${msg}`, { intervention: 'login_expired', retryable: false, screenshot: shot });
  }
  await steps.log('login_ok', 'ok', `账号 ${task.username} 登录成功`);
}

/** 设置日期窗口并回读校验（识别“日期控件未生效”） */
export async function setDateWindow(page: Page, ctx: TaskContext, platform: 'ALPHA' | 'BETA') {
  const { steps, task } = ctx;
  const date = task.biz_date;
  await navigate(page, steps, `${env.mockBaseUrl}/${platform}/report`, 'report', platform);
  await steps.probe(page, '报表页元素', ['#start-date', '#end-date', '#query-btn', platform === 'ALPHA' ? '#export-btn' : '#request-export-btn']);
  await page.fill('#start-date', date);
  await page.fill('#end-date', date);
  await page.click('#query-btn');
  await page.waitForLoadState('domcontentloaded');
  const actualStart = await page.inputValue('#start-date');
  const actualEnd = await page.inputValue('#end-date');
  const filter = { event: 'filter', platform, start: date, end: date, actualStart, actualEnd, valid: actualStart === date && actualEnd === date };
  if (!filter.valid) {
    const shot = await steps.shot(page, 'date_control');
    await steps.log('date_window', 'failed', `期望 ${date}，实际 ${actualStart}~${actualEnd}`, shot, filter);
    throw new FlowError('DATE_CONTROL_FAILED', `日期控件未生效：期望 ${date}，实际 ${actualStart}~${actualEnd}`, { retryable: false, screenshot: shot });
  }
  await steps.log('date_window', 'ok', `日期窗口 ${date} 已生效`, undefined, filter);
}

/** 把 Playwright 选择器超时映射为“页面元素改版” */
export async function withElementGuard<T>(fn: () => Promise<T>, page: Page, steps: Steps): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.name === 'TimeoutError') {
      const shot = await steps.shot(page, 'element_not_found');
      await steps.log('element_check', 'failed', `页面元素未找到（疑似改版）：${String(e.message).slice(0, 200)}`, shot,
        { event: 'error', kind: 'element_not_found', url: page.url() });
      throw new FlowError('ELEMENT_NOT_FOUND', '页面元素未找到，疑似平台页面改版', { retryable: false, screenshot: shot });
    }
    throw e;
  }
}
