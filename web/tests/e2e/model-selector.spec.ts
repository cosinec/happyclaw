import { expect, test, type Page } from '@playwright/test';

// The composer's model picker (with the ChatGPT reasoning effort in its
// panel), in ChatView over the composer harness. The model-selection API is answered by the test itself:
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
/** A reasoning effort chip of the open panel. */
const effortChip = (page: Page, effort: string) =>
  page.locator(`[data-effort="${effort}"]`);

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

test.describe('model picker', () => {
  test('fits the composer row without pushing the send button off a phone', async ({
    page,
  }) => {
    await openHarness(page, {
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'high',
    });
    // The model, then its effort in plain text.
    await expect(modelButton(page)).toContainText('gpt-6-astra');
    await expect(modelButton(page)).toContainText('高');
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
    await expect(
      panel.getByRole('radiogroup', { name: '推理档位' }),
    ).toHaveCount(0);
    await modelRow(page, 'gpt-6-astra').click();
    await expect.poll(() => puts.length).toBe(1);
    expect(puts[0]).toMatchObject({
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: null,
    });
    await expect(modelButton(page)).toContainText('gpt-6-astra');

    await modelButton(page).click();
    const efforts = page.getByRole('radiogroup', { name: '推理档位' });
    await expect(efforts).toBeVisible();
    // gpt-6-astra offers everything up to max here, after the default chip.
    await expect(efforts.getByRole('radio')).toHaveCount(1 + EFFORTS.length);
    await effortChip(page, 'xhigh').click();
    await expect.poll(() => puts.length).toBe(2);
    expect(puts[1]).toMatchObject({
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'xhigh',
    });
    await expect(modelButton(page)).toContainText('超高');

    // A model without that level puts the effort back to its default.
    await modelRow(page, 'gpt-5.5').click();
    await expect.poll(() => puts.length).toBe(3);
    expect(puts[2]).toMatchObject({ model: 'gpt-5.5', effort: null });
    await expect(modelButton(page)).toContainText('gpt-5.5中');
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
