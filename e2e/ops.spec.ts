import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function loginAs(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email uji").fill(email);
  await page.getByRole("button", { name: "Masuk (dev)" }).click();
  // akun yang sudah pernah onboarding langsung masuk ke chat
  const age = page.getByLabel(/Saya berusia 18 tahun/);
  const msg = page.getByLabel("Tulis pesan");
  await expect(age.or(msg)).toBeVisible();
  if (await age.isVisible()) {
    await age.check();
    await page.getByRole("button", { name: "Mulai ngobrol" }).click();
  }
  await expect(msg).toBeVisible();
}
const openSidebar = async (page: Page) => {
  const menu = page.getByRole("button", { name: "Buka riwayat" });
  if (await menu.isVisible()) await menu.click();
};

test("pengaturan: daftar sesi login tampil dengan sesi ini ditandai", async ({ page }) => {
  await loginAs(page, `sesi-${Date.now()}@contoh.com`);
  await openSidebar(page);
  await page.getByRole("button", { name: "Pengaturan" }).click();
  const dlg = page.getByRole("dialog", { name: "Pengaturan" });
  await expect(dlg.getByText("Sesi login")).toBeVisible();
  await expect(dlg.getByText("(sesi ini)")).toBeVisible();
});
