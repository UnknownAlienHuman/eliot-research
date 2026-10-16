import { env } from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

const executablePath = env.ELIOT_UI_BROWSER_EXECUTABLE?.trim();

/** Reuse the pinned UI browser runtime for these two legacy DOM consumers; no Storybook plugin. */
export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: { host: '127.0.0.1' },
  test: {
    name: 'legacy-research-history',
    include: [
      '../pwa-research-workspace/src/research-changes-forward.browser.test.ts',
      '../pwa-research-workspace/src/research-changes-empty-forward.browser.test.ts',
    ],
    browser: { enabled: true, headless: true,
      provider: playwright(executablePath ? { launchOptions: { executablePath } } : {}),
      instances: [{ browser: 'chromium' }],
    },
  },
});
