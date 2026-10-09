import type { Meta, StoryObj } from "@storybook/react-vite";
import { WorkspaceDirection } from "./WorkspaceDirection";
import { expect, userEvent, waitFor } from "storybook/test";

const meta = {
  title: "Direction/Workspace",
  component: WorkspaceDirection,
  parameters: { layout: "fullscreen" },
  args: { locale: "en", theme: "light", state: "useful" },
  argTypes: {
    locale: { options: ["en", "ru"], control: "radio" },
    theme: { options: ["light", "dark"], control: "radio" },
    state: { options: ["useful", "loading", "degraded"], control: "radio" },
  },
} satisfies Meta<typeof WorkspaceDirection>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Useful: Story = {};
export const Dark: Story = { args: { theme: "dark" } };
export const LongRussian: Story = { args: { locale: "ru" } };
export const LongRussianDark: Story = { args: { locale: "ru", theme: "dark" } };
export const Loading: Story = { args: { state: "loading" } };
export const Degraded: Story = { args: { state: "degraded" } };
export const FixtureJourney: Story = {
  play: async ({ canvas }) => {
    const add = canvas.getByRole("button", { name: "Add sources" });
    await userEvent.click(add);
    const title = canvas.getByRole("textbox", { name: "Sample source title" });
    await userEvent.type(title, "New source, separate from the report scope");
    await userEvent.click(canvas.getByRole("button", { name: "Add to preview" }));
    await waitFor(() => expect(canvas.queryByRole("dialog")).not.toBeInTheDocument());
    await expect(add).toHaveFocus();
    await expect(canvas.getByText("Captured in preview · not admitted for research")).toBeVisible();
    await expect(canvas.getByText("3 sources selected")).toBeVisible();
    const research = canvas.getAllByRole("button", { name: "Research" }).find(button => button.getAttribute("type") === "submit");
    if (!research) throw new Error("Research submit missing");
    await userEvent.click(research);
    await expect(canvas.getByRole("heading", { name: "Research is in progress" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Show sample report" }));
    await expect(canvas.getByRole("heading", { name: "From information to understanding" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Connections" }));
    await userEvent.click(canvas.getByRole("button", { name: "Review connection details" }));
    await expect(canvas.getByText("This is a synthetic preview. Access and configuration are unknown; no successful provider call has been observed.")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(canvas.queryByRole("dialog")).not.toBeInTheDocument());
  },
};
