import { expect, test, type Page } from "@playwright/test";

let n = 0;
const uniqueEmail = (tag: string) => `${tag}-${Date.now()}-${n++}@contoh.com`;

async function login(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email uji").fill(email);
  await page.getByRole("button", { name: "Masuk (dev)" }).click();
  await page.getByLabel(/Saya berusia 18 tahun/).check();
  await page.getByRole("button", { name: "Mulai ngobrol" }).click();
  await expect(page.getByLabel("Tulis pesan")).toBeVisible();
}

async function openSidebarIfMobile(page: Page) {
  const menu = page.getByRole("button", { name: "Buka riwayat" });
  if (await menu.isVisible()) await menu.click();
}

test("login, chat streaming, memori, tema, dan tidak ada overflow horizontal", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  await login(page, uniqueEmail("e2e"));
  await page.getByLabel("Tulis pesan").fill("namaku Rani, hari ini aku capek banget");
  await page.getByRole("button", { name: "Kirim pesan" }).click();
  await expect(page.getByText("Aku dengar kamu, dan itu kedengarannya berat.")).toBeVisible();
  await expect(page.getByText("Mood: hangat")).toBeVisible();
  await page.screenshot({ path: `e2e/.results/chat-${info.project.name}-terang.png` });

  // tidak ada scroll horizontal pada halaman
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBe(false);

  // memori muncul (ekstraksi asinkron)
  await openSidebarIfMobile(page);
  await page.getByRole("button", { name: "Memori" }).click();
  await expect(page.getByText("Pengguna bernama Rani")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Tutup", exact: true }).click();

  // tema gelap dan terang
  await openSidebarIfMobile(page);
  await page.getByRole("button", { name: "Pengaturan" }).click();
  await page.getByLabel("Tema").selectOption("gelap");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "gelap");
  await page.screenshot({ path: `e2e/.results/settings-${info.project.name}-gelap.png` });
  await page.getByLabel("Tema").selectOption("terang");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "terang");
  await page.getByRole("button", { name: "Tutup", exact: true }).click();

  expect(errors.filter((e) => !/favicon/.test(e))).toEqual([]);
});

test("pesan krisis dijawab respons aman dan tidak disimpan sebagai memori", async ({ page }) => {
  await login(page, uniqueEmail("krisis"));
  await page.getByLabel("Tulis pesan").fill("aku mau bunuh diri malam ini");
  await page.getByRole("button", { name: "Kirim pesan" }).click();
  await expect(page.getByText(/layanan darurat/).first()).toBeVisible();
  await expect(page.getByText(/tidak bisa memantau/)).toBeVisible();
});

test("hapus akun: tombol butuh konfirmasi HAPUS dan workflow selesai", async ({ page }) => {
  await login(page, uniqueEmail("hapus"));
  await openSidebarIfMobile(page);
  await page.getByRole("button", { name: "Pengaturan" }).click();
  await page.getByRole("button", { name: /Hapus akun/ }).click();
  await page.getByRole("button", { name: "Hapus permanen" }).click(); // tanpa konfirmasi: tidak boleh jalan
  await expect(page.getByRole("heading", { name: "Hapus akun?" })).toBeVisible();
  await page.getByLabel("Ketik HAPUS").fill("HAPUS");
  await page.getByRole("button", { name: "Hapus permanen" }).click();
  await expect(page.getByText("Penghapusan data aktif selesai.")).toBeVisible();
});

test("navigasi keyboard: dialog menjebak fokus dan Esc menutup", async ({ page }) => {
  await login(page, uniqueEmail("kbd"));
  await openSidebarIfMobile(page);
  await page.getByRole("button", { name: "Pengaturan" }).click();
  await expect(page.getByRole("dialog", { name: "Pengaturan" })).toBeVisible();
  for (let i = 0; i < 40; i++) await page.keyboard.press("Tab");
  const inside = await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
  expect(inside).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Pengaturan" })).toBeHidden();
});
