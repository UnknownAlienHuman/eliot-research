import type { ResearchRunLaunchView } from '@eliotr/owner-api-client';
import { isWorkspaceRequestError, type BoundWorkspaceApis } from '../app/runtime';
import type { PrivacyController, SessionContext } from '../app/privacy';
import { ProtectedReadClosedError, runProtectedRead } from './client';

/** Approved public codes only. Neither error.message nor any request/response payload is retained. */
const reasons = {
  RESEARCH_AUTHORITY_STALE: { en: 'Project, source or model access changed during submission.', ru: 'Во время отправки изменился доступ к проекту, источникам или модели.' },
  RESEARCH_AGENT_NOT_CONFIGURED: { en: 'Model availability could not be confirmed. Review the model settings.', ru: 'Не удалось подтвердить доступность модели. Проверьте её настройки.' },
  RESEARCH_SETTLEMENT_UNCERTAIN: { en: 'The service could not verify its saved launch status.', ru: 'Сервис не смог проверить сохранённый статус запуска.' },
  RESEARCH_CONFLICT: { en: 'The service reported a conflict with the current research state.', ru: 'Сервис сообщил о конфликте с текущим состоянием исследования.' },
  RESEARCH_INPUT_INVALID: { en: 'The service reported a problem with the question or its source selection.', ru: 'Сервис сообщил о проблеме с вопросом или выбранными источниками.' },
  RESEARCH_INPUT_LIMIT: { en: 'The question or source selection exceeds a service limit.', ru: 'Вопрос или выбор источников превышает ограничение сервиса.' },
  RESEARCH_INPUT_SCHEMA_MISMATCH: { en: 'The service could not accept the current request format.', ru: 'Сервис не смог принять текущий формат запроса.' },
  RESEARCH_PROFILE_UNSUPPORTED: { en: 'The requested research mode is not currently supported.', ru: 'Запрошенный режим исследования сейчас не поддерживается.' },
  RESEARCH_OWNER_REQUIRED: { en: 'The service could not confirm the required owner access.', ru: 'Сервис не смог подтвердить необходимый доступ владельца.' },
  RESEARCH_RUN_DEPLOYMENT_CHANGED: { en: 'The service changed while the question was being submitted.', ru: 'Во время отправки вопроса версия сервиса изменилась.' },
  RESEARCH_RUN_RESPONSE_INVALID: { en: 'The service returned a launch response that could not be verified.', ru: 'Не удалось проверить ответ сервиса на запрос запуска.' },
} as const;

export interface ResearchLaunchFailure { readonly code?: keyof typeof reasons }
export function safeResearchLaunchFailure(error: unknown): ResearchLaunchFailure {
  return Object.freeze(isWorkspaceRequestError(error) && Object.hasOwn(reasons, error.code)
    ? { code: error.code as keyof typeof reasons } : {});
}
export function researchLaunchFailureMessage(failure: ResearchLaunchFailure, locale: 'en' | 'ru'): string {
  return failure.code !== undefined && Object.hasOwn(reasons, failure.code) ? reasons[failure.code][locale]
    : locale === 'ru' ? 'Не удалось подтвердить ответ на запрос запуска.' : 'The launch response could not be confirmed.';
}

/** One explicit same-key submission. Every unconfirmed response remains UNKNOWN, including typed
 * refusals: a public error code is diagnostic information, never proof that no run was allocated.
 */
export async function submitResearchLaunchOnce(input: {
  readonly runs: Pick<BoundWorkspaceApis['research']['runs'], 'startResearchRun'>;
  readonly privacy: PrivacyController; readonly context: SessionContext;
  readonly body: string; readonly key: string; readonly signal: AbortSignal; readonly isCurrent: () => boolean;
}): Promise<{ readonly phase: 'admitted'; readonly launch: ResearchRunLaunchView } |
  { readonly phase: 'unknown'; readonly failure: ResearchLaunchFailure }> {
  const assertCurrent = () => {
    if (input.signal.aborted || !input.privacy.isCurrent(input.context) || !input.isCurrent()) throw new ProtectedReadClosedError();
  };
  assertCurrent();
  try {
    const launch = await runProtectedRead(input.privacy, input.context, input.signal, signal =>
      input.runs.startResearchRun(input.body, input.key, input.context.deploymentGeneration, signal));
    assertCurrent();
    return Object.freeze({ phase: 'admitted', launch });
  } catch (error) {
    assertCurrent();
    return Object.freeze({ phase: 'unknown', failure: safeResearchLaunchFailure(error) });
  }
}
