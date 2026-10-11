import { expect, test, type Page } from '@playwright/test';

// What the streaming card shows, through chat-render-harness: the step
// timeline and its classic fallback, reasoning as Markdown, the silent wait,
// a proactive workspace's process at each visibility, and the reasoning and
// trace the server kept of an earlier reply. Runs on the mobile project (the
// CI one); the desktop blocks pin the wide layout.

const HARNESS = '/tests/e2e/chat-render-harness.html';

declare global {
  interface Window {
    renderHarness: {
      start: () => void;
      emit: (event: Record<string, unknown>) => void;
      finish: (content: string) => void;
    };
  }
}

async function open(page: Page, query: string) {
  await page.goto(`${HARNESS}?${query}`);
  await expect(page.locator('[data-hc-chat-view]')).toBeVisible();
}

const block = (page: Page) => page.locator('[data-hc-streaming-block]');

/**
 * Nothing of the chat leaves the viewport sideways: the page does not scroll
 * across, and no element sticks out unless its own scroller clips it (a code
 * block scrolls inside itself).
 */
async function expectNoSidewaysOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (p.hasAttribute('data-hc-streaming-block')) return false;
        if (getComputedStyle(p).overflowX !== 'visible') return true;
      }
      return false;
    };
    const wide = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-hc-streaming-block] *, [data-hc-chat-view] [data-hc-process-panel] *',
      ),
    ].filter(
      (el) => el.getBoundingClientRect().right > width + 1 && !clipped(el),
    );
    return {
      page: document.documentElement.scrollWidth - width,
      wide: wide.map((el) => el.tagName + '.' + el.className).slice(0, 3),
    };
  });
  expect(overflow.wide).toEqual([]);
  expect(overflow.page).toBeLessThanOrEqual(0);
}

