# S42 — COMPARE по проверяемым измерениям

База a2aca127; ER-08/10/11; after #227, shared result path #233. Задача про один продукт.

## 1. Суть
Сравнение не равно двум summary рядом. Нужны фиксированные axes, версии, условия измерений и явно отсутствующие данные.

## 2. Что сделать
Approved COMPARE profile: comparison targets из разрешённых source/version refs, axes из вопроса/протокола, outcome cells с value/unit/conditions/support refs/unknowns, итоговые differences отдельно от recommendations. Сохранить через existing artifact sections и audit.

## 3. Документация / grep
[Канон §7.12, §19.3](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F 'Dimension-based comparison of documents' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Reuse existing protocol/prompt/model/output adapters; targets/axes bound in request digest и frozen inputs. Comparability проверять по recorded versions/population/time/units; unit conversion допустима только явной детерминированной операцией с исходными values, не тихой модельной заменой. Absent field = unknown/not comparable, не0/false. Источники обеих сторон включить в scope/coverage; single-source duplicate не выдавать за независимость. UI/MCP читают один persisted result и точные cell citations, без отдельного report engine.

## 5. Критерии выполнения
Fixture двух версий с изменённым условием, разных единиц и missing axis сохраняет правильные различия/unknowns. Число без точного excerpt не принимается. Sources A/B чужого scope отказаны; reorder/replay axes имеет определённую identity и не повторяет оплаченный result. End-to-end API→audit→artifact/citation тест, exact SHA; T3 реальная quality позже.
