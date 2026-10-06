// Browser-only regression check: happy-dom cannot measure layout.
// Start Vite with: npx vite --host 127.0.0.1 --port 8517
// Run with an externally installed Playwright (not needed by the unit suite):
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test-fixtures/workspace-tab-layout.mjs
// Optional: CLIENT_URL, CHROMIUM_EXECUTABLE_PATH.
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const url = process.env.CLIENT_URL ?? "http://127.0.0.1:8517";
  // Load only the real component, not the app or a live session/API server.
  await page.route(`${url}/tab-layout-test`, route => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><body style="--pi-border: #888; --pi-success-border: green"></body>',
  }));
  await page.goto(`${url}/tab-layout-test`);
  await page.evaluate(async () => {
    await import("/src/components/WorkspacePanel.ts");
  });
  for (const width of [640, 380, 220]) {
    for (const withBadge of [false, true]) {
      await page.evaluate(async ({ width, withBadge }) => {
        const { html } = await import("/@id/lit");
        const panel = document.createElement("workspace-panel");
        panel.style.width = `${width}px`;
        panel.panels = [
          { id: "test:plain", title: "Plain" },
          { id: "test:svg", title: "SVG", icon: html`<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"></circle></svg>` },
          { id: "test:custom", title: "Custom", icon: html`<span>✓</span>` },
          { id: "test:badge", title: "Count", badge: () => withBadge ? 3 : undefined },
        ].map(item => ({ ...item, render: () => html`<p>Panel content</p>` }));
        panel.pinnedIds = panel.panels.map(item => item.id);
        panel.tool = withBadge ? "test:svg" : "test:plain";
        document.body.replaceChildren(panel);
        await panel.updateComplete;
        await panel.updateComplete;
      }, { width, withBadge });
      const tabs = page.locator("workspace-panel .tabs button");
      assert.equal(await tabs.count(), 4, "All tab variants must be rendered");
      const boxes = await tabs.evaluateAll(buttons => buttons.map(button => {
        const { y, height } = button.getBoundingClientRect();
        return { label: button.getAttribute("aria-label"), y, height };
      }));
      assert(boxes.every(box => box.height > 0), "Tabs must be visible");
      assert(boxes.every(box => Math.abs(box.height - boxes[0].height) < 0.1 && Math.abs(box.y - boxes[0].y) < 0.1),
        `Tab heights must match at width ${width}, badge ${withBadge}: ${JSON.stringify(boxes)}`);
      console.log(`PASS workspace tabs: width ${width}, badge ${withBadge}, height ${boxes[0].height}`);
    }
  }
} finally {
  await browser.close();
}