test.describe('the step timeline', () => {
  test('lists the steps in the order they happened, with the answer below', async ({
    page,
  }) => {
    await open(page, 'scenario=streaming');
    const timeline = block(page).getByRole('list', { name: '处理步骤' });
    await expect(timeline).toBeVisible();
    await expect(timeline).toHaveAttribute('data-hc-step-timeline', '');

    // The oldest steps fold into one line that says what they were.
    await expect(
      timeline.getByRole('button', { name: /较早 4 步 · 3 个工具/ }),
    ).toBeVisible();
    // The latest ones are rows: finished reasoning, commentary, running tool,
    // the sub-agent, and the reasoning being written.
    await expect(timeline.getByText('比较方案')).toBeVisible();
    await expect(
      timeline.getByText('我先把渲染循环换成虚拟列表，再跑测试。'),
    ).toBeVisible();
    await expect(
      timeline.getByText(/npx vitest run tests\/frontend-session-sidebar-copy/),
    ).toBeVisible();
    await expect(timeline.getByText('检查移动端滚动性能')).toBeVisible();
    await expect(timeline.getByText('思考中…')).toBeVisible();

    // The answer is the text under the steps, not one of them.
    const answer = block(page).getByText(
      /^正在把会话列表改成虚拟滚动。目前已经替换了/,
    );
    await expect(answer).toBeVisible();
    const [list, text] = await Promise.all([
      timeline.boundingBox(),
      answer.boundingBox(),
    ]);
    expect(text!.y).toBeGreaterThanOrEqual(list!.y + list!.height - 1);
    await expectNoSidewaysOverflow(page);
  });

  test('opens a folded line to the steps it holds', async ({ page }) => {
    await open(page, 'scenario=streaming');
    const timeline = block(page).getByRole('list', { name: '处理步骤' });
    const folded = timeline.getByRole('button', { name: /较早 4 步/ });
    await expect(folded).toHaveAttribute('aria-expanded', 'false');
    await expect(timeline.getByText('useVirtualizer in web/src')).toHaveCount(
      0,
    );
    await folded.click();
    await expect(folded).toHaveAttribute('aria-expanded', 'true');
    await expect(timeline.getByText('useVirtualizer in web/src')).toBeVisible();
    // A failed call says why, in its own row.
    await expect(timeline.getByText('被权限策略拒绝')).toBeVisible();
  });

  test('has touch-sized buttons and nothing that sticks out sideways', async ({
    page,
  }) => {
    await open(page, 'scenario=streaming');
    const timeline = block(page).getByRole('list', { name: '处理步骤' });
    const buttons = timeline.getByRole('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(2);
    for (let i = 0; i < count; i += 1) {
      const box = await buttons.nth(i).boundingBox();
      // 40px is the touch target the coarse-pointer variants ask for.
      expect(box!.height).toBeGreaterThanOrEqual(39);
    }
    await expectNoSidewaysOverflow(page);
  });

  test('is the classic stack of cards when the reader chose that layout', async ({
    page,
  }) => {
    await open(page, 'scenario=streaming&layout=classic');
    await expect(block(page).getByText('思考中…')).toBeVisible();
    await expect(page.locator('[data-hc-step-timeline]')).toHaveCount(0);
    await expect(
      block(page).getByRole('button', { name: /执行详情/ }),
    ).toBeVisible();
    await expect(block(page).getByText('检查移动端滚动性能')).toBeVisible();
    await expectNoSidewaysOverflow(page);
  });

  test('is shaped like the finished message once the run is over', async ({
    page,
  }) => {
    await open(page, 'scenario=settled');
    const card = page.locator('[data-hc-stream-card="settled"]');
    await expect(card).toBeVisible();
    // Reasoning and execution details each fold to a row; nothing spins.
    await expect(
      card.getByRole('button', { name: /已思考 21 秒/ }),
    ).toBeVisible();
    await expect(
      card.getByRole('button', { name: /执行详情.*已使用 2 个工具/ }),
    ).toBeVisible();
    await expect(page.locator('[data-hc-step-timeline]')).toHaveCount(0);
    await expect(card.locator('.animate-spin')).toHaveCount(0);
    await expect(card.getByText('正在把会话列表改成虚拟滚动。')).toBeVisible();
  });
});

test.describe('reasoning', () => {
  test('reads as Markdown: titles, lists and code', async ({ page }) => {
    await open(page, 'scenario=thinking-markdown');
    const body = block(page).locator('[data-hc-thinking-body]');
    await expect(body).toBeVisible();
    await expect(body.locator('strong')).toHaveCount(3);
    await expect(body.locator('li')).toHaveCount(2);
    await expect(body.locator('pre code')).toContainText('useChatStore');
    // The latest title is on the collapsed row too.
    await expect(
      block(page).getByRole('button', { name: /思考中….*确认行高估算/ }),
    ).toBeVisible();
    await expectNoSidewaysOverflow(page);
  });

  test('follows its own end while it arrives, until the reader scrolls up', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await page.evaluate(() => {
      window.renderHarness.start();
      window.renderHarness.emit({ eventType: 'thinking_start' });
      window.renderHarness.emit({
        eventType: 'thinking_delta',
        text: Array.from(
          { length: 30 },
          (_, i) => `第 ${i} 段：逐条核对行高估算与实际高度的差异。`,
        ).join('\n\n'),
      });
    });
    const body = page.locator('[data-hc-thinking-body]');
    await expect(body).toBeVisible();
    const state = () =>
      body.evaluate((el) => ({
        top: el.scrollTop,
        gap: el.scrollHeight - el.scrollTop - el.clientHeight,
        scrollable: el.scrollHeight > el.clientHeight,
      }));
    await expect.poll(async () => (await state()).scrollable).toBe(true);
    await expect.poll(async () => (await state()).gap).toBeLessThan(4);

    // More text keeps the end in view...
    await page.evaluate(() =>
      window.renderHarness.emit({
        eventType: 'thinking_delta',
        text: '\n\n又想到一点：补充一条回归测试。',
      }),
    );
    await expect(body).toContainText('补充一条回归测试');
    await expect.poll(async () => (await state()).gap).toBeLessThan(4);

    // ...but not once the reader went back to re-read.
    await body.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(150);
    await page.evaluate(() =>
      window.renderHarness.emit({
        eventType: 'thinking_delta',
        text: '\n\n最后再确认一次边界。',
      }),
    );
    await expect(body).toContainText('最后再确认一次边界');
    expect((await state()).top).toBeLessThan(8);
  });

  test('scrolls in its own area without handing the scroll on to the chat', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await page.evaluate(() => {
      window.renderHarness.start();
      window.renderHarness.emit({ eventType: 'thinking_start' });
      window.renderHarness.emit({
        eventType: 'thinking_delta',
        text: Array.from({ length: 30 }, (_, i) => `第 ${i} 段。`).join('\n\n'),
      });
    });
    const body = page.locator('[data-hc-thinking-body]');
    await expect(body).toBeVisible();
    await expect(body).toHaveCSS('overscroll-behavior-y', 'contain');
    await expect(body).toHaveCSS('overflow-y', 'auto');
  });
});

test.describe('the wait for the model', () => {
  test('says the model is thinking, with a placeholder and a timer', async ({
    page,
  }) => {
    await open(page, 'scenario=silent');
    const wait = page.locator('[data-hc-model-wait]');
    await expect(wait).toBeVisible();
    await expect(wait).toContainText('正在思考…');
    await expect(wait).toContainText(/\d+s/);
    // Decorative lines are hidden from assistive tech.
    await expect(wait.locator('[aria-hidden="true"]').first()).toBeAttached();
    // "Processing" is for a proactive workspace; an assistant is thinking.
    await expect(block(page).getByText('正在处理')).toHaveCount(0);
    await expectNoSidewaysOverflow(page);
  });
});

