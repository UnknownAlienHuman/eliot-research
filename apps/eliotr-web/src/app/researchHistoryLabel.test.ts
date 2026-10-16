import type { ResearchRunStatusView } from '@eliotr/owner-api-client';
import { describe, expect, it } from 'vitest';
import { researchHistoryLabel } from './researchHistoryLabel';

const active: ResearchRunStatusView = {
  workflow_instance_id: 'workflow-history', investigation_ref: { id: 'investigation-history', revision: 1 },
  deployment_generation: 'history-generation', execution_state: 'ACTIVE', engine_status: 'unknown',
  next_stage_index: 3, answer: { availability: 'unavailable' },
};
const cases: readonly { readonly name: string; readonly status: ResearchRunStatusView; readonly en: string; readonly ru: string }[] = [
  { name: 'completed draft without an engine observation', status: { ...active, execution_state: 'ENGINE_COMPLETED', next_stage_index: 18,
    answer: { availability: 'draft', artifact_ref: { id: 'report-history', revision: 1 } } },
    en: 'Draft report available', ru: 'Черновик отчёта готов' },
  { name: 'completed execution with unresolved report availability', status: { ...active, execution_state: 'ENGINE_COMPLETED', next_stage_index: 18 },
    en: 'Engine finished; report unavailable', ru: 'Выполнение завершено; отчёт недоступен' },
  { name: 'cancellation without an engine observation', status: { ...active, execution_state: 'CANCELLED',
    cancellation_receipt_ref: 'workflow-cancelled:workflow-history' }, en: 'Cancelled', ru: 'Отменено' },
  { name: 'reported failure', status: { ...active, engine_status: 'errored', failure: { code: 'WORKFLOW_OUTPUT_UNAVAILABLE' } },
    en: 'Failed', ru: 'Ошибка' },
  { name: 'stopped engine', status: { ...active, engine_status: 'terminated' }, en: 'Stopped', ru: 'Остановлено' },
  { name: 'engine completion without persisted completion', status: { ...active, engine_status: 'complete' },
    en: 'Engine finished; saved status pending', ru: 'Движок завершил работу; сохранённый статус ещё не подтверждён' },
  { name: 'legacy execution without an engine observation', status: active, en: 'Status unknown', ru: 'Состояние неизвестно' },
  { name: 'reported running engine', status: { ...active, engine_status: 'running' }, en: 'Running', ru: 'Выполняется' },
];

describe.each(['en', 'ru'] as const)('Recent research status in %s', locale => {
  it.each(cases)('$name', entry => {
    expect(researchHistoryLabel(locale, entry.status)).toBe(entry[locale]);
  });
});
