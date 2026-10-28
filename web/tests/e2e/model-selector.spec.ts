import { expect, test, type Page } from '@playwright/test';

// The composer's model picker and the reasoning effort control beside it,
// in ChatView over the composer harness. The model-selection API is answered by the test itself:
// GET returns the current selection, PUT records the body and applies it.

const HARNESS_PATH = '/tests/e2e/composer-harness.html';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

interface Selection {
  selectedModelConfigId: string | null;
  selectedModel: string | null;
  selectedEffort: string | null;
}

function payload(selection: Selection) {
  return {
    ...selection,
    default: { source: 'pool', modelConfigId: null, enabledCount: 2 },
    options: [
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        enabled: true,
        model: 'opus',
        usable: true,
      },
      {
        id: 'chatgpt',
        name: 'ChatGPT 订阅 (someone@example.com)',
        kind: 'codex',
        enabled: true,
        model: 'gpt-6.1-sol',
        usable: true,
        codex: {
          defaultModel: 'gpt-6.1-sol',
          defaultEffort: 'low',
          source: 'live',
          needsReauth: false,
          models: [
            {
              value: 'gpt-6.1-sol',
              label: 'gpt-6.1-sol（主力编码）',
              efforts: EFFORTS,
              defaultEffort: 'low',
            },
            {
              value: 'gpt-6-astra',
              label: 'gpt-6-astra（旗舰·最强推理）',
              efforts: EFFORTS,
              defaultEffort: 'medium',
            },
            {
              value: 'gpt-5.5',
              label: 'gpt-5.5（遗留）',
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
            },
          ],
        },
      },
    ],
  };
}

async function openHarness(page: Page, initial: Partial<Selection> = {}) {
  const state: Selection = {
    selectedModelConfigId: null,
    selectedModel: null,
    selectedEffort: null,
    ...initial,
  };
  const puts: Array<Record<string, unknown>> = [];
  await page.route('**/api/groups/**/model-selection**', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      puts.push(body);
      state.selectedModelConfigId = (body.modelConfigId as string) ?? null;
      state.selectedModel = (body.model as string) ?? null;
      state.selectedEffort = (body.effort as string) ?? null;
    }
    await route.fulfill({ json: payload(state) });
  });
  await page.goto(HARNESS_PATH);
  await expect(modelButton(page)).toBeVisible();
  return { puts, state };
}

const modelButton = (page: Page) =>
  page.locator('[data-hc-composer] button[aria-label^="模型："]');
/** A model row of the open panel, by the model it names. */
const modelRow = (page: Page, model: string) =>
  page.locator(`[data-model-row][title="${model}"]`);
/** The reasoning effort control next to the model. */
const effortButton = (page: Page) =>
  page.locator('[data-hc-composer] button[aria-label="选择推理等级"]');
const effortItem = (page: Page, label: string) =>
  page.getByRole('menuitemradio', { name: label, exact: true });

/** The row of composer actions the model button sits in. */
const actionRow = (page: Page) =>
  modelButton(page).locator('xpath=ancestor::div[@data-composer-toolbar][1]');

async function expectRowFits(page: Page) {
  const fits = await actionRow(page).evaluate((row) => {
    const rowBox = row.getBoundingClientRect();
    const send = row.querySelector('button[aria-label]:last-of-type');
    const sendBox = send?.getBoundingClientRect();
    return {
      overflow: row.scrollWidth - row.clientWidth,
      sendInside:
        !!sendBox &&
        sendBox.right <= window.innerWidth + 0.5 &&
        sendBox.right <= rowBox.right + 0.5,
    };
  });
  expect(fits.overflow).toBeLessThanOrEqual(1);
  expect(fits.sendInside).toBe(true);
}

const sendButton = (page: Page) =>
  page.locator('[data-composer-toolbar] button[aria-label="发送消息"]');

