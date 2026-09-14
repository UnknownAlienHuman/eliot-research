# S27 — удалить искусственный потолок веток, не добавлять исключения

База `a2aca127`. Основание изменения политики — прямое указание владельца продолжать серию PR без искусственных ограничений. Создание остальных заданий не зависит от закрытия этого PR.

## 1. Суть
Лимит пяти counted branches и whitelist девяти имён с датой 20260905 блокируют нормальное разбиение работ на маленькие PR. Новые именные исключения только увеличат служебную сложность.

## 2. Что сделать
Удалить численный потолок и датированный механизм reserved_open_pr_heads. Не удалять неслитые ветки автоматически по количеству или возрасту. Оставить безопасную уборку только подтверждённо интегрированных веток и явные операторские действия.

## 3. Документация
[Действующие правила](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/branch-discipline.md), [AGENTS](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/AGENTS.md). Здесь требуется обновление старой процедурной политики по решению владельца, не изменение security-канона продукта.
```sh
git grep -n -e max_non_default_branches -e reserved_open_pr_heads -e QUARANTINE_CEILING_EVICTION -- scripts infra/github
git grep -n -F '## Swarm edit protocol' -- AGENTS.md
```

## 4. Как сделать
Упростить `branch-hygiene-lib.mjs`, его callers/tests и config: убрать cap, eviction и датированные исключения, а не отключать весь CI. Cleanup перед удалением проверяет merged/integrated статус, отсутствие открытого PR и неизменившийся head SHA. Closed-unmerged PR и неслитая ветка не считаются мусором. Устаревшие инструкции в START-HERE/branch-discipline/AGENTS привести к одному правилу без второго registry.

## 5. Критерии выполнения
- Любое количество открытых PR не даёт branch-ceiling failure.
- Нет списков именных исключений и новых числовых квот.
- Старые/неслитые/open-PR ветки сохраняются; default/protected branch не удаляется.
- Race: появившийся PR или изменённый head отменяет cleanup.
- Unit/negative hygiene tests проходят; data/security/runtime gates не ослаблены. Сам этот PR не удаляет пользовательские ветки.
