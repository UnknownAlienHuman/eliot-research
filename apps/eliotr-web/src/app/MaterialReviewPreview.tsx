/** Publish this journey's declared terminal readiness on the Shell that renders the observed presentation. */
function markVisualReady(shell: HTMLElement | null | undefined): void {
  if (!shell) throw new Error('Terminal visual readiness requires the rendered workspace Shell');
  shell.setAttribute('data-play-ready', 'ready');
}
import type { playResearchJourney } from './ResearchPreview';

/** Preferences change presentation only; route navigation keeps their state and restores route focus. */
export async function playMaterialPreferences({ canvas, userEvent }: Parameters<typeof playResearchJourney>[0] & {
  readonly userEvent: { keyboard(input: string): Promise<void> };
}) {
  const project = await canvas.findByRole('combobox', { name: 'Project', exact: true });
  const shell = project.closest<HTMLElement>('.er-shell');
  const preferences = shell?.querySelector<HTMLDetailsElement>('.er-shell-preferences');
  const summary = preferences?.querySelector<HTMLElement>('summary');
  if (!shell || !preferences || !summary || preferences.open) throw new Error('Preferences must start collapsed beside the workspace brand');
  await userEvent.click(summary);
  const appearance = await canvas.findByRole('combobox', { name: 'Appearance', exact: true });
  const bounds = appearance.getBoundingClientRect();
  const sampleY = bounds.top + Math.min(8, bounds.height / 4);
  for (const sampleX of [bounds.left + bounds.width / 2, bounds.right - Math.min(8, bounds.width / 4)]) {
    const hit = document.elementFromPoint(sampleX, sampleY);
    if (!hit || !preferences.contains(hit)) throw new Error('Preferences were visually occluded by workspace actions');
  }
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: 'Language', exact: true }), 'ru');
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: 'Оформление', exact: true }), 'dark');
  const navigationLabels = [...shell.querySelectorAll<HTMLElement>('.er-shell-destination-label')];
  if (navigationLabels.length !== 5) throw new Error('Workspace navigation labels are incomplete');
  for (const label of navigationLabels) {
    const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight);
    const labelBounds = label.getBoundingClientRect();
    const linkBounds = label.parentElement?.getBoundingClientRect();
    if (!Number.isFinite(lineHeight) || !linkBounds || label.scrollWidth > label.clientWidth + 1 ||
      label.scrollHeight > lineHeight + 1 || labelBounds.left < linkBounds.left - 1 || labelBounds.right > linkBounds.right + 1)
      throw new Error(`Workspace navigation label wrapped or overflowed: ${label.textContent ?? ''}`);
  }
  await userEvent.keyboard('{Escape}');
  if (preferences.open || document.activeElement !== summary) throw new Error('Escape must close preferences and return focus to their summary');
  if (shell.lang !== 'ru' || shell.dataset.theme !== 'dark') throw new Error('Language or appearance did not change');
  await userEvent.click(summary);
  await userEvent.click(canvas.getByRole('link', { name: 'Студия', exact: true }));
  const heading = await canvas.findByRole('heading', { name: 'Студия', exact: true });
  if (preferences.open || document.activeElement !== heading) throw new Error('Navigation must close preferences and focus the new destination');
  if (shell.lang !== 'ru' || shell.dataset.theme !== 'dark') throw new Error('Navigation discarded presentation preferences');
  // Terminal visual readiness: preferences applied, dark theme retained, Studio focused. This is the terminal
  // assertion, so the readiness marker is published after it and only if it holds.
  markVisualReady(shell);
}

/** Actual workspace/client/query path with synthetic HTTP; checks explicit scope and report focus. */
export async function playMaterialReading({ canvas, userEvent }: Parameters<typeof playResearchJourney>[0]) {
  await userEvent.selectOptions(await canvas.findByRole('combobox', { name: 'Project', exact: true }), 'project-fixture');
  await userEvent.click(await canvas.findByText('Sources for your next question'));
  await userEvent.click(await canvas.findByRole('checkbox', { name: 'Research brief · preserving evidence' }));
  await userEvent.click(canvas.getByRole('link', { name: 'Research', exact: true }));
  await userEvent.type(await canvas.findByRole('textbox', { name: 'Research question' }), 'How can a question retain its original evidence?');
  await userEvent.click(canvas.getByRole('button', { name: 'Ask', exact: true }));
  await canvas.findByText('The run finished. Review the draft answer.');
  await userEvent.click(canvas.getAllByRole('button', { name: 'Open saved report' })[0] as HTMLElement);
  const close = await canvas.findByRole('button', { name: 'Close report' });
  const reportTitle = await canvas.findByRole('heading', { name: 'Saved report', exact: true });
  if (document.activeElement !== reportTitle) throw new Error('Opening a report lost keyboard focus');
  await canvas.findByText('4 declared');
  const exportButton = canvas.getByRole('button', { name: 'Export report' });
  if (!(exportButton instanceof HTMLButtonElement) || !exportButton.disabled) throw new Error('Unread sections permitted export');
  await userEvent.click(canvas.getByRole('button', { name: 'Read · Section 1' }));
  await canvas.findByText('Evidence that remains in context');
  await userEvent.click(await canvas.findByRole('button', { name: 'Open cited excerpt 1' }));
  await canvas.findByText('The saved question keeps its original source scope.');
  if (!exportButton.disabled || canvas.queryByText('Supported')) throw new Error('One excerpt promoted completeness or semantic support');
  await userEvent.click(close);
  const recent = await canvas.findByRole('heading', { name: 'Recent research', exact: true });
  if (document.activeElement !== recent) throw new Error('Report close did not return to recent research');
  await userEvent.click(canvas.getByRole('link', { name: 'Studio', exact: true }));
  await userEvent.click(await canvas.findByRole('button', { name: 'Open saved report', exact: true }));
  await userEvent.click(await canvas.findByRole('button', { name: 'Close report', exact: true }));
  const reports = await canvas.findByRole('heading', { name: 'Saved reports', exact: true });
  if (document.activeElement !== reports) throw new Error('Studio report close did not return to its library');
  // Terminal visual readiness: the report was opened and closed, with focus returning to the library.
  markVisualReady(document.querySelector<HTMLElement>('.er-shell'));
}
