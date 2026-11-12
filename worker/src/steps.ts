import fs from 'fs';
import path from 'path';
import type { Page } from 'playwright';
import { q } from './db';
import { env } from './env';

interface StepsOptions {
  /** 步骤落库表；回放使用 replay_steps，与正式任务记录完全隔离 */
  table?: 'run_steps' | 'replay_steps';
  /** 截图目录前缀；回放使用 replay_shots */
  dir?: 'shots' | 'replay_shots';
}

/**
 * 执行步骤记录器：每个步骤落库，可附带截图（相对 DATA_DIR 路径）。
 * meta 中约定事件类型，供“运行回放”按步骤结构化展示：
 *   navigation / filter / element_probe / submit / download / api / file_verify / error
 */
export class Steps {
  private seq = 0;
  private table: string;
  private dir: string;
  private idColumn: string;
  constructor(public runId: string, opts: StepsOptions = {}) {
    this.table = opts.table ?? 'run_steps';
    this.dir = opts.dir ?? 'shots';
    if (this.table !== 'run_steps' && this.table !== 'replay_steps') throw new Error('invalid steps table');
    this.idColumn = this.table === 'replay_steps' ? 'replay_id' : 'run_id';
  }

  async log(name: string, status: 'ok' | 'failed' | 'info' | 'blocked' = 'ok', message?: string, screenshotPath?: string, meta?: any) {
    this.seq++;
    await q(
      `INSERT INTO ${this.table}(${this.idColumn}, seq, name, status, message, screenshot_path, meta) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [this.runId, this.seq, name, status, message ?? null, screenshotPath ?? null, meta ? JSON.stringify(meta) : null],
    );
    return this.seq;
  }

  async shot(page: Page, name: string): Promise<string> {
    const rel = path.join(this.dir, this.runId, `${String(this.seq + 1).padStart(2, '0')}-${name}.png`);
    const abs = path.join(env.dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
      await page.screenshot({ path: abs, fullPage: true, timeout: 5000 });
      return rel;
    } catch {
      return '';
    }
  }

  /** 探测页面元素是否存在，作为“页面元素变化点”的结构化证据 */
  async probe(page: Page, label: string, selectors: string[]) {
    const elements: { selector: string; found: boolean; count: number }[] = [];
    for (const selector of selectors) {
      const count = await page.locator(selector).count().catch(() => 0);
      elements.push({ selector, found: count > 0, count });
    }
    const found = elements.filter((e) => e.found).length;
    await this.log('element_probe', found === elements.length ? 'ok' : 'info',
      `${label}: ${found}/${elements.length} 个元素存在`,
      undefined,
      { event: 'element_probe', label, url: page.url(), elements });
    return elements;
  }
}
