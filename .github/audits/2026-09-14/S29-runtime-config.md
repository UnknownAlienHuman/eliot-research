# S29 — убрать дробление semantic config по environment-переменным

База `a2aca127`; F25. Только `ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0/_1`, не переписывание всего AI-контура.

## 1. Суть
Крупный semantic JSON разделён по environment bindings. Это делает конфигурацию трудно проверяемой и добавляет составные состояния deployment. Из этого не следует, что надо удалить Budget Governor, AI Search registry или native Dynamic Routes.

## 2. Что сделать
Хранить несекретную semantic configuration одной immutable revision в уже используемом хранилище, в environment оставить короткую reference и digest. Provider/gateway tokens остаются Worker secrets.

## 3. Документация
[Канон §8.2 и §8.5](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md), [runtime configuration](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/implementation/research-runtime-configuration.md).
```sh
git grep -n -F '## 8.5. Generation change gate' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0' -- apps scripts docs
```

## 4. Как сделать
Переиспользовать R2 Work immutable-object/readback pattern и существующий config parser; не создавать config service или новое authority-хранилище. Перед запуском проверить version/hash/shape. Кэш допустим только по immutable identity, не для текущих grants. Сделать короткий явный migration path: старый split format распознать на переходе, затем убрать его через контролируемое переключение; смешанные источники отклонять. Network чтение не помещать внутрь D1 transaction.

## 5. Критерии выполнения
- Один versioned config корректно читается и привязан к run provenance.
- Corrupt/missing/wrong-version config отказан до модели с понятной причиной.
- Переход/restart/rollback не меняют silently уже frozen model/prompt/schema.
- Secret values не лежат в JSON/R2/Git/browser; нет второго config framework.
- Полезные model/generation/budget checks сохранены; tests/SHA и migration instructions приложены.
