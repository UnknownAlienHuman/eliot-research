import { ProviderQuota, type ProviderQuotaView } from "./ProviderQuota";

const now = Date.parse("2026-10-17T12:00:00.000Z");
const goPlan: ProviderQuotaView = { state: "available", observed_at: "2026-10-17T11:59:00.000Z", windows: [
  { label: "five_hour", used_percent: 42, resets_at: "2026-10-17T14:00:00.000Z" },
  { label: "week", used_percent: 18.4, resets_at: "2026-10-20T00:00:00.000Z" },
  { label: "month", used_percent: 7, resets_at: "2026-11-01T00:00:00.000Z" },
] };
const credits: ProviderQuotaView = { state: "available", windows: [],
  credits: { used: 6.8, limit: 10, remaining: 3.2, currency: "USD" } };

interface Play { readonly canvasElement: HTMLElement }
const assert: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };

export default { title: "Workspace/Provider quota", component: ProviderQuota, parameters: { layout: "padded" } };
export const RollingWindows = {
  args: { locale: "en", quota: goPlan, now },
  play: async ({ canvasElement }: Play) => {
    const rows = [...canvasElement.querySelectorAll(".er-provider-quota > li")].map(row => row.textContent);
    assert(rows.length === 3, "Each window is one row");
    assert(rows[0] === "5 h42% · resets in 2 hours", `Five-hour window reads as used share and reset time: ${rows[0]}`);
    assert(rows[1]?.startsWith("Week18% · resets in 3 days"), `Weekly window rounds and resets in days: ${rows[1]}`);
  },
};
export const RollingWindowsRussian = { args: { locale: "ru", quota: goPlan, now } };
export const CreditBalance = {
  args: { locale: "en", quota: credits, now },
  play: async ({ canvasElement }: Play) => {
    assert(canvasElement.textContent?.includes("$3.20 of $10.00 left"), "Credits read as what is left of the cap");
  },
};
export const Unsupported = {
  args: { locale: "en", quota: { state: "unsupported", windows: [] } satisfies ProviderQuotaView, now },
  play: async ({ canvasElement }: Play) => {
    assert(canvasElement.querySelector(".er-provider-quota") === null, "A provider without a quota API shows nothing");
  },
};
