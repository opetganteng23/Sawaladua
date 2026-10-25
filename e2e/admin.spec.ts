import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const ADMIN = "admin@contoh.com"; // pemilik (ADMIN_EMAILS di playwright.config)
let n = 0;
const uniq = (t: string) => `${t}-${Date.now()}-${n++}@contoh.com`;

async function loginAs(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email uji").fill(email);
  await page.getByRole("button", { name: "Masuk (dev)" }).click();
  const age = page.getByLabel(/Saya berusia 18 tahun/);
  const msg = page.getByLabel("Tulis pesan");
  await expect(age.or(msg)).toBeVisible();
  if (await age.isVisible()) { await age.check(); await page.getByRole("button", { name: "Mulai ngobrol" }).click(); }
  await expect(msg).toBeVisible();
}
const goAdmin = async (page: Page, path = "/admin") => { await page.goto(path); await expect(page.getByRole("navigation", { name: "Bagian dasbor" })).toBeVisible(); };
const scan = async (page: Page, label: string) => {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const bad = r.violations.map((v) => `${label}: ${v.id} (${v.impact}) x${v.nodes.length} -> ${v.nodes[0]?.target.join(" ")}`);
  expect(bad, bad.join("\n")).toEqual([]);
};
async function resetSettings(page: Page) {
  await page.request.post("/api/admin/settings/reset", { data: { section: "all" }, headers: { "X-Requested-With": "sawala" } });
}

test("setiap halaman dasbor memuat, punya heading dan tabel/form, dan lolos audit aksesibilitas", async ({ page }) => {
  await loginAs(page, ADMIN);
  const pages: [string, string][] = [["/admin", "Ringkasan"], ["/admin/users", "Pengguna"], ["/admin/invites", "Undangan"], ["/admin/providers", "Provider AI"], ["/admin/settings", "Pengaturan situs"], ["/admin/features", "Fitur (kill switch)"], ["/admin/metrics", "Metrik"], ["/admin/audit", "Log audit"]];
  for (const [path, heading] of pages) {
    await goAdmin(page, path);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("link", { name: heading, exact: true }).first()).toHaveAttribute("aria-current", "page").catch(() => undefined);
    await page.waitForLoadState("networkidle");
    await scan(page, path);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow, "halaman tidak boleh punya scroll horizontal (tabel menggulir di dalam wadahnya)").toBe(false);
});

test("pengguna biasa tidak bisa membuka dasbor", async ({ page }) => {
  await loginAs(page, uniq("biasa"));
  await page.goto("/admin/users");
  await expect(page.getByRole("navigation", { name: "Bagian dasbor" })).toHaveCount(0);
  await expect(page.getByLabel("Tulis pesan")).toBeVisible(); // jatuh ke aplikasi biasa
});

test("pengguna: cari di tabel, tangguhkan (pengguna dikeluarkan), lalu pulihkan", async ({ page, browser }, info) => {
  const mail = uniq("target");
  const ctx = await browser.newContext(info.project.use);
  const victim = await ctx.newPage();
  await loginAs(victim, mail);

  await loginAs(page, ADMIN);
  await goAdmin(page, "/admin/users");
  await page.getByLabel("Cari").fill(mail);
  const table = page.getByRole("table", { name: "Daftar pengguna" });
  await expect(table.getByText(mail)).toBeVisible();
  await expect(table.getByRole("row", { name: new RegExp(mail) }).getByText("Aktif")).toBeVisible();
  await page.getByRole("button", { name: `Kelola ${mail}` }).click();
  const dlg = page.getByRole("dialog", { name: new RegExp(`Kelola ${mail}`) });
  await expect(dlg.getByText("Sesi aktif")).toBeVisible();
  await dlg.getByRole("button", { name: "Tangguhkan" }).click();
  await expect(dlg.getByText(/Akun ditangguhkan/)).toBeVisible();
  await dlg.getByRole("button", { name: "Tutup", exact: true }).click();
  await expect(table.getByRole("row", { name: new RegExp(mail) }).getByText("Ditangguhkan")).toBeVisible();

  // pengguna tidak bisa lagi memakai sesi lama
  const r = await victim.request.get("/api/conversations");
  expect(r.status()).toBe(401);

  await page.getByRole("button", { name: `Kelola ${mail}` }).click();
  await page.getByRole("dialog", { name: new RegExp(`Kelola ${mail}`) }).getByRole("button", { name: "Pulihkan" }).click();
  await expect(page.getByText("Akun dipulihkan.")).toBeVisible();
  await ctx.close();
});

