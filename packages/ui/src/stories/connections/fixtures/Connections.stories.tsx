import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ConnectionsFixture } from "../../../patterns/connections/fixtures/ConnectionsFixture";

const meta = {
  title: "Product/Connections",
  component: ConnectionsFixture,
  decorators: [(Story) => <div className="eliot-token-story"><Story /></div>],
} satisfies Meta<typeof ConnectionsFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Useful: Story = {
  render: () => <ConnectionsFixture locale="en" state="useful" />,
};

export const Loading: Story = {
  render: () => <ConnectionsFixture locale="en" state="loading" />,
};

export const Empty: Story = {
  render: () => <ConnectionsFixture locale="en" state="empty" />,
};

export const Degraded: Story = {
  render: () => <ConnectionsFixture locale="en" state="degraded" />,
};

export const Error: Story = {
  render: () => <ConnectionsFixture locale="en" state="error" />,
};

export const LongRussian: Story = {
  render: () => (
    <ConnectionsFixture
      locale="ru"
      state="useful"
      diagnostic="учебный-след-0a4f9c2b7d1e8f35640ab19c7d2e5b8f09c1a3d4e6f70b2c5d8e1a4f7c0b3d6e9"
    />
  ),
};

export const InteractionJourney: Story = {
  render: () => <ConnectionsFixture locale="en" state="empty" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Session recovery is offered while the sample session is missing.
    const signIn = canvas.getByRole("button", { name: "Sample sign-in" });
    await expect(signIn).toBeEnabled();

    await userEvent.click(canvas.getByRole("button", { name: "Check sample" }));
    await expect(canvas.getByText("Sample API answered")).toBeVisible();
    await expect(canvas.getByText(/Sample client call checked/)).toBeVisible();
    await expect(canvas.getByText("Sample session is missing")).toBeVisible();
    await expect(canvas.getByText("Sample qualification unknown")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Clear observation" }));
    await expect(canvas.getByText("Sample client call unknown")).toBeVisible();
    await expect(canvas.getByText("Sample API answered")).toBeVisible();
    await expect(canvas.getByText("Sample qualification unknown")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Sample sign-in" }));
    await expect(canvas.getByText("Sample session is valid")).toBeVisible();
    await expect(canvas.getByText("Sample client call unknown")).toBeVisible();
    await expect(canvas.getByText("Sample transport unverified")).toBeVisible();
  },
};