test.describe('model slot in the composer toolbar', () => {
  test('sits on the right, just before send', async ({ page }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'high',
    });
    const slot = (await page
      .locator('[data-composer-model-slot]')
      .boundingBox())!;
    const model = (await modelButton(page).boundingBox())!;
    const send = (await sendButton(page).boundingBox())!;
    const tools = (await page.locator('[data-composer-tools]').boundingBox())!;
    // Left: the tools. Right: the model slot, then send.
    expect(tools.x + tools.width).toBeLessThan(slot.x);
    expect(send.x - (slot.x + slot.width)).toBeLessThan(8);
    expect(model.x + model.width).toBeLessThanOrEqual(send.x + 0.5);
  });

  test('412px and 320px windows truncate the model, never the tools or send', async ({
    page,
    hasTouch,
  }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'high',
    });
    const size = hasTouch ? 40 : 30;
    for (const width of [412, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await expect
        .poll(async () => {
          const box = (await sendButton(page).boundingBox())!;
          return [Math.round(box.width), Math.round(box.height)];
        })
        .toEqual([size, size]);
      await expectRowFits(page);
      // The tools on the left keep their size and end before the slot.
      const slot = (await page
        .locator('[data-composer-model-slot]')
        .boundingBox())!;
      const tools = page.locator('[data-composer-tools] button');
      for (let i = 0; i < (await tools.count()); i += 1) {
        const tool = (await tools.nth(i).boundingBox())!;
        expect(Math.round(tool.width), `tool ${i} at ${width}px`).toBe(size);
        expect(
          tool.x + tool.width,
          `tool ${i} at ${width}px`,
        ).toBeLessThanOrEqual(slot.x + 0.5);
      }
    }
  });

  test('at 390px the model shows at least 8 characters of its name', async ({
    page,
  }) => {
    await openHarness(page, {
      selectedModelConfigId: 'official',
      selectedModel: 'claude-opus-5-5',
    });
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(modelButton(page)).toContainText('claude-opus-5-5');
    // Characters left of the ellipsis in the element that truncates the name.
    const visible = await modelButton(page).evaluate((button) => {
      const name = 'claude-opus-5-5';
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let text: Text | null = null;
      while (walker.nextNode()) {
        if ((walker.currentNode as Text).data.includes(name)) {
          text = walker.currentNode as Text;
          break;
        }
      }
      if (!text) return 0;
      let clip = text.parentElement!;
      while (clip !== button && getComputedStyle(clip).overflow === 'visible') {
        clip = clip.parentElement!;
      }
      if (clip.scrollWidth <= clip.clientWidth) return name.length;
      const canvas = document.createElement('canvas').getContext('2d')!;
      canvas.font = getComputedStyle(clip).font;
      const room = clip.clientWidth - canvas.measureText('…').width;
      const start = text.data.indexOf(name);
      const range = document.createRange();
      let shown = 0;
      for (let count = 1; count <= name.length; count += 1) {
        range.setStart(text, start);
        range.setEnd(text, start + count);
        if (range.getBoundingClientRect().width > room) break;
        shown = count;
      }
      return shown;
    });
    expect(visible).toBeGreaterThanOrEqual(8);
  });
});

test.describe('model picker', () => {
  test('fits the composer row without pushing the send button off a phone', async ({
    page,
  }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'high',
    });
    // The model, then its own effort control.
    await expect(modelButton(page)).toContainText('gpt-6-astra');
    await expect(effortButton(page)).toContainText('高');
    const boxes = await Promise.all([
      modelButton(page).boundingBox(),
      effortButton(page).boundingBox(),
    ]);
    expect(boxes[0]!.x).toBeLessThan(boxes[1]!.x);
    await expectRowFits(page);

    for (const width of [412, 360, 320]) {
      await page.setViewportSize({ width, height: 800 });
      await expectRowFits(page);
      await expect(modelButton(page)).toBeVisible();
    }
  });

  test('picking a model, then an effort, saves both for the conversation', async ({
    page,
  }) => {
    const { puts } = await openHarness(page);

    await modelButton(page).click();
    const panel = page.getByRole('dialog');
    await expect(
      panel.getByText('ChatGPT 订阅 (someone@example.com)').first(),
    ).toBeVisible();
    // Models are listed by name; whatever commentary the catalog carries stays out.
    await expect(panel).not.toContainText(/主力编码|旗舰|遗留|配置默认/);
    // Nothing to set an effort on while the pool chooses the configuration.
    await expect(effortButton(page)).toHaveCount(0);
    await modelRow(page, 'gpt-6-astra').click();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]).toMatchObject({
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: null,
    });
    await expect(modelButton(page)).toContainText('gpt-6-astra');

    await effortButton(page).click();
    // gpt-6-astra offers everything up to max here, after 默认.
    await expect(page.getByRole('menuitemradio')).toHaveCount(
      1 + EFFORTS.length,
    );
    await effortItem(page, '超高').click();
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]).toMatchObject({
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'xhigh',
    });
    await expect(effortButton(page)).toContainText('超高');

    // A model without that level puts the effort back to its default.
    await modelButton(page).click();
    await modelRow(page, 'gpt-5.5').click();
    await expect.poll(() => puts.length).toBe(3);
    expect(puts[2]).toMatchObject({ model: 'gpt-5.5', effort: null });
    await expect(modelButton(page)).toContainText('gpt-5.5');
    await expect(effortButton(page)).toContainText('中');
  });

  test('the panel stays inside a small screen', async ({ page }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
    });
    for (const width of [360, 1100]) {
      await page.setViewportSize({ width, height: 700 });
      await modelButton(page).click();
      const panel = page.getByRole('dialog');
      await expect(panel).toBeVisible();
      const box = await panel.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
    }
  });
});
