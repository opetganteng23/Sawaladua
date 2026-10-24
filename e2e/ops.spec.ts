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

test("halaman admin: hanya untuk admin; metrik tampil; kill switch mematikan fitur tanpa restart", async ({ page, browser }, info) => {
  // pengguna biasa tidak melihat tautan Metrik dan /admin tidak membuka dasbor
  await loginAs(page, `biasa-${Date.now()}@contoh.com`);
  await openSidebar(page);
  await expect(page.getByRole("link", { name: "Metrik" })).toHaveCount(0);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Metrik operator" })).toHaveCount(0);

  const ctx = await browser.newContext(info.project.use);
  const admin = await ctx.newPage();
  await loginAs(admin, "admin@contoh.com");
  await admin.getByLabel("Tulis pesan").fill("halo untuk metrik");
  await admin.getByRole("button", { name: "Kirim pesan" }).click();
  await expect(admin.getByText("Hmm, begitu ya.")).toBeVisible();
  await openSidebar(admin);
  await admin.getByRole("link", { name: "Metrik" }).click();
  await expect(admin.getByRole("heading", { name: "Metrik operator" })).toBeVisible();
  await expect(admin.getByRole("table", { name: "Penggunaan harian" })).toBeVisible();
  const axe = await new AxeBuilder({ page: admin }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`)).toEqual([]);

  // matikan "Panggilan suara" -> tombol hilang dari aplikasi pengguna setelah muat ulang (tanpa restart server)
  try {
    await admin.getByLabel(/Panggilan suara/).click();
    await expect(admin.getByText(/dimatikan operator/)).toBeVisible();
    await admin.goto("/");
    await openSidebar(admin);
    await expect(admin.getByRole("button", { name: /Panggilan suara/ })).toHaveCount(0);
    // nyalakan kembali lewat UI
    await admin.goto("/admin");
    await admin.getByLabel(/Panggilan suara/).click();
    await expect(admin.getByText(/dimatikan operator/)).toHaveCount(0);
  } finally {
    // pastikan kill switch dipulihkan walau tes gagal, agar tes lain tidak ikut rusak
    await admin.request.patch("/api/admin/flags", { data: { killed: [] }, headers: { "X-Requested-With": "sawala" } });
    await ctx.close();
  }
});

test("pengaturan: daftar sesi login tampil dengan sesi ini ditandai", async ({ page }) => {
  await loginAs(page, `sesi-${Date.now()}@contoh.com`);
  await openSidebar(page);
  await page.getByRole("button", { name: "Pengaturan" }).click();
  const dlg = page.getByRole("dialog", { name: "Pengaturan" });
  await expect(dlg.getByText("Sesi login")).toBeVisible();
  await expect(dlg.getByText("(sesi ini)")).toBeVisible();
});
