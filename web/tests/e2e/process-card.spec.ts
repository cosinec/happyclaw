import { expect, test, type Page } from '@playwright/test';

// The process card of a streaming reply, through chat-render-harness: a
// headline over a window of steps that is limited in height and follows its
// end, and a settled card that folds to one summary row. Runs on the mobile
// project at 390px, where the preview is shortest; the desktop block pins
// the wide measures.

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

test.use({ viewport: { width: 390, height: 844 } });

const header = (page: Page) => page.locator('[data-hc-process-card] > button');
const win = (page: Page) => page.locator('[data-hc-process-window]');

async function open(page: Page, query: string) {
  await page.goto(`${HARNESS}?${query}`);
  await expect(page.locator('[data-hc-chat-view]')).toBeVisible();
}

/** Starts a run through the real reducer, with `count` commands done and one running. */
async function runCommands(page: Page, count: number, from = 0) {
  await page.evaluate(
    ([n, first]) => {
      const { start, emit } = window.renderHarness;
      if (first === 0) start();
      for (let i = first; i < first + n; i += 1) {
        if (i > 0) {
          emit({ eventType: 'tool_result', toolUseId: `c${i - 1}` });
          emit({ eventType: 'tool_use_end', toolUseId: `c${i - 1}` });
        }
        emit({
          eventType: 'tool_use_start',
          toolName: 'Bash',
          toolUseId: `c${i}`,
          toolInputSummary: `command: echo step-${i}`,
        });
      }
    },
    [count, from],
  );
}

const scrollState = (page: Page) =>
  win(page).evaluate((el) => ({
    top: el.scrollTop,
    gap: el.scrollHeight - el.scrollTop - el.clientHeight,
    scrollable: el.scrollHeight > el.clientHeight,
    height: el.clientHeight,
  }));

async function expectNoSidewaysOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const card = document.querySelector('[data-hc-process-card]')!;
    const width = document.documentElement.clientWidth;
    const wide = [...card.querySelectorAll<HTMLElement>('*')].filter((el) => {
      if (el.getBoundingClientRect().right <= width + 1) return false;
      // A scroller of its own may hold more than it shows.
      for (let p = el.parentElement; p && p !== card; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') return false;
      }
      return true;
    });
    const scroller = card.querySelector<HTMLElement>(
      '[data-hc-process-window]',
    );
    return {
      page: document.documentElement.scrollWidth - width,
      window: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
      wide: wide.map((el) => `${el.tagName}.${el.className}`).slice(0, 3),
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.window).toBeLessThanOrEqual(0);
  expect(overflow.wide).toEqual([]);
}

