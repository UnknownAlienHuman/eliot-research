import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import type { AdmittedDocument, NavigationSection } from '@eliotr/owner-api-client';
import { DocumentReader, type DocumentReaderState } from '../../../features/sources/document/DocumentReader';
import { parseSafeMarkdown } from '../../../features/sources/document/SafeMarkdown';

const meta = {
  title: 'Product/Sources/Document',
  component: DocumentReader,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof DocumentReader>;
export default meta;
type Story = StoryObj<typeof meta>;

const revisionRef = 'rev-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const generation = 'deployment-g1';
const digest = '3925c7459df98819eb36d410268b17857f6ccbc9ea3e0b7df415db24ad559ec0';
const fixtureText = "Every report keeps the exact source scope it was written against. A later scope change does not rewrite what an earlier report already concluded.";
const fixtureBytes = new TextEncoder().encode(fixtureText);

const document: AdmittedDocument = {
  sourceRevisionRef: revisionRef,
  deploymentGeneration: generation,
  contentSha256: digest,
  sizeBytes: fixtureBytes.byteLength,
  bytes: fixtureBytes,
  text: fixtureText,
};


function documentFor(text: string, contentSha256: string): AdmittedDocument {
  const bytes = new TextEncoder().encode(text);
  return { ...document, text, bytes, sizeBytes: bytes.byteLength, contentSha256 };
}
const russianDocument = documentFor("# Источники и доказательства\n\nКаждый отчёт сохраняет выбранные версии источников. Новая версия не изменяет уже сделанные выводы. Проверка актуальности и подтверждение содержания — отдельные действия.\n\n## Сохранённая версия\n\nСравнивайте точность цитаты и обоснованность вывода отдельно. Если проверка недоступна, состояние остаётся неизвестным.\n\n> Сохранение контекста помогает понять, на каких материалах основан вывод.", "658b95501a1592d7beaacad00f8c92968a7950ee4b67531e025511d4810d0a00");

const sections: NavigationSection[] = [
  { section_ref: 'sec-1', source_revision_ref: revisionRef, label: 'Findings', metadata: {},
    normalized_start_byte: 0, normalized_end_byte: 64 },
  { section_ref: 'sec-2', source_revision_ref: revisionRef, label: 'Method', metadata: {},
    normalized_start_byte: 65, normalized_end_byte: 128 },
  { section_ref: 'sec-3', source_revision_ref: revisionRef, label: 'Sources', metadata: {} },
];

const base = (state: DocumentReaderState) => ({
  locale: 'en' as const,
  state,
  sourceRevisionRef: revisionRef,
  expectedDeploymentGeneration: generation,
  ...(state === 'useful' ? { document, sections } : {}),
});

export const Useful: Story = { args: base('useful') };
export const Loading: Story = { args: base('loading') };
export const Empty: Story = { args: base('empty') };
export const Degraded: Story = { args: base('degraded') };
export const Error: Story = { args: base('error') };

export const LongRussian: Story = {
  args: { ...base('useful'), locale: 'ru', document: russianDocument },
  render: (args) => (
    <div className="eliot-token-story" lang="ru">
      <DocumentReader {...args} />
    </div>
  ),
};

export const RepresentationMismatch: Story = {
  // A response whose revision does not match the requested one must refuse its text.
  args: {
    ...base('useful'),
    document: { ...document, sourceRevisionRef: 'rev-other-revision' },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/refused/u)).toBeVisible();
    await expect(canvas.queryByText(/Every report keeps/u)).not.toBeInTheDocument();
  },
};

export const InteractionJourney: Story = {
  args: base('useful'),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The exact admitted text is shown, and the whole-read notice explains why.
    await expect(canvas.getByText(/Every report keeps/u)).toBeVisible();
    await userEvent.click(canvas.getByText('Version details'));
    await expect(canvas.getByText(/whole document was read/u)).toBeVisible();

    // Coordinates are shown verbatim from the server sections, never computed.
    await expect(canvas.getByText(/Bytes: 0 - 64/u)).toBeVisible();
    await expect(canvas.getByText('Method')).toBeVisible();

    // Opening a section moves the pressed state, and Back returns to the list.
    const findings = canvas.getByRole('button', { name: 'Findings' });
    await userEvent.click(findings);
    await expect(findings).toHaveAttribute('aria-pressed', 'true');
    await expect(canvas.getByRole('button', { name: /Back to sections/u })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: /Back to sections/u }));
    await expect(findings).toHaveAttribute('aria-pressed', 'false');
  },
};

export const MarkdownSafety: Story = {
  args: { ...base('useful'), document: documentFor('# Readable heading\n\n**Strong finding** and [safe reference](https://example.com/source).\n\n![Remote image caption](https://example.com/image.png) [unsafe](javascript:alert)\n\n<script>untrusted text</script>\n\n5. Original ordered item\n6. Another item\n\n```\n<unsafe-code>\n```', "400979500f83ecf865e92a420f1d8c7b9c78e7ffa86f2f694e52604fdbedcbbd") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Readable heading' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'safe reference' })).toHaveAttribute('href', 'https://example.com/source');
    await expect(canvas.queryByRole('link', { name: 'unsafe' })).not.toBeInTheDocument();
    await expect(canvas.getByText('<script>untrusted text</script>')).toBeVisible();
    await expect(canvasElement.querySelector('script')).toBeNull();
    await expect(canvasElement.querySelector('img')).toBeNull();
    await expect(canvasElement.querySelector('ol')).toHaveAttribute('start', '5');
    await expect(canvas.getByText('<unsafe-code>')).toBeVisible();
  },
};

export const ExplicitBounds: Story = {
  args: base('empty'),
  play: async () => {
    await expect(parseSafeMarkdown('x'.repeat(256 * 1024 + 1))).toBeUndefined();
    await expect(parseSafeMarkdown('- item\n'.repeat(4097))).toBeUndefined();
    const repeatedBrackets = '['.repeat(100000) + ']';
    await expect(parseSafeMarkdown(repeatedBrackets)).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: repeatedBrackets }] }]);
  },
};

export const LongRussianDark: Story = {
  args: { ...base("useful"), locale: "ru", document: russianDocument },
  render: args => <div data-theme="dark" lang="ru"><DocumentReader {...args} /></div>,
};
