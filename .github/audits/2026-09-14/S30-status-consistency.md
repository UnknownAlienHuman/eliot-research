# S30 — один непротиворечивый текущий статус, без нового реестра

База `a2aca127`; F22. Только owner import → retrieval → Research DRAFT и соответствующие entry documents, не перепись всей документации.

## 1. Суть
START-HERE выводит из LIVE_QUALIFIED=0 отсутствие любых реальных платформенных проверок, хотя live-журналы описывают частные успешные операции. Это разные уровни подтверждения. Append-only журнал с несколькими словами current также быстро устаревает.

## 2. Что сделать
Различить code implemented, конкретный retained live case, deployed version и полную qualification контура. Использовать существующий implementation-status.json и ссылки на evidence; не создавать status-v2 или ещё один master-report.

## 3. Документация
[START-HERE §7](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/START-HERE.md), [Production readiness §0](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/production-readiness-plan.md).
```sh
git grep -n -F '## 7. The four states, and what' -- docs/START-HERE.md
git grep -n -F '### Mechanical release rule' -- docs/implementation/production-readiness-plan.md
```

## 4. Как сделать
Проверить названные owner-path entries против callers/tests и retained receipts. Убрать из entry docs неверное следствие «0 qualified → ни одного real round trip». Исторические audits и live records не переписывать как current truth; текущий deployment сообщать с наблюдённым временем/источником, не выводить из последнего main SHA. Не повышать state по наличию файла или по одному примеру. Для неисполненного gate оставить явный пробел.

## 5. Критерии выполнения
- Entry docs, registry и capabilities не делают несовместимых утверждений об owner-path.
- Partial live case не назван полной квалификацией; отсутствие полной qualification не отрицает сам факт частного case.
- Main-only fixes явно отличаются от deployed/live-accepted fixes.
- Проверка документационных индексов проходит для затронутых документов.
- Нет нового состояния CompletionDisposition, status registry или постоянного копирования счётчиков в prose; exact SHA/evidence links сохранены.