test.describe('a proactive workspace', () => {
  const secrets = [
    '这段是还没发出去的回复草稿',
    '用户希望保持排序',
    '确认订阅范围',
    '核对行高估算',
    // A sub-agent's text is never shown, its reasoning only at the full level.
    '正在用 Playwright 录制',
    '子 Agent 的思考',
  ];

  async function expectNoModelText(page: Page, except: string[] = []) {
    const text = await block(page).innerText();
    for (const secret of secrets.filter((s) => !except.includes(s))) {
      expect(text, `shows "${secret}"`).not.toContain(secret);
    }
  }

  test('hidden: only that it is working, and a way to change that', async ({
    page,
  }) => {
    await open(page, 'scenario=proactive&visibility=hidden');
    await expect(block(page).getByText('正在处理…')).toBeVisible();
    await expect(
      block(page).getByRole('button', { name: '显示过程' }),
    ).toBeVisible();
    await expect(page.locator('[data-hc-process-panel]')).toHaveCount(0);
    const text = await block(page).innerText();
    for (const word of ['Bash', 'Grep', 'vitest', '检查移动端滚动性能']) {
      expect(text).not.toContain(word);
    }
    await expectNoModelText(page);
  });

  test('activity: one line of the process, the steps when opened, never the model text', async ({
    page,
  }) => {
    await open(page, 'scenario=proactive&visibility=activity');
    const panel = page.locator('[data-hc-process-panel]');
    const toggle = panel.getByRole('button', { name: /处理过程/ });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('正在运行命令');
    await expect(toggle).toContainText('1 个子 Agent 运行中');
    await expect(toggle).toContainText(/\d+s/);
    await expectNoModelText(page);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const steps = panel.getByRole('list', { name: '处理步骤' });
    await expect(
      steps.getByText(/npx vitest run tests\/frontend-session-sidebar-copy/),
    ).toBeVisible();
    await expect(steps.getByText('检查移动端滚动性能')).toBeVisible();
    // With none of its text to show, the sub-agent is a row, not a card to open.
    await expect(
      steps.getByRole('button', { name: /检查移动端滚动性能/ }),
    ).toHaveCount(0);
    // The model reasoned for 6.4 seconds; what it wrote stays out of view.
    await expect(steps.getByText('已思考 6.4 秒')).toBeVisible();
    await expect(panel.getByText('计划')).toBeVisible();
    await expectNoModelText(page);
    await expectNoSidewaysOverflow(page);
  });

  test('full: adds the reasoning summary, still not the reply text', async ({
    page,
  }) => {
    await open(page, 'scenario=proactive&visibility=full');
    const panel = page.locator('[data-hc-process-panel]');
    await panel.getByRole('button', { name: /处理过程/ }).click();
    const steps = panel.getByRole('list', { name: '处理步骤' });
    const reasoning = steps.getByRole('button', { name: /已思考 6.4 秒/ });
    await expect(reasoning).toContainText('确认订阅范围');
    await reasoning.click();
    await expect(
      steps
        .locator('[data-hc-thinking-body]')
        .filter({ hasText: '用户希望保持排序' }),
    ).toBeVisible();
    // A sub-agent's reasoning comes with it, in a card that opens; its text
    // never does.
    await expect(
      steps.getByRole('button', { name: /检查移动端滚动性能/ }),
    ).toBeVisible();
    await expect(steps.getByText('子 Agent 的思考')).toBeVisible();
    await expectNoModelText(page, [
      '确认订阅范围',
      '用户希望保持排序',
      '子 Agent 的思考',
    ]);
    await expectNoSidewaysOverflow(page);
  });

  test('"显示过程" opens the reply-mode settings with the visibility levels', async ({
    page,
  }) => {
    await open(page, 'scenario=proactive&visibility=hidden');
    await block(page).getByRole('button', { name: '显示过程' }).click();
    const dialog = page.getByRole('dialog', { name: '工作区回复模式' });
    await expect(dialog).toBeVisible();
    const levels = dialog.getByRole('group', { name: '过程可见性' });
    await expect(levels.getByRole('radio')).toHaveCount(3);
    await expect(levels.getByRole('radio', { name: /隐藏/ })).toBeChecked();
    await expect(
      dialog.getByText('只影响 Web', { exact: false }),
    ).toBeVisible();
  });
});