test.describe('the live card', () => {
  test('its header is a whole row you can tap, 40px high, at either end', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await runCommands(page, 2);
    const row = header(page);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    const [box, card] = await Promise.all([
      row.boundingBox(),
      page.locator('[data-hc-process-card]').boundingBox(),
    ]);
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(box!.width).toBeGreaterThanOrEqual(card!.width - 1);

    // Not only the chevron: the far left of the row folds it, the far right opens it.
    await page.touchscreen.tap(card!.x + 3, box!.y + box!.height / 2);
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(win(page)).toHaveCount(0);
    // The chat is anchored to its end: folding moved the row.
    const folded = await row.boundingBox();
    await page.touchscreen.tap(
      card!.x + card!.width - 3,
      folded!.y + folded!.height / 2,
    );
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(win(page)).toBeVisible();
  });

  test('says what the run is doing, and keeps up with it', async ({ page }) => {
    await open(page, 'scenario=live');
    await page.evaluate(() => {
      const { start, emit } = window.renderHarness;
      start();
      emit({ eventType: 'status', statusText: 'requesting' });
    });
    await expect(header(page)).toContainText('正在思考…');
    await page.evaluate(() => {
      const { emit } = window.renderHarness;
      emit({ eventType: 'thinking_start' });
      emit({
        eventType: 'thinking_delta',
        text: '**核对行高估算**\n\n估算与实测不一致。',
      });
    });
    await expect(header(page)).toContainText('核对行高估算');
    await page.evaluate(() => {
      const { emit } = window.renderHarness;
      emit({ eventType: 'thinking_end', thinkingDurationMs: 1800 });
      emit({
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'b1',
        toolInputSummary: 'command: npx vitest run',
      });
    });
    await expect(header(page)).toContainText('运行命令 · npx vitest run');
    // The run's own time counts on the right.
    await expect(header(page)).toContainText(/\d+s/);
  });

  test('limits its window and follows the end, until the reader scrolls up', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await runCommands(page, 14);
    await expect(win(page)).toBeVisible();
    await expect
      .poll(async () => (await scrollState(page)).scrollable)
      .toBe(true);
    // 160px on a touch screen, and the end of the steps is in view.
    expect((await scrollState(page)).height).toBeLessThanOrEqual(161);
    await expect
      .poll(async () => (await scrollState(page)).gap)
      .toBeLessThan(4);
    await expect(win(page)).toHaveAttribute('data-scroll-fade', 'top');
    await expect(win(page).getByText('echo step-13')).toBeVisible();
    // The card does not push the answer away: it is as tall as header + window.
    const card = await page.locator('[data-hc-process-card]').boundingBox();
    expect(card!.height).toBeLessThan(220);

    // More steps keep the end in view...
    await runCommands(page, 1, 14);
    await expect(win(page).getByText('echo step-14')).toBeVisible();
    await expect
      .poll(async () => (await scrollState(page)).gap)
      .toBeLessThan(4);

    // ...until the reader has gone back to read.
    await win(page).evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(win(page)).not.toHaveAttribute('data-scroll-fade', 'top');
    await page.waitForTimeout(150);
    await runCommands(page, 1, 15);
    await expect(win(page).getByText('echo step-15')).toHaveCount(1);
    expect((await scrollState(page)).top).toBeLessThan(8);

    // Back at the end, it follows again.
    await win(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(150);
    await runCommands(page, 1, 16);
    await expect(win(page).getByText('echo step-16')).toBeVisible();
    await expect
      .poll(async () => (await scrollState(page)).gap)
      .toBeLessThan(4);
  });

  test('opens a row to read it within one line down the left, and nothing sticks out', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await page.evaluate(() => {
      const { start, emit } = window.renderHarness;
      start();
      emit({ eventType: 'thinking_start' });
      emit({
        eventType: 'thinking_delta',
        text: '**比较两种做法**\n\n窄 selector 只订阅需要的字段，改动最小；拆分 store 更彻底，但要改动所有订阅方。\n\n```ts\nconst veryLongIdentifierName = useChatStore((s) => s.streaming[jid]?.partialText);\n```',
      });
      emit({ eventType: 'thinking_end', thinkingDurationMs: 2400 });
      emit({
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'long',
        toolInputSummary: `command: ${'/workspace/group/happyclaw/web/src/components/chat/'.repeat(4)}Card.tsx`,
      });
      emit({
        eventType: 'tool_result',
        toolUseId: 'long',
        toolResult: `⚠️ ${'没有权限读取这个文件，'.repeat(12)}`,
      });
      emit({ eventType: 'tool_use_end', toolUseId: 'long' });
    });
    const rows = win(page).getByRole('listitem');
    await rows.filter({ hasText: '比较两种做法' }).getByRole('button').click();
    const body = page.locator('[data-hc-thinking-body]');
    await expect(body).toBeVisible();
    await expect(body.locator('strong')).toHaveText('比较两种做法');
    await expect(body).toHaveCSS('border-left-width', '0px');

    // The failed command opens too, and wraps in its place.
    await rows.filter({ hasText: '运行' }).getByRole('button').click();
    await expect(
      rows
        .filter({ hasText: '运行' })
        .getByText(/没有权限读取这个文件/)
        .last(),
    ).toBeVisible();

    // One line, down the left of the window, and no other.
    const lines = await page.evaluate(
      () =>
        [
          ...document.querySelectorAll<HTMLElement>('[data-hc-process-card] *'),
        ].filter((el) => {
          const style = getComputedStyle(el);
          // A rule down the left only (a code block is boxed all round).
          return (
            parseFloat(style.borderLeftWidth) > 0 &&
            parseFloat(style.borderTopWidth) === 0
          );
        }).length,
    );
    expect(lines).toBe(1);
    await expectNoSidewaysOverflow(page);
  });

  test('stays as the reader left it while the run goes on', async ({
    page,
  }) => {
    await open(page, 'scenario=live');
    await runCommands(page, 3);
    await header(page).click();
    await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
    await runCommands(page, 2, 3);
    await expect(header(page)).toContainText('echo step-4');
    await expect(header(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(win(page)).toHaveCount(0);
  });
});

test.describe('the settled card', () => {
  test('is one summary row that opens to the steps in a window of at most 60vh', async ({
    page,
  }) => {
    await open(page, 'scenario=settled');
    const card = page.locator('[data-hc-stream-card="settled"]');
    const summary = card.locator('[data-hc-process-card] > button');
    await expect(summary).toContainText('已处理');
    await expect(summary).toContainText('6 个工具');
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    await expect(win(page)).toHaveCount(0);
    await expect(card.locator('.animate-spin, .shimmer')).toHaveCount(0);

    await summary.click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await expect(win(page)).toBeVisible();
    const { height } = await scrollState(page);
    expect(height).toBeLessThanOrEqual(0.6 * 844 + 1);
    await expect(
      win(page).getByRole('list', { name: '处理步骤' }),
    ).toBeVisible();
    await expect(win(page).getByText('检查移动端滚动性能')).toBeVisible();
    await expectNoSidewaysOverflow(page);

    await summary.click();
    await expect(win(page)).toHaveCount(0);
  });
});

test.describe('on a wide screen', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
  });

  test('the window is taller, and the rows are compact', async ({ page }) => {
    await open(page, 'scenario=live');
    await runCommands(page, 9);
    // Rows are 28px with a mouse: it takes reasoning being written to fill 240.
    await page.evaluate(() => {
      const { emit } = window.renderHarness;
      emit({ eventType: 'tool_result', toolUseId: 'c8' });
      emit({ eventType: 'tool_use_end', toolUseId: 'c8' });
      emit({ eventType: 'thinking_start' });
      emit({
        eventType: 'thinking_delta',
        text: Array.from(
          { length: 20 },
          (_, i) => `第 ${i} 段：逐条核对行高估算与实际高度的差异。`,
        ).join('\n\n'),
      });
    });
    await expect
      .poll(async () => (await scrollState(page)).scrollable)
      .toBe(true);
    const { height, gap } = await scrollState(page);
    expect(height).toBeGreaterThan(200);
    expect(height).toBeLessThanOrEqual(241);
    expect(gap).toBeLessThan(4);
    const row = await win(page)
      .getByRole('listitem')
      .filter({ hasText: 'echo step-' })
      .last()
      .boundingBox();
    expect(row!.height).toBeLessThan(32);
    expect((await header(page).boundingBox())!.height).toBeLessThan(36);
  });
});
