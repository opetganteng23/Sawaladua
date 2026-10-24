import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

let n = 0;
const email = (tag: string) => `${tag}-${Date.now()}-${n++}@contoh.com`;

async function toOnboarding(page: Page, tag: string) {
  await page.goto("/");
  await page.getByLabel("Email uji").fill(email(tag));
  await page.getByRole("button", { name: "Masuk (dev)" }).click();
  await expect(page.getByRole("heading", { name: "Sebelum mulai" })).toBeVisible();
}
async function toChat(page: Page, tag: string) {
  await toOnboarding(page, tag);
  await page.getByLabel(/Saya berusia 18 tahun/).check();
  await page.getByRole("button", { name: "Mulai ngobrol" }).click();
  await expect(page.getByLabel("Tulis pesan")).toBeVisible();
}
const openSidebar = async (page: Page) => {
  const menu = page.getByRole("button", { name: "Buka riwayat" });
  if (await menu.isVisible()) await menu.click();
};

test("gerbang usia: tombol mulai nonaktif sampai 18+ dikonfirmasi, tautan hukum tersedia", async ({ page }) => {
  await toOnboarding(page, "usia");
  await expect(page.getByRole("button", { name: "Mulai ngobrol" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Lewati pengaturan" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Kebijakan Privasi" })).toHaveAttribute("href", "/privasi.html");
  await page.getByLabel(/Saya berusia 18 tahun/).check();
  await expect(page.getByRole("button", { name: "Mulai ngobrol" })).toBeEnabled();
  const r = await page.request.get("/privasi.html");
  expect(r.status()).toBe(200);
  expect(await r.text()).toContain("DRAF");
});

test("panggilan suara realtime: consent, penanda mikrofon, percakapan dua arah, bisukan, akhiri, teks sementara dihapus", async ({ page }) => {
  await toChat(page, "suara");
  await openSidebar(page);
  await page.getByRole("button", { name: /Panggilan suara/ }).click();
  const dlg = page.getByRole("dialog", { name: "Panggilan suara" });
  await expect(dlg.getByText(/tidak menyimpan audio/)).toBeVisible();
  await expect(dlg.getByText(/diteruskan ke/)).toBeVisible();
  await expect(dlg.getByLabel(/Simpan transkrip panggilan/)).not.toBeChecked();
  await expect(dlg.getByLabel(/Boleh memotong Sawala/)).not.toBeChecked();
  await dlg.getByRole("button", { name: "Mulai panggilan" }).click();
  await expect(dlg.getByText("Mikrofon aktif")).toBeVisible({ timeout: 10_000 });
  // mikrofon palsu Chromium mengirim audio; provider mock menganggapnya satu ucapan lalu menjawab
  await expect(dlg.getByText("halo sawala, aku lagi capek")).toBeVisible({ timeout: 15_000 });
  await expect(dlg.getByText("Aku dengar kamu.")).toBeVisible({ timeout: 15_000 });
  await dlg.getByRole("button", { name: "Matikan mikrofon" }).click();
  await expect(dlg.getByText("Mikrofon tidak merekam")).toBeVisible();
  await dlg.getByRole("button", { name: "Akhiri panggilan" }).click();
  await expect(dlg.getByText(/Teks sementara sudah dihapus/)).toBeVisible();
  await dlg.getByRole("button", { name: "Tutup" }).last().click();
  await openSidebar(page);
  await expect(page.getByText("Panggilan suara", { exact: true })).toHaveCount(0);
});

for (const theme of ["terang", "gelap", "senja", "hutan", "sakura"]) {
  test(`aksesibilitas (axe) tema ${theme}: login, chat, pengaturan, memori`, async ({ page }, info) => {
    test.skip(info.project.name === "mobile" && theme !== "terang" && theme !== "gelap", "cukup 2 tema di mobile");
    const scan = async (label: string) => {
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = r.violations.map((v) => `${label}: ${v.id} (${v.impact}) x${v.nodes.length} -> ${v.nodes[0]?.target.join(" ")}`);
      expect(bad, bad.join("\n")).toEqual([]);
    };
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Masuk (dev)" })).toBeVisible();
    await scan("login");
    await toChat(page, `axe-${theme}`);
    await openSidebar(page);
    await page.getByRole("button", { name: "Pengaturan" }).click();
    await page.getByLabel("Tema").selectOption(theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await scan(`pengaturan-${theme}`);
    await page.getByRole("button", { name: "Tutup", exact: true }).click();
    await page.getByLabel("Tulis pesan").fill("namaku Sari, hari ini capek");
    await page.getByRole("button", { name: "Kirim pesan" }).click();
    await expect(page.getByText("Aku dengar kamu, dan itu kedengarannya berat.")).toBeVisible();
    await scan(`chat-${theme}`);
    await openSidebar(page);
    await page.getByRole("button", { name: "Memori" }).click();
    await expect(page.getByText("Pengguna bernama Sari")).toBeVisible({ timeout: 10_000 });
    await scan(`memori-${theme}`);
  });
}
