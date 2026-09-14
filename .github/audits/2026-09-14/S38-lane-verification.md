# S38 — confirmatory/exploratory не превращаются друг в друга незаметно

База a2aca127; ER-08/10/03, после #227. Existing W1 и pure lane rules переиспользовать; это подключение полного acceptance path.

## 1. Суть
Техническое завершение legacy confirmatory stages не доказывает preregistration, независимое подтверждение или выполненный verification certificate.

## 2. Что сделать
В actual run admission/branch completion провести LaneRegistration и named-verifier acceptance. Зафиксировать protocol/hypothesis/evaluator/exclusions/primary metric до outcome exposure; mixed lane — явный split, не общий неразмеченный EvidencePack.

## 3. Документация / grep
[Канон §7.1, §7.3–7.4](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/architecture/ELIOT_RESEARCH.md).
```sh
git grep -n -F '## 7.3. Confirmatory and exploratory lanes' -- docs/architecture/ELIOT_RESEARCH.md
git grep -n -F 'only the named verifier may issue the certificate' -- docs/architecture/ELIOT_RESEARCH.md
```

## 4. Как сделать
Existing research/investigation service и W1 commands проверяют registration digests/exposure order в той же guarded mutation. Verifier берётся из AllowedReferenceManifest/approved protocol, не body worker output. Exact-source certificate использует существующий Evidence resolver; measurement/build/proof certificate принимает только соответствующий квалифицированный external verifier с immutable inputs+output. Неподключённый verifier оставляет obligation BLOCKED и typed next probe, не вызывает небезопасное исполнение кода в Worker. Protocol-specific adapters добавлять за существующими ports, не новый universal execution framework. После outcome разрешать только declared deviation и последующий exploratory статус либо новую preregistration до новых независимых данных. Grade supersession versioned, старые evidence labels не переписать.

## 5. Критерии выполнения
Изменение metric/exclusion/evaluator после exposure не получает confirmatory acceptance; положительный held-out/independent case проходит named verifier. Self-issued/model-agreement certificate отвергнут. Compliant negative result сохранён, mixed-lane evidence не пересекает blinded boundary. Legacy replay не усиливает disposition. Actual HTTP/W1/Workflow tests, every declared supported protocol has a real verifier path or honest blocked obligation; exact SHA и no false E3.
