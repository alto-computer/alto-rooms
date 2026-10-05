import { expect, test } from "./fixtures";

const HOSTILE = `<!doctype html><title>수상한 문서</title>
<script>top.location='https://example.com'; fetch('http://127.0.0.1:14317/v1/rooms',{method:'POST',headers:{'content-type':'application/json'},body:'{"name":"x"}'})</script>
<script>try { parent.postMessage({ type: 'open', roomId: 'x' }, '*') } catch (e) {}</script>
<script>console.log('hostile script ran')</script>`;

test("Review Focus 4: a hostile artifact can't navigate the app or write to roomsd", async ({ page, daemon }) => {
  await daemon.createRoom("보안");
  await daemon.write("보안/evil.html", HOSTILE);

  // Proves the attack really executed inside the sandbox (and wasn't just never loaded).
  let ran = 0;
  page.on("console", (m) => {
    if (m.text() === "hostile script ran") ran++;
  });

  await page.goto("/");
  const start = page.url();
  let mainNavigations = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) mainNavigations++;
  });

  // The strip preview runs the script…
  await page.getByRole("list", { name: "방" }).getByRole("button", { name: "보안" }).click();
  const c = page.getByTestId("artifact-card").filter({ hasText: "수상한 문서" });
  await expect(c).toBeVisible({ timeout: 2000 });
  await expect(c.locator("iframe")).toHaveAttribute("sandbox", "allow-scripts allow-popups");
  // …and so does the full doc tab.
  await c.hover();
  await c.getByRole("button", { name: "새 탭에서 크게 보기" }).click();
  await expect(page.getByRole("tab", { name: "수상한 문서", selected: true })).toBeVisible();

  await expect.poll(() => ran).toBeGreaterThanOrEqual(2); // strip preview + doc tab
  await page.waitForTimeout(1000);
  expect(page.url()).toBe(start);
  expect(mainNavigations).toBe(0);
  const rooms = await daemon.listRooms();
  expect(rooms.map((r) => r.name)).not.toContain("x");
  expect(await daemon.exists("x")).toBe(false);
  // The app ignored the message: still on the doc tab, nothing else opened.
  await expect(page.getByRole("tab")).toHaveCount(3);
});
