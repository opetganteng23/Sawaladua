import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallView } from "./CallView";
import { Onboarding } from "./Onboarding";
import { Confirm, Overlay } from "./Overlay";
import type { Features, User } from "../api";

const features: Features = { longTermMemory: true, moodThemes: true, proactiveGreeting: true, voiceCalls: true, dataExport: true };
const user = {
  id: "u1", email: "a@x.com", displayName: "A", onboardingDone: false, ageConfirmed: false,
  preferences: {}, privacySettings: { longTermMemory: true, allowSensitiveMemory: false, saveHistory: true },
} as unknown as User;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("Overlay", () => {
  it("fokus masuk ke dialog, Esc menutup, dan sisa halaman inert selama terbuka lalu pulih", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <div id="host">
        <main data-testid="page"><button>di belakang</button></main>
        <Overlay title="Uji" onClose={onClose}><button>dalam</button></Overlay>
      </div>,
    );
    const dlg = screen.getByRole("dialog", { name: "Uji" });
    expect(dlg).toHaveFocus();
    expect(screen.getByTestId("page")).toHaveAttribute("inert");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    rerender(<div id="host"><main data-testid="page"><button>di belakang</button></main></div>);
    expect(screen.getByTestId("page")).not.toHaveAttribute("inert");
  });

  it("Tab terjebak di dalam dialog (maju dan mundur)", async () => {
    render(<Overlay title="Uji" onClose={() => undefined}><button>satu</button><button>dua</button></Overlay>);
    const buttons = screen.getAllByRole("button");
    const first = buttons[0]!, last = buttons.at(-1)!;
    last.focus();
    await userEvent.tab();
    expect(first).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("Confirm memanggil onConfirm dan onCancel", async () => {
    const ok = vi.fn(), no = vi.fn();
    render(<Confirm title="Hapus?" body="yakin" confirmLabel="Ya" onConfirm={ok} onCancel={no} />);
    await userEvent.click(screen.getByRole("button", { name: "Ya" }));
    await userEvent.click(screen.getByRole("button", { name: "Batal" }));
    expect(ok).toHaveBeenCalledTimes(1);
    expect(no).toHaveBeenCalledTimes(1);
  });
});

describe("Onboarding", () => {
  it("tombol lanjut nonaktif sampai usia 18+ dikonfirmasi, lalu mengirim ageConfirmed", async () => {
    fetchMock.mockResolvedValue(json({ ...user, onboardingDone: true, ageConfirmed: true }));
    const done = vi.fn();
    render(<Onboarding user={user} features={features} onDone={done} />);
    const start = screen.getByRole("button", { name: "Mulai ngobrol" });
    const skip = screen.getByRole("button", { name: "Lewati pengaturan" });
    expect(start).toBeDisabled();
    expect(skip).toBeDisabled();
    await userEvent.click(screen.getByLabelText(/Saya berusia 18 tahun/));
    expect(start).toBeEnabled();
    await userEvent.click(skip);
    await waitFor(() => expect(done).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/settings");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ onboardingDone: true, ageConfirmed: true });
    expect((init as RequestInit).headers).toMatchObject({ "X-Requested-With": "sawala" });
  });
});

describe("CallView", () => {
  it("browser tanpa pengenalan suara: pesan jelas, tidak ada tombol mulai", () => {
    render(<CallView onClose={() => undefined} onEnded={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/belum mendukung pengenalan suara/);
    expect(screen.queryByRole("button", { name: "Mulai panggilan" })).toBeNull();
  });

  it("dengan dukungan: consent menjelaskan audio tidak ke server; transkrip dan barge-in default tidak dicentang", () => {
    vi.stubGlobal("webkitSpeechRecognition", class { start() {} stop() {} abort() {} });
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = class { start() {} stop() {} abort() {} };
    render(<CallView onClose={() => undefined} onEnded={() => undefined} />);
    expect(screen.getByText(/tidak pernah menerima atau menyimpan audio/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Simpan transkrip panggilan/)).not.toBeChecked();
    expect(screen.getByLabelText(/Boleh memotong Sawala/)).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Mulai panggilan" })).toBeEnabled();
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  });
});
