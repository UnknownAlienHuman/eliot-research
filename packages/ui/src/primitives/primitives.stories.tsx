import { StrictMode, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Button, Dialog, Field, IconButton, OperationAnnouncement, Status } from "./primitives";

const meta = {
  title: "Primitives/Native",
  component: Button,
  decorators: [(Story) => <div className="eliot-token-story"><Story /></div>],
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { children: "Start research", icon: "research" } };
export const Tonal: Story = { args: { variant: "tonal", children: "Review source" } };
export const Text: Story = { args: { variant: "text", children: "Back to report" } };
export const Loading: Story = { args: { children: "Start research", loading: true } };
export const Disabled: Story = { args: { children: "Start research", disabled: true } };
export const LabelledIcon: Story = { render: () => <IconButton label="Review source details" icon="evidence" /> };
export const FieldHint: Story = {
  render: () => <Field label="Research question" hint="Use your selected sources" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole("textbox", { name: "Research question" });
    await userEvent.type(field, "What changed?");
    await expect(field).toHaveValue("What changed?");
    await expect(field).toHaveAccessibleDescription("Use your selected sources");
  },
};
export const FieldError: Story = {
  render: () => <Field label="Research question" error="Enter a question" required />,
  play: async ({ canvasElement }) => {
    const field = within(canvasElement).getByRole("textbox", { name: "Research question" });
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAccessibleDescription("Enter a question");
  },
};
export const NeutralStatus: Story = { render: () => <Status>Source readiness unknown</Status> };
export const ErrorStatus: Story = { render: () => <Status tone="error">Source could not be read</Status> };
function AnnouncementSample() {
  const [message, setMessage] = useState('');
  return <><Status>Saved source</Status><Status tone="error">A static check failed</Status>
    <OperationAnnouncement>{message}</OperationAnnouncement>
    <Button onClick={() => setMessage('Saved versions loaded.')}>Announce in English</Button>
    <Button onClick={() => setMessage('Сохранённые версии прочитаны.')}>Сообщить по-русски</Button>
    <Button onClick={() => setMessage('')}>Clear announcement</Button></>;
}
export const OperationAnnouncementChannel: Story = {
  render: () => <AnnouncementSample />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement), region = canvas.getByRole('status');
    const count = () => canvasElement.querySelectorAll('[role="status"], [aria-live], [role="alert"]').length;
    await expect(region).toHaveTextContent('');
    await expect(region).toHaveAttribute('aria-live', 'polite');
    await expect(region).toHaveAttribute('aria-atomic', 'true');
    await expect(count()).toBe(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Announce in English' }));
    await expect(region).toHaveTextContent('Saved versions loaded.');
    await userEvent.click(canvas.getByRole('button', { name: 'Сообщить по-русски' }));
    await expect(region).toHaveTextContent('Сохранённые версии прочитаны.');
    await userEvent.click(canvas.getByRole('button', { name: 'Clear announcement' }));
    await expect(region).toHaveTextContent('');
    await expect(canvas.getByRole('status')).toBe(region);
    await expect(count()).toBe(1);
  },
};
export const LongRussian: Story = {
  render: () => <div lang="ru"><Field label="Название источника для следующего исследования" hint="Сохранённая область выполненного исследования остаётся неизменной" defaultValue="Исследование надёжных систем знаний и точных доказательств" /><Button variant="tonal">Проверить доступную версию источника</Button></div>,
};

function ModalSample() {
  const [open, setOpen] = useState(false);
  return <><Button onClick={() => setOpen(true)}>Review source</Button><Dialog open={open} title="Exact source context" onClose={() => setOpen(false)}><p>Return to the question after reading this source.</p><Button variant="tonal" onClick={() => setOpen(false)}>Back to research</Button></Dialog></>;
}
export const ModalInteraction: Story = {
  render: () => <StrictMode><ModalSample /></StrictMode>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const opener = canvas.getByRole("button", { name: "Review source" });
    await userEvent.click(opener);
    await expect(canvas.getByRole("dialog", { name: "Exact source context" })).toBeVisible();
    // Storybook userEvent uses synthetic keyboard input; actual Escape is checked
    // with the pinned native-browser CSP qualification. Exercise cancel here.
    canvas.getByRole("dialog").dispatchEvent(new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(canvas.queryByRole("dialog")).not.toBeInTheDocument());
    await expect(opener).toHaveFocus();
    await userEvent.click(opener);
    await userEvent.click(canvas.getByRole("button", { name: "Back to research" }));
    await waitFor(() => expect(canvas.queryByRole("dialog")).not.toBeInTheDocument());
    await expect(opener).toHaveFocus();
  },
};
