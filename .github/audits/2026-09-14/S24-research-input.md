# S24 — принимать нормальное многострочное исследовательское задание

База `a2aca127`; F08. Только input contract, не расширение всего корпуса/контекста одним PR.

## 1. Суть
`checkQuery` ограничивает вопрос 1024 UTF-8 байтами и запрещает весь диапазон control chars, включая перенос строки. Обычное структурированное задание из нескольких абзацев отклоняется.

## 2. Что сделать
Разрешить LF/CRLF и обычное форматирование вопроса, убрать произвольный отдельный 1024-byte потолок в пользу согласованных существующих HTTP/model-input budgets. Не обрезать текст молча.

## 3. Документация
[Канон §7.2, §7.12 и §1.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 7.2. InquiryProtocolProfile' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'checkQuery' -- apps/eliotr-core/src/research-session.ts
```

## 4. Как сделать
Согласовать server parser, PWA input и model preparation; UTF-8 byte counting не заменять JS string.length. Документировать обработку CRLF/tab/нулевого символа/одиночных суррогатов и сохранять исходный смысл вопроса. Реальное превышение capacity отклонять с понятной причиной до model call. Не ставить новый магический лимит символов и не повышать Evidence Grade из-за длины prompt.

## 5. Критерии выполнения
- RU/EN многострочный вопрос с цитатами/списком принят и доходит до модели без потери текста.
- LF/CRLF имеют явно определённую idempotency-семантику.
- Malformed Unicode, NUL и превышение реального envelope корректно отказаны до платных эффектов.
- PWA/server согласованы, нет silent truncation; max/max+1 tests используют опубликованный envelope.
- Сохранены existing short-query tests, exact SHA и результаты.
