# S99 — Research по всему разрешённому проекту, а не только первым64 источникам

База a2aca127; F08/ER30/24/31. Повторная проверка уточнила аудит: generic scope-service уже поддерживает до50000 members, selected IDs до1000 и canonical envelope до2MiB. Ограничение64 находится в owner ORIENT/Research/historical adapters, а не во всей scope architecture. Не строить второй storage/index.

## 1. Суть
Research run вызывает owner orientation с меньшим scope profile; исторический reader также использует default64 и head-witness LIMIT65. Preview/top-k ограничения не должны становиться невидимым потолком всего исследуемого проекта.

## 2. Что сделать
Разделить navigation preview budget, количество retrieval results и полный frozen authorized member set. Провести существующий larger scope loader/profile через запуск Research, Workflow retrieval/freeze/coverage, report/historical reads; UI может показывать страницу, но запрос относится ко всему явно выбранному проекту.

## 3. Документация / grep
[Scope service](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/packages/cloudflare-navigation/src/scope-service.ts), [канон SourcePortfolio/denominator](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'DEFAULT_MAX_SNAPSHOT_MEMBERS' -- packages/cloudflare-navigation/src/scope-service.ts
git grep -n -F '## 7.5. SourcePortfolio and coverage denominator' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Использовать existing scope service options/profile binding и bounded member/authority queries; не просто заменить64 на большое число везде. ORIENT preview не является единственным источником full scope: freeze получает полный разрешённый набор metadata, а не все source bodies. Проверка каждой атомарной области/политики сохраняется, subset не подменяет исходную expression. Historical reauthorization использует фактический preserved scope profile и bounded paged witness вместо фиксированного LIMIT65; исходные member refs/ownership не меняются. Для данных, превышающих уже установленный canonical byte/member envelope, вернуть явный limit/result с предлагаемым разделением scope, не усекать silently и не выдумывать новый manifest protocol. Existing exhaustive sharding S51 и source portfolio S36 переиспользуются; no top-k absence и no mandatory model call на каждый документ. Saved 64-source artifacts читаются совместимо.

## 5. Критерии выполнения
- Проекты с65 и299 реальными admitted sources запускаются; полный membership зафиксирован, UI page/top16 retrieval не сокращают denominator молча.
- Ответ/контрпример только за первым64-м источником находится разрешённым lane/exhaustive сценарием; trace различает retrieved subset и requested full scope, не обещает semantic completeness.
- Report/history после JWT refresh/source update читает исходный exact member set; чужой один member, purge/revoke и mismatched profile отказаны.
- Нет загрузки всех source bytes в память, второй search/storage или произвольного повышения всех limits. Max/max+1 реального envelope проверяется, legacy scope/IDs сохраняются.
- Actual local ingest→project→run→report→history tests и последующий representative quality run #285; exact SHA/config/input sizes/результаты.