test.describe('the reasoning and trace the server kept', () => {
  const TURN = {
    turn_id: 'turn-kept',
    thinking: '**确认范围**\n\n先看订阅层级，再比较方案。',
    thinking_duration_ms: 6_400,
    trace: [
      {
        id: 'k1',
        timestamp: 1,
        kind: 'tool',
        title: '工具 Grep',
        summary: 'useChatStore in web/src',
        toolUseId: 'kt1',
      },
    ],
    created_at: '2026-10-10T00:00:00.000Z',
  };

  const route = (page: Page, handler: Parameters<Page['route']>[1]) =>
    page.route('**/api/groups/*/turn-traces/*', handler);

  test('shows two collapsed rows that load when one is opened', async ({
    page,
  }) => {
    const requests: string[] = [];
    await route(page, (r) => {
      requests.push(new URL(r.request().url()).pathname);
      return r.fulfill({ json: TURN });
    });
    await open(page, 'scenario=lazy-trace');
    const thinking = page.getByRole('button', { name: '思考过程' });
    const trace = page.getByRole('button', { name: '执行详情' });
    await expect(thinking).toBeVisible();
    await expect(trace).toBeVisible();
    // Nothing is asked for until a row is opened.
    expect(requests).toEqual([]);

    await trace.click();
    await expect(
      page.getByRole('button', { name: /已思考 6.4 秒/ }),
    ).toBeVisible();
    // The row that was pressed is the block that opened.
    const loaded = page.getByRole('button', {
      name: /执行详情.*已使用 1 个工具/,
    });
    await expect(loaded).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('useChatStore in web/src')).toBeVisible();
    expect(requests).toEqual([
      '/api/groups/web%3Arender-harness/turn-traces/turn-kept',
    ]);
    // The reply itself did not move out from under the reader.
    await expect(page.getByText('改成窄 selector 即可。')).toBeVisible();
  });

  test('asks again after a failure, and drops the rows when the server has nothing', async ({
    page,
  }) => {
    let calls = 0;
    await route(page, (r) => {
      calls += 1;
      if (calls === 1) return r.fulfill({ status: 500, json: { error: 'x' } });
      if (calls === 2) return r.fulfill({ status: 404, json: { error: 'x' } });
      return r.fulfill({ json: TURN });
    });
    await open(page, 'scenario=lazy-trace');
    await page.getByRole('button', { name: '执行详情' }).click();
    await expect(page.getByText('暂时无法加载，点击重试')).toBeVisible();
    // The page shows no error toast for it.
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0);

    await page.getByRole('button', { name: '执行详情' }).click();
    await expect(page.getByRole('button', { name: '执行详情' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '思考过程' })).toHaveCount(0);
    await expect(page.getByText('改成窄 selector 即可。')).toBeVisible();
    expect(calls).toBe(2);
  });

  for (const [visibility, reasoning, trace] of [
    ['hidden', false, false],
    ['activity', false, true],
    ['full', true, true],
  ] as const) {
    test(`a proactive reply at the ${visibility} level offers ${
      !trace
        ? 'nothing'
        : reasoning
          ? 'the trace and the reasoning'
          : 'the trace only'
    }`, async ({ page }) => {
      await route(page, (r) => r.fulfill({ json: TURN }));
      await open(
        page,
        `scenario=lazy-trace&mode=proactive&visibility=${visibility}`,
      );
      await expect(page.getByText('改成窄 selector 即可。')).toBeVisible();
      await expect(page.getByRole('button', { name: '思考过程' })).toHaveCount(
        reasoning ? 1 : 0,
      );
      await expect(page.getByRole('button', { name: '执行详情' })).toHaveCount(
        trace ? 1 : 0,
      );
    });
  }
});

test.describe('on a wide screen', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
  });

  test('the timeline sits in the message column and stays readable', async ({
    page,
  }) => {
    await open(page, 'scenario=streaming');
    const timeline = block(page).getByRole('list', { name: '处理步骤' });
    await expect(timeline).toBeVisible();
    const [list, card] = await Promise.all([
      timeline.boundingBox(),
      block(page).boundingBox(),
    ]);
    expect(list!.x).toBeGreaterThanOrEqual(card!.x);
    expect(list!.x + list!.width).toBeLessThanOrEqual(
      card!.x + card!.width + 1,
    );
    // Rows are 28px tall with a mouse; the touch-sized variant does not apply.
    const folded = timeline.getByRole('button', { name: /较早 4 步/ });
    expect((await folded.boundingBox())!.height).toBeLessThan(32);
  });

  test('the process line of a proactive workspace names its latest tool', async ({
    page,
  }) => {
    await open(page, 'scenario=proactive&visibility=activity');
    const toggle = page
      .locator('[data-hc-process-panel]')
      .getByRole('button', { name: /处理过程/ });
    await expect(toggle).toContainText('最近：运行');
  });
});
