import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { StudioFixture } from "../../../patterns/studio/fixtures/StudioFixture";

const meta = {
  title: "Product/Studio",
  component: StudioFixture,
  decorators: [(Story) => <div className="eliot-token-story"><Story /></div>],
} satisfies Meta<typeof StudioFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Useful: Story = { args: { locale: "en" } };

export const Loading: Story = { args: { locale: "en", state: "loading" } };

export const Empty: Story = { args: { locale: "en", state: "empty" } };

export const Degraded: Story = { args: { locale: "en", state: "degraded" } };

export const Error: Story = { args: { locale: "en", state: "error" } };
export const Cancelled: Story = { args: { locale: "en", state: "cancelled" } };

export const LongRussian: Story = { args: { locale: "ru" } };

export const InteractionJourney: Story = {
  args: { locale: "en" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const report = canvas.getByRole("button", { name: "Open sample draft" });
    await expect(report).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(report);
    await expect(report).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText(/Sample saved draft/)).toBeVisible();
    const proposal = canvas.getByRole("button", { name: "Create sample Wiki proposal" });
    await userEvent.click(proposal);
    await expect(canvas.getByText("State: proposed")).toBeVisible();
    await expect(proposal).toBeDisabled();
  },
};

