import type { ResearchRunStatusView } from '@eliotr/owner-api-client';
import { researchEngineLabel } from '@eliotr/ui';

/** Persisted execution and draft availability remain meaningful without an engine observation. */
export function researchHistoryLabel(locale: 'en' | 'ru', status: ResearchRunStatusView): string {
  if (status.execution_state === 'CANCELLED') return locale === 'ru' ? 'Отменено' : 'Cancelled';
  if (status.execution_state === 'ENGINE_COMPLETED') {
    return status.answer.availability === 'draft'
      ? locale === 'ru' ? 'Черновик отчёта готов' : 'Draft report available'
      : locale === 'ru' ? 'Выполнение завершено; отчёт недоступен' : 'Engine finished; report unavailable';
  }
  if (status.engine_status === 'complete') return locale === 'ru'
    ? 'Движок завершил работу; сохранённый статус ещё не подтверждён'
    : 'Engine finished; saved status pending';
  return researchEngineLabel(locale, status.engine_status);
}
