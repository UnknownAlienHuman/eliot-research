# Baseline — NotebookLM (Gemini Notebook) and the old Eliot, 2026-10-16

## Private retained export: access and completeness (verified 2026-11-03)

The complete **retained answer text** for C1–C4 and O1–O8 is available in the owner's private local archive:
`%USERPROFILE%\Documents\EliotResearchEvidence\notebooklm-20261026\answers.md`.
It was copied, with all six sidecars, from ignored `eval/out/notebooklm-20261026/` in the original retained checkout.
Original files remain untouched. All seven archive files match their originals byte for byte. Archive contents were
not uploaded or published; this document publishes access, hash and completeness metadata only. Sharing was unchanged
and no new NotebookLM generation was performed. The archive is outside Git and managed task worktrees.

From a second checkout on the same machine under the owner account, an **independent local check** verified valid UTF-8,
12 distinct nonempty sections with no missing/duplicate C1–C4/O1–O8 IDs, frozen-question matches and exact answer-body
matches against `runs.json` after a common 21-character UI prefix was removed. The content-free check below reproduces
those assertions and verifies the two frozen input-file hashes. All seven original/archive files were separately
compared byte for byte locally; the command below does not recheck every sidecar or inspect citation targets.

The actual K2 parser also loaded twelve entries from this file. That parser alone proves neither uniqueness nor
capture equality: its Map overwrites duplicate IDs, it never compares `runs.json`, and missing/unreadable exports or
missing IDs silently fall back to tracked summaries/placeholders. The independent check fails instead of falling back.
These checks establish retained answer-text coverage, not semantic acceptance or fresh notebook state.

| Private archive file | Bytes | SHA-256 |
|---|---:|---|
| `answers.md` | 73907 | `4703f0023b35509a0e46375de2e09c9cf7e1f75c0be0e986b8f6aca9739435f9` |
| `runs.json` | 868373 | `20c06d901ed1da4992455f23a9ad7d2b78c116e0e446258eb016956d78174e17` |
| `citation-adam.txt` | 1569 | `fd6bdf93d7ffcbf3993688b851fe6ac7131d61277ec16ad8d8a99eb9e2fb52b5` |
| `citation-cot.txt` | 1179 | `c0dc9073b38662b7e29e70e18ccb831f2bedd35ca13cce84b81282b78b0aa993` |
| `citation-transformer.txt` | 1 | withheld: a one-byte digest would disclose its content |
| `notebooklm-citation.png` | 280646 | `f84c637bb26ecf928ccdec2acc9779c5913428c1580fdb56be17156a786266cb` |
| `notebooklm-results.png` | 280730 | `cf959225093763d4a3a3c4537febc2dfaa0098bc377075bc81919dd775f7476a` |

From the root directory of another authorized local checkout, select and independently verify the existing archive without printing its
contents or copying private answers into Git. Any failure returns a fixed message without answer text:

