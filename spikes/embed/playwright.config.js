import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PLAYWRIGHT_DISABLE_FEATURES =
  '--disable-features=AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: './state/results.json' }]],
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          // Playwright 1.55 puts ThirdPartyStoragePartitioning on
          // --disable-features (issue 32230). --enable-features does not
          // override that list; drop the default and re-add without it.
          ignoreDefaultArgs: [PLAYWRIGHT_DISABLE_FEATURES],
          args: [
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-features=AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,Translate,AutoDeElevate',
            '--enable-features=ThirdPartyStoragePartitioning',
            '--host-resolver-rules=MAP a.localhost 127.0.0.1, MAP s.localhost 127.0.0.1, MAP embedder.test 127.0.0.1, MAP storefront.test 127.0.0.1',
          ],
        },
      },
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        launchOptions: {
          executablePath: join(ROOT, 'webkit-run.sh'),
        },
      },
    },
  ],
  webServer: {
    command: 'node server.mjs',
    url: 'http://127.0.0.1:5001/',
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
