import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { SourcesFixture } from "../../patterns/sources/fixtures/SourcesFixture";

const meta = {
  title: "Product/Sources",
  component: SourcesFixture,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SourcesFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Useful: Story = { args: { view: "useful" } };
export const Loading: Story = { args: { view: "loading" } };
export const Empty: Story = { args: { view: "empty" } };
export const Degraded: Story = { args: { view: "degraded" } };
export const Error: Story = { args: { view: "error" } };

export const LongRussian: Story = {
  args: { view: "useful", locale: "ru" },
  render: (args) => (
    <div className="eliot-token-story" lang="ru">
      <SourcesFixture {...args} />
    </div>
  ),
};

export const InteractionJourney: Story = {
  args: { view: "useful" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const notes = canvas.getByRole("button", { name: "Open: Notes on evidence and clear thinking" });
    await userEvent.click(notes);
    const reader = canvas.getByRole("dialog", { name: "Notes on evidence and clear thinking" });
    await expect(reader).toBeVisible();
    await expect(within(reader).getByText("3 / 3")).toBeVisible();
    await expect(within(reader).getByText("Unknown for this sample")).toBeVisible();
    await userEvent.click(within(reader).getByRole("button", { name: "Close reader" }));
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    const datasheets = canvas.getByRole("checkbox", { name: /A knowledge workspace/ });
    await userEvent.click(datasheets);
    await expect(datasheets).toBeChecked();
    await expect(canvas.getAllByRole("checkbox", { checked: true })).toHaveLength(2);
    await userEvent.click(canvas.getByRole("button", { name: "Add source" }));
    const dialog = canvas.getByRole("dialog", { name: "Add a source" });
    await expect(dialog).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save source" }));
    await expect(within(dialog).getByText("Enter a source title.")).toBeVisible();
    const title = within(dialog).getByRole("textbox", { name: "Source title" });
    await userEvent.type(title, "Field notebook 12");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save source" }));
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    const added = canvas.getByRole("checkbox", { name: "Field notebook 12" });
    await expect(added).toBeVisible();
    await expect(added).not.toBeChecked();
    await expect(added).toBeDisabled();
    await expect(canvas.getAllByRole("checkbox")).toHaveLength(4);
    await expect(canvas.getAllByRole("checkbox", { checked: true })).toHaveLength(2);
  },
};