```powershell
$env:ELIOT_K2_NOTEBOOKLM_ANSWERS = Join-Path $env:USERPROFILE 'Documents\EliotResearchEvidence\notebooklm-20261026\answers.md'
@'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const need = condition => { if (!condition) throw new Error('verification failed'); };
try {
  const file = process.env.ELIOT_K2_NOTEBOOKLM_ANSWERS; need(!!file);
  const bytes = fs.readFileSync(file), saved = fs.readFileSync(path.join(path.dirname(file), 'runs.json'));
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  need(bytes.length === 73907 && sha(bytes) === '4703f0023b35509a0e46375de2e09c9cf7e1f75c0be0e986b8f6aca9739435f9');
  need(saved.length === 868373 && sha(saved) === '20c06d901ed1da4992455f23a9ad7d2b78c116e0e446258eb016956d78174e17');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), runs = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved));
  const ids = ['C1','C2','C3','C4','O1','O2','O3','O4','O5','O6','O7','O8'];
  const headings = [...text.matchAll(/^##\s+(C[1-4]|O[1-8])(?:\s|[—–-]).*$/gm)];
  need(JSON.stringify(headings.map(m => m[1])) === JSON.stringify(ids));
  need(Array.isArray(runs) && JSON.stringify(runs.map(r => r.id)) === JSON.stringify(ids));
  const questions = new Map();
  for (const line of fs.readFileSync('eval/arxiv-10/questions.md', 'utf8').split('\n')) {
    const cells = line.split('|').map(s => s.trim());
    if (ids.includes(cells[1])) { need(!questions.has(cells[1])); questions.set(cells[1], cells[2]); }
  }
  need(questions.size === ids.length);
  const ui = 'Thoughts\nexpand_more\n';
  for (let i = 0; i < ids.length; i++) {
    const body = text.slice(headings[i].index + headings[i][0].length, headings[i + 1]?.index ?? text.length).trim();
    need(!!body && typeof runs[i].answer === 'string' && runs[i].answer.startsWith(ui));
    need(body === runs[i].answer.slice(ui.length)); need(runs[i].question.trim() === questions.get(ids[i]));
  }
  console.log('PASS: frozen hashes, UTF-8, 12 unique IDs, retained answer bodies and frozen questions; citation targets NOT_VERIFIED.');
} catch {
  console.error('FAIL: private baseline verification; no archive content printed.'); process.exitCode = 1;
}
'@ | node
if ($LASTEXITCODE -ne 0) { throw 'Private baseline verification failed.' }
```

**Portability:** this is an owner-controlled local Windows path, not a repository download, cloud attachment or remote
reviewer link. A checkout on another machine needs a separately authorized private transfer of the exact files and a
hash check, then its own `ELIOT_K2_NOTEBOOKLM_ANSWERS` path. No cross-machine access or independent off-host backup is
claimed. Keep the archive and any local comparison outputs private; this access recipe authorizes no publication or
model run. If the export is unavailable, the evaluator's tracked-summary fallback is incomplete comparison evidence.

**Citation probe remains incomplete:** `citation-transformer.txt` is a one-byte incomplete capture, not usable target
evidence. Adam/CoT probes and the
screenshots are retained as private context; they do not establish a complete audit of every citation target. Full
K2/K3 citation, latency and owner quality gates remain open. The historical summary below is not a replacement for
the archived answer bodies.

Recorded by the owner on the same ten PDFs. Kept as the bar for K2/K3 acceptance.


## Загрузка корпуса

| Шаг | Gemini Notebook (бывш. NotebookLM) | Eliot Research (живой сайт) |
|---|---|---|
| Загрузка 10 PDF | одним выбором файлов (несколько файлов за раз), ~1 мин на все | по одному файлу за раз, ~40–60 с на файл |
| PDF в область по умолчанию | принято | **QUARANTINED** (`QUALITY_BELOW_POLICY_MINIMUM`): PDF→markdown всегда `degraded`, а область «Eliot Research» требует `standard`; причина в интерфейсе не показана, кнопки «принять» нет |
| PDF в область «Документы» | — | принято (COMMITTED), источник добавлен в проект |
| После создания проекта | — | проект не открывается, остаётся список проектов |
| Название блокнота | автоматически по содержанию | вручную |

## Ответы Gemini Notebook

| # | Вопрос | Время | Оценка |
|---|---|---|---|
| C1 | d_model и головы | ~10 с | верно (512, 8), 2 ссылки |
| C2 | расписание LR | ~14 с | верно, формула, 4000, точная цитата, предлагает следующие вопросы |
| C3 | Adam по умолчанию | ~14 с | верно (0.001/0.9/0.999/1e-8), цитата |
| C4 | позиционные кодировки | ~16 с | верно: синусоидальные vs обучаемые + сегментные; объяснение экстраполяции |
| O1 | приёмы для глубоких сетей | ~25 с | сильно: 5 приёмов (остаточные связи — ResNet/Transformer/ViT; BatchNorm; LayerNorm; warmup — Transformer, ResNet-110, ViT; Adam), «почему работает» для каждого, 46 маркеров ссылок |
| O2 | размер, данные, напряжения | ~40 с | сильно: степенные законы Kaplan; напряжение «гладкий степенной рост vs эмерджентный скачок CoT»; 4,4 тыс. знаков |
| O3 | снижение стоимости и цена | ~40 с | сильно: LoRA, предобучение+дообучение, BatchNorm, CoT-промптинг без обновления весов, … с ценой каждого |
| O8 | галлюцинации (нет в корпусе) | ~30 с | честно: «ни одна статья не решает»; верно находит единственное касание — ограничения CoT и разбор ошибок PaLM 62B |