test("undangan dan pendaftaran: tutup pendaftaran, tolak pengguna baru, undang, masuk", async ({ page, browser }, info) => {
  const newcomer = uniq("baru");
  await loginAs(page, ADMIN);
  try {
    await goAdmin(page, "/admin/settings");
    await page.getByLabel(/Pendaftaran terbuka/).uncheck();
    await page.getByRole("button", { name: "Simpan pengaturan" }).click();
    await expect(page.getByText(/langsung berlaku/)).toBeVisible();

    const ctx = await browser.newContext(info.project.use);
    const p2 = await ctx.newPage();
    await p2.goto("/");
    await expect(p2.getByText(/Pendaftaran sedang ditutup/)).toBeVisible();
    await p2.getByLabel("Email uji").fill(newcomer);
    await p2.getByRole("button", { name: "Masuk (dev)" }).click();
    await expect(p2.getByRole("alert").filter({ hasText: "Pendaftaran sedang ditutup" })).toBeVisible();

    await goAdmin(page, "/admin/invites");
    await page.getByLabel("Email", { exact: true }).fill(newcomer);
    await page.getByRole("button", { name: "Buat undangan" }).click();
    await expect(page.getByText(`Undangan untuk ${newcomer} dibuat.`)).toBeVisible();
    await expect(page.getByRole("table", { name: "Daftar undangan" }).getByText(newcomer)).toBeVisible();

    await p2.getByRole("button", { name: "Masuk (dev)" }).click();
    await expect(p2.getByRole("heading", { name: "Sebelum mulai" })).toBeVisible();
    await ctx.close();

    await page.reload();
    await expect(page.getByRole("table", { name: "Daftar undangan" }).getByRole("row", { name: new RegExp(newcomer) }).getByText(/Sudah dipakai/)).toBeVisible();
  } finally { await resetSettings(page); }
});

test("pengaturan situs: ubah nama, validasi per-field, berlaku di halaman login, lalu reset", async ({ page, browser }, info) => {
  await loginAs(page, ADMIN);
  try {
    await goAdmin(page, "/admin/settings");
    // validasi per-field dari server
    await page.getByLabel("Email dukungan").fill("bukan-email");
    await page.getByRole("button", { name: "Simpan pengaturan" }).click();
    await expect(page.getByText("Email tidak valid").first()).toBeVisible();
    await page.getByLabel("Email dukungan").fill("bantuan@contoh.id");
    await page.getByLabel("Nama situs").fill("Teman Pesisir");
    await page.getByLabel("Batas pesan per pengguna per 24 jam").fill("123");
    await page.getByRole("button", { name: "Simpan pengaturan" }).click();
    await expect(page.getByText(/langsung berlaku/)).toBeVisible();
    await expect(page.getByText(/Berlaku: 123 \(dari dasbor/)).toBeVisible();

    const ctx = await browser.newContext(info.project.use);
    const p2 = await ctx.newPage();
    await p2.goto("/");
    await expect(p2.getByRole("heading", { name: "Teman Pesisir" })).toBeVisible();
    await expect(p2.getByRole("link", { name: "bantuan@contoh.id" })).toBeVisible();
    await expect(p2).toHaveTitle("Teman Pesisir");
    await ctx.close();

    await page.getByRole("button", { name: "Kembalikan ke bawaan" }).first().click();
    await page.getByRole("dialog", { name: "Kembalikan ke bawaan?" }).getByRole("button", { name: "Kembalikan" }).click();
    await expect(page.getByLabel("Nama situs")).toHaveValue("Sawala");
  } finally { await resetSettings(page); }
});

test("provider AI: tabel kemampuan, kunci hanya tampil dimask, simpan dan hapus kunci", async ({ page }) => {
  await loginAs(page, ADMIN);
  await goAdmin(page, "/admin/providers");
  await expect(page.getByRole("table", { name: "Provider per kemampuan" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Model bahasa/ })).toContainText(/Mock/);
  await page.getByRole("button", { name: "Isi kunci Google Gemini" }).click();
  const dlg = page.getByRole("dialog", { name: /Kunci Google Gemini/ });
  await expect(dlg.getByLabel("Kunci API baru")).toHaveAttribute("type", "password");
  await dlg.getByLabel("Kunci API baru").fill("kunci-uji-rahasia-1234");
  await dlg.getByRole("button", { name: "Simpan kunci" }).click();
  await expect(page.getByText("Kunci disimpan (terenkripsi).")).toBeVisible();
  const row = page.getByRole("row", { name: /Google Gemini/ });
  await expect(row).toContainText("••••1234");
  expect(await page.content()).not.toContain("kunci-uji-rahasia");
  await page.getByRole("button", { name: /Hapus kunci Google Gemini dari dasbor/ }).click();
  await page.getByRole("dialog", { name: "Hapus kunci dari dasbor?" }).getByRole("button", { name: "Hapus" }).click();
  await expect(page.getByText("Kunci dihapus.")).toBeVisible();
  await expect(page.getByRole("row", { name: /Google Gemini/ })).toContainText("Belum diisi");
});

test("kill switch di dasbor mematikan fitur dan dikembalikan; tercatat di log audit", async ({ page }) => {
  await loginAs(page, ADMIN);
  try {
    await goAdmin(page, "/admin/features");
    await page.getByRole("button", { name: "Matikan Ekspor data" }).click();
    await expect(page.getByRole("row", { name: /Ekspor data/ }).getByText("Dimatikan operator")).toBeVisible();
    await page.getByRole("button", { name: "Nyalakan Ekspor data" }).click();
    await expect(page.getByRole("row", { name: /Ekspor data/ }).getByText("Menyala")).toBeVisible();
    await goAdmin(page, "/admin/audit");
    await expect(page.getByRole("table", { name: "Log audit tindakan admin" }).getByText("flags.update").first()).toBeVisible();
  } finally {
    await page.request.patch("/api/admin/flags", { data: { killed: [] }, headers: { "X-Requested-With": "sawala" } });
  }
});
