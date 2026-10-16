import type { SourceNamespaceCatalog } from '@eliotr/owner-api-client';

/** Select only a currently readable workspace whose published policy admits degraded captures. */
export function defaultRawImportNamespace(
  selectedNamespace: string,
  catalog: SourceNamespaceCatalog | undefined,
): string | undefined {
  if (selectedNamespace !== '') return selectedNamespace;
  return catalog?.namespaces.find(namespace =>
    namespace.minimum_quality_state === 'degraded' && namespace.read_access === 'ACTIVE')?.source_namespace_id;
}

const REASON_LABELS: Readonly<Record<'en' | 'ru', Readonly<Record<string, string>>>> = {
  en: {
    QUALITY_BELOW_POLICY_MINIMUM: 'This workspace requires a higher quality level than the extracted file provides. The quarantined capture remains bound to this workspace. For a future import, choose a workspace whose published minimum is degraded.',
    QUALIFICATION_DEGRADED: 'The extracted file is marked degraded because source-coordinate mapping is unavailable.',
    QUALIFICATION_INCOMPLETE: 'The required source-quality checks could not be completed.',
    SOURCE_IDENTITY_INCOMPLETE: 'The file is missing the source identity information required for admission.',
    PARSER_WARNINGS_PRESENT: 'The document parser reported warnings that lowered the quality assessment.',
    SOURCE_MAPPING_MISSING: 'The source-coordinate mapping required by this workspace is missing.',
    TABLE_MAPPING_INCOMPLETE: 'The required table or cell mapping is incomplete.',
    STAGING_READBACK_INCOMPLETE: 'The uploaded bytes could not be verified against the selected file.',
    STAGING_READBACK_NOT_VERIFIED: 'The uploaded bytes could not be verified against the selected file.',
    HASH_NOT_VERIFIED: 'The uploaded file hash did not pass verification.',
    ORIGIN_NOT_AUTHENTICATED: 'The file origin could not be authenticated.',
    RESIDENCY_NOT_RESOLVED: 'The file storage and residency requirements could not be verified.',
    POLICY_DENIED: 'The current workspace policy does not authorize this import.',
    LICENSE_DENIED: 'The current workspace license policy does not authorize this import.',
    OWNER_GENERATION_STALE: 'The workspace owner changed during import; refresh the workspace list.',
    CUTOVER_RECEIPT_INVALID: 'The source ownership transfer could not be verified.',
  },
  ru: {
    QUALITY_BELOW_POLICY_MINIMUM: 'Эта рабочая область требует более высокого качества, чем обеспечивает извлечённый файл. Источник в карантине привязан к этой области. Для будущего импорта выберите область с опубликованным минимумом degraded.',
    QUALIFICATION_DEGRADED: 'Файл помечен как degraded, потому что у него нет координатной карты исходного документа.',
    QUALIFICATION_INCOMPLETE: 'Не удалось завершить обязательные проверки качества источника.',
    SOURCE_IDENTITY_INCOMPLETE: 'В файле отсутствуют сведения об источнике, необходимые для приёма.',
    PARSER_WARNINGS_PRESENT: 'Парсер документа сообщил о предупреждениях, которые снизили оценку качества.',
    SOURCE_MAPPING_MISSING: 'В документе отсутствует координатная карта, требуемая политикой этой области.',
    TABLE_MAPPING_INCOMPLETE: 'Табличная карта или карта ячеек неполная.',
    STAGING_READBACK_INCOMPLETE: 'Не удалось сверить загруженные байты с выбранным файлом.',
    STAGING_READBACK_NOT_VERIFIED: 'Не удалось сверить загруженные байты с выбранным файлом.',
    HASH_NOT_VERIFIED: 'Контрольная сумма загруженного файла не прошла проверку.',
    ORIGIN_NOT_AUTHENTICATED: 'Не удалось подтвердить происхождение файла.',
    RESIDENCY_NOT_RESOLVED: 'Не удалось проверить требования к хранению и резидентности файла.',
    POLICY_DENIED: 'Текущая политика рабочей области не разрешает этот импорт.',
    LICENSE_DENIED: 'Текущая лицензионная политика рабочей области не разрешает этот импорт.',
    OWNER_GENERATION_STALE: 'Владелец рабочей области изменился во время импорта; обновите список областей.',
    CUTOVER_RECEIPT_INVALID: 'Не удалось подтвердить передачу владения источником.',
  },
};

/** Render recorded admission reasons without hiding unknown reason codes. */
export function rawImportQuarantineReason(reasonCodes: readonly string[], locale: 'en' | 'ru'): string | undefined {
  if (reasonCodes.length === 0) return undefined;
  return reasonCodes.map(code => REASON_LABELS[locale][code] ?? (locale === 'ru'
    ? `Проверка импорта указала причину: ${code.toLowerCase().replaceAll('_', ' ')}.`
    : `The admission check reported ${code.toLowerCase().replaceAll('_', ' ')}.`)).join(' ');
}