Итого Gemini Notebook: 7/7 верно, ответы 10–40 с, ссылки на каждое утверждение, в конце предлагает следующие вопросы.

## Ответы Eliot Research (живой сайт, версия git-b2891c5cf769, модель по умолчанию — встроенный Cloudflare)

| # | Вопрос | Время запуска (UTC) | Результат |
|---|---|---|---|
| O1 | приёмы для глубоких сетей | ~11:15 | **провал**: «Stage 6 · Failed», `RETRIEVE_BRANCHES · WORKFLOW_EFFECT_UNCERTAIN`, ответа нет; «исход неизвестен, проверьте перед новым вопросом», но кнопки проверки/повтора нет — тупик до перезагрузки страницы |
| C2 | расписание LR Transformer | ~11:25 | **провал**: то же самое, этап 6, `RETRIEVE_BRANCHES · WORKFLOW_EFFECT_UNCERTAIN` |

Остальные вопросы не задавались (квота): система не дошла до ответа ни разу. Итого Eliot: 0/2.
Состояние источников на момент вопросов (~15 мин после загрузки): точный и лексический канал Ready, смысловой (AI Search) — Unknown, качество Degraded.

## Новый браузерный прогон — 2026-10-26

По запросу владельца создан отдельный приватный
[блокнот](https://notebook.google.com/notebook/3c557682-848b-4243-b6e9-9def2e5dbd28).
Загружены те же десять PDF из локального SHA-256-проверенного корпуса; все десять готовы и выбраны.
Вопросы отправлены без эталонных подсказок в порядке C1–C4, O1–O8. Все двенадцать получили завершённый ответ.
Это новый агентский прогон, а не новая оценка владельца; историческая оценка выше сохранена отдельно.

| Проверка | Наблюдение |
|---|---|
| C1 | 512 и 8, верно |
| C2 | `d_model^-0.5 · min(step^-0.5, step · warmup^-1.5)`, warmup 4000, верно |
| C3 | 0.001 / 0.9 / 0.999 / 1e-8, верно |
| C4 | Transformer — синусоидальные; BERT — обучаемые позиционные и сегментные, верно |
| O1 | Остаточные связи, BN/LN, Adam/warmup, bottleneck, предобучение и LoRA; шире исходного ответа Eliot |
| O2 | Kaplan, BERT, ViT и несколько напряжений; CoT-масштаб в новом ответе не раскрыт |
| O3 | LoRA с batching-ограничением, BN, Transformer/ViT, bottleneck, few-shot/CoT и ранняя остановка |
| O4–O7 | Все ответы получены и сохранены; полная независимая проверка каждого утверждения не выполнена |
| O8 | Прямой отказ: корпус не решает галлюцинации; найдены ограничения CoT. Дополнительно перечислены внешние RAG/RLHF/DPO без цитат корпуса |
| Открытие цитат | Проверены Transformer (размер 512), Adam (четыре значения по умолчанию), CoT (нет гарантии корректности; factual generations — future work) |
| Время, токены, стоимость | Сервисное время не инструментировалось; браузерные наблюдения включают задержки автоматизации. Токены/стоимость NotebookLM не раскрыты, сравнение скорости не заявляется |

Полные видимые ответы, DOM-снимки с соответствием номеров цитат PDF, три открытых цитаты и скриншоты сохранены в
игнорируемом `eval/out/notebooklm-20261026/`. Сравнение обнаружило ошибки Eliot, перечисленные в MAP K2; оно не
подтверждает прохождение субъективного quality gate.
