function normRoleBindings(s) {
  const source = String(s).replace(/(\d)([⁺⁻])([⁰¹²³⁴⁵⁶⁷⁸⁹]+)/gu,
    (_match, base, sign, exponent) => base + '^' + (sign === '⁻' ? '-' : '+') + exponent.normalize('NFKC'));
  return source.normalize('NFKC')
    .replace(/\\text\s*\{([^{}]*)\}/giu, '$1')
    .replace(/\\(?:mathrm|mathbf|mathit|operatorname)\s*\{([^{}]*)\}/giu, '$1')
    .replace(/\\beta\s*_\s*\{?\s*([12])\s*\}?/giu, ' beta$1 ')
    .replace(/\\alpha\b/giu, ' alpha ')
    .replace(/\\beta\b/giu, ' beta ')
    .replace(/\\(?:epsilon|varepsilon|eps)\b/giu, ' epsilon ')
    .replace(/[αΑ]/gu, ' alpha ')
    .replace(/[βΒ]/gu, ' beta ')
    .replace(/[εϵΕ]/gu, ' epsilon ')
    .replace(/\\(?:cdot|times)\b|[×·]/giu, ' x ')
    .replace(/\*\*/gu, ' ')
    .replace(/(?<=\d)\s*\*\s*(?=\d)/gu, ' x ')
    .replace(/\\(?:left|right)\b/giu, ' ')
    .replace(/\\[(),\[\]]/gu, ' ')
    .replace(/\\,/gu, ' ')
    .replace(/\\quad\b/giu, ' ')
    .replace(/\\\\/gu, ' ; ')
    .replace(/\bbeta\s*_\s*\{?\s*([12])\s*\}?/giu, 'beta$1')
    .replace(/\bbeta\s+([12])\b/giu, 'beta$1')
    .replace(/[−–—]/gu, '-')
    .replace(/(\d)\s*,\s*(?=\d)/gu, '$1.')
    .replace(/['’]/gu, ' ')
    .replace(/[*_`${}]/gu, ' ')
    .replace(/\\/gu, ' ')
    .replace(/\s+/gu, ' ').trim().toLowerCase();
}
const ADAM_DEFAULT_MARKER = /\bdefaults?\b|по\s+умолчанию/iu;
const ADAM_SECONDARY_MARKER = /\b(?:variants?|versions?|applications?|examples?|comparisons?|experiments?|other works)\b|вариант[а-яё]*|вариаци[а-яё]*|применени[а-яё]*|пример[а-яё]*|сравнен[а-яё]*|эксперимент[а-яё]*|других\s+работах/iu;
const ADAM_TARGET_HEADING = /\badam\b|(?<![\p{L}\p{N}_])адам[а-яё]*(?![\p{L}\p{N}_])/iu;
function filterSecondaryAdamItems(raw) {
  const paragraphs = String(raw).split(/\n\s*\n+/u), retained = [];
  for (const paragraph of paragraphs) {
    const lines = paragraph.split('\n');
    const listBlock = lines.some((line) => /^\s*(?:[-*+•]|\d+[.)]|\|)/u.test(line));
    if (listBlock) {
      let item = [];
      const flush = () => { if (item.length) retained.push(item.join('\n')); item = []; };
      for (const line of lines) {
        if (ADAM_SECONDARY_MARKER.test(line)) flush();
        else item.push(line);
      }
      flush();
    } else {
      for (const sentence of paragraph.split(/(?<=[.!?])\s+(?=[A-ZА-ЯЁ])/u))
        if (sentence.trim() && !ADAM_SECONDARY_MARKER.test(sentence)) retained.push(sentence);
    }
  }
  return retained;
}
function adamFocusedItems(answer) {
  const lines = String(answer).replace(/\r\n?/gu, '\n').split('\n');
  const headings = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u.exec(lines[index]);
    if (match) headings.push({ index, title: match[1] });
  }
  if (!headings.length) return filterSecondaryAdamItems(lines.join('\n'));
  const sections = [];
  if (headings[0].index > 0) sections.push({ heading: '', text: lines.slice(0, headings[0].index).join('\n') });
  for (let index = 0; index < headings.length; index++) {
    const start = headings[index].index, end = headings[index + 1]?.index ?? lines.length;
    sections.push({ heading: headings[index].title, text: lines.slice(start, end).join('\n') });
  }
  const defaultSection = sections.find((section) => ADAM_DEFAULT_MARKER.test(section.heading) && !ADAM_SECONDARY_MARKER.test(section.heading));
  if (defaultSection) return [defaultSection.text];
  const adamSection = sections.find((section) => ADAM_TARGET_HEADING.test(section.heading) && !ADAM_SECONDARY_MARKER.test(section.heading));
  if (adamSection) return [adamSection.text];
  return sections.filter((section) => !ADAM_SECONDARY_MARKER.test(section.heading))
    .flatMap((section) => filterSecondaryAdamItems(section.text));
}
const NUMERIC_EXPRESSION = String.raw`(?:[+-]?\d+(?:\.\d+)?\s*x\s*10\s*\^\s*[+-]?\s*\d+|[+-]?\d+(?:\.\d+)?e[+-]?\d+|[+-]?10\s*\^\s*[+-]?\s*\d+|[+-]?\d+(?:\.\d+)?)`;
function numericExpressionMatches(text) {
  return [...text.matchAll(new RegExp('(?<![\\p{L}\\d.])' + NUMERIC_EXPRESSION + '(?![\\p{L}\\d]|\\.(?=\\d))', 'giu'))];
}
function numericExpressionValue(raw) {
  const compact = String(raw).replace(/\s+/gu, '').toLowerCase();
  let match = /^([+-]?\d+(?:\.\d+)?)x10\^([+-]?\d+)$/u.exec(compact);
  if (match) return Number(match[1] + 'e' + match[2]);
  match = /^([+-]?)10\^([+-]?\d+)$/u.exec(compact);
  if (match) return (match[1] === '-' ? -1 : 1) * (10 ** Number(match[2]));
  match = /^([+-]?\d+(?:\.\d+)?)\^([+-]?\d+)$/u.exec(compact);
  if (match) return Number(match[1]) ** Number(match[2]);
  return Number(compact);
}
const ADAM_PARAMETER_PATTERNS = [
  { name: 'alpha', pattern: /\balpha\b/giu, expected: 0.001 },
  { name: 'beta1', pattern: /\bbeta1\b/giu, expected: 0.9 },
  { name: 'beta2', pattern: /\bbeta2\b/giu, expected: 0.999 },
  { name: 'epsilon', pattern: /\bepsilon\b/giu, expected: 1e-8 },
];
const ADAM_BINDING_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'equals', 'equal', 'value', 'values', 'default', 'defaults',
  'parameter', 'parameters', 'coefficient', 'coefficients', 'set', 'to', 'at', 'of', 'for', 'has', 'have', 'with',
  'should', 'be', 'approximately', 'about', 'exactly', 'precisely', 'different', 'not', 'no', 'never', 'without',
  'по', 'умолчанию', 'значение', 'значения', 'параметр', 'параметра', 'коэффициент', 'коэффициента', 'равен',
  'равна', 'равно', 'составляет', 'составляют', 'установлен', 'установлена', 'установлено', 'установлены',
  'имеет', 'быть', 'примерно', 'около', 'точно', 'не', 'ни', 'без',
]);
const ADAM_NEGATION = /(?:\b(?:not|no|never|without)\b|(?<![\p{L}\p{N}_])(?:не|ни|без)(?![\p{L}\p{N}_])|!=|<>|≠)/iu;
const ADAM_UNIT = /(?:%|°\s*[cf]?\b|\b(?:percent(?:age)?|seconds?|secs?|milliseconds?|minutes?|hours?|hz|khz|kg|grams?|meters?|centimeters?|millimeters?|neurons?|tokens?|dollars?|bits?|bytes?|s|ms|sec)\b|\b(?:per|на)\s+(?:second|секунд[а-яё]*)\b|(?<![\p{L}\p{N}_])(?:процент[а-яё]*|секунд[а-яё]*|мс|с|минут[а-яё]*|час[а-яё]*|кг|грамм[а-яё]*|метр[а-яё]*|герц|нейрон[а-яё]*|токен[а-яё]*)(?![\p{L}\p{N}_]))/iu;
const ADAM_MODEL_SCOPE = /(?<![\p{L}\p{N}_])(?:adam|адам[а-яё]*|transformers?|трансформер[а-яё]*|bert|берт[а-яё]*)(?![\p{L}\p{N}_])/giu;
function bindingBridgeWords(text) {
  const focused = text.replace(/\(\s*(?:шаг\s+обучения\s*\/\s*learning\s+rate|шаг\s+обучения|learning\s+rate)\s*\)/giu, ' ');
  const words = focused.match(/[\p{L}]+/gu) || [];
  return words.every((word) => ADAM_BINDING_WORDS.has(word.toLowerCase()));
}
function adamBindingsInSegment(answer) {
  const text = normRoleBindings(answer);
  const labels = ADAM_PARAMETER_PATTERNS.flatMap((role) => [...text.matchAll(new RegExp(role.pattern.source, role.pattern.flags))]
    .map((match) => ({ name: role.name, expected: role.expected, start: match.index, end: match.index + match[0].length })));
  labels.sort((a, b) => a.start - b.start);
  const firstScope = labels.length
    ? [...text.slice(0, labels[0].start).matchAll(new RegExp(ADAM_MODEL_SCOPE.source, ADAM_MODEL_SCOPE.flags))][0]?.[0]
    : undefined;
  const numbers = numericExpressionMatches(text);
  const bindings = new Map(ADAM_PARAMETER_PATTERNS.map((role) => [role.name, []]));
  for (const label of labels) {
    const previousLabel = [...labels].reverse().find((other) => other.end <= label.start);
    const nextLabel = labels.find((other) => other.start >= label.end);
    const rightEnd = Math.min(text.length, label.end + 56, nextLabel?.start ?? text.length);
    const right = numbers.find((number) => number.index >= label.end && number.index < rightEnd);
    let number = null, bridge = '';
    if (right) {
      number = right;
      bridge = text.slice(label.end, number.index);
    } else {
      const leftStart = Math.max(previousLabel?.end ?? 0, label.start - 48);
      const left = numbers.filter((candidate) => candidate.index >= leftStart && candidate.index + candidate[0].length <= label.start).at(-1);
      if (left) {
        number = left;
        bridge = text.slice(number.index + number[0].length, label.start);
      }
    }
    if (!number || !bindingBridgeWords(bridge)) continue;
    const value = numericExpressionValue(number[0]);
    const relation = bridge + text.slice(Math.max(0, label.start - 14), label.start);
    const suffixEnd = Math.min(text.length, number.index + number[0].length + 32, nextLabel?.start ?? text.length);
    const suffixText = text.slice(number.index + number[0].length, suffixEnd);
    const suffixBoundary = /[;.!?\n]/u.exec(suffixText);
    const suffix = suffixBoundary ? suffixText.slice(0, suffixBoundary.index) : suffixText;
    bindings.get(label.name).push({ value, negated: ADAM_NEGATION.test(relation), unit: ADAM_UNIT.test(suffix) });
  }
  return { bindings, otherModelScope: !!firstScope && !/^(?:adam|адам)/iu.test(firstScope) };
}
function adamBindings(answer) {
  const bindings = new Map(ADAM_PARAMETER_PATTERNS.map((role) => [role.name, []]));
  for (const segment of adamFocusedItems(answer)) {
    const parsed = adamBindingsInSegment(segment);
    if (parsed.otherModelScope) continue;
    for (const role of ADAM_PARAMETER_PATTERNS) bindings.get(role.name).push(...parsed.bindings.get(role.name));
  }
  return { bindings };
}
export function checkAdamBindings(answer) {
  const { bindings } = adamBindings(answer);
  return ADAM_PARAMETER_PATTERNS.every((role) => {
    const matches = bindings.get(role.name);
    return matches.length > 0 && matches.every((match) => match.value === role.expected && !match.negated && !match.unit);
  });
}
const C4_MODEL_PATTERNS = [
  { name: 'Transformer', pattern: /(?<![\p{L}\p{N}_])(?:transformers?|трансформер[а-яё]*)(?![\p{L}\p{N}_])/giu },
  { name: 'BERT', pattern: /(?<![\p{L}\p{N}_])(?:bert|берт[а-яё]*)(?![\p{L}\p{N}_])/giu },
];
const C4_ENCODING_PATTERNS = [
  { name: 'sinusoidal', pattern: /(?<![\p{L}\p{N}_])(?:sinusoid(?:al)?|sine(?:-wave)?|синусоид[а-яё]*|синус[а-яё]*)(?![\p{L}\p{N}_])/giu },
  { name: 'learned', pattern: /(?<![\p{L}\p{N}_])(?:learned|learnable|trainable|обучаем[а-яё]*|изучаем[а-яё]*)(?![\p{L}\p{N}_])/giu },
];
const C4_POSITION = /(?<![\p{L}\p{N}_])(?:position(?:al)?|positions|позицион[а-яё]*)(?![\p{L}\p{N}_])/iu;
const C4_NEGATION = /(?:\b(?:not|no|never|without|doesn.t|isn.t|wasn.t|aren.t|cannot)\b|(?<![\p{L}\p{N}_])(?:не|ни|без|вместо)(?![\p{L}\p{N}_])|\brather\s+than\b|\binstead\s+of\b|!=|<>|≠)/iu;
const C4_ALTERNATIVE = /(?<![\p{L}\p{N}_])(?:experiment\w*|test\w*|tr(?:y|ied|ying)|consider\w*|explor\w*|alternative\w*|эксперимент[а-яё]*|провер[а-яё]*|проб[а-яё]*|вариант[а-яё]*|сравнива[а-яё]*)(?![\p{L}\p{N}_])/giu;
const C4_SELECTION = /(?<![\p{L}\p{N}_])(?:select\w*|choos\w*|chose|chosen|adopt\w*|use|uses|used|using|is|are|was|were|выбра[а-яё]*|использ[а-яё]*|предпочита[а-яё]*)(?![\p{L}\p{N}_])/giu;
function positionalEncodingBindings(answer) {
  const text = normRoleBindings(answer);
  if (!C4_POSITION.test(text)) return [];
  const modelLead = '(?:the\\s+)?(?:transformers?|bert|трансформер[а-яё]*|берт[а-яё]*)';
  const clauses = text.split(new RegExp('(?:[.!?;\\n]+|(?<![\\p{L}\\p{N}_])(?:whereas|while|but|however|но)(?![\\p{L}\\p{N}_])\\s+(?=' + modelLead + ')|(?<![\\p{L}\\p{N}_])(?:тогда\\s+как|в\\s+отличие\\s+от)(?![\\p{L}\\p{N}_])\\s+(?=' + modelLead + ')|,\\s*(?=а\\s))', 'giu'));
  const bindings = [];
  for (const clause of clauses) {
    const models = C4_MODEL_PATTERNS.flatMap((model) => [...clause.matchAll(new RegExp(model.pattern.source, model.pattern.flags))]
      .map((match) => ({ name: model.name, start: match.index, end: match.index + match[0].length })));
    const encodings = C4_ENCODING_PATTERNS.flatMap((encoding) => [...clause.matchAll(new RegExp(encoding.pattern.source, encoding.pattern.flags))]
      .map((match) => ({ name: encoding.name, start: match.index, end: match.index + match[0].length })));
    for (const encoding of encodings) {
      const nearestModel = models.map((model) => ({ model,
        distance: Math.max(0, Math.max(model.start, encoding.start) - Math.min(model.end, encoding.end)) }))
        .filter((candidate) => candidate.distance <= 96).sort((a, b) => a.distance - b.distance)[0];
      if (!nearestModel) continue;
      const model = nearestModel.model;
      const between = model.end <= encoding.start ? clause.slice(model.end, encoding.start) : clause.slice(encoding.end, model.start);
      const relationPrefix = clause.slice(Math.max(0, Math.min(model.start, encoding.start) - 16), Math.min(model.start, encoding.start));
      const alternatives = [...between.matchAll(new RegExp(C4_ALTERNATIVE.source, C4_ALTERNATIVE.flags))];
      const selections = [...between.matchAll(new RegExp(C4_SELECTION.source, C4_SELECTION.flags))];
      const alternative = alternatives.length > 0 && (!selections.length || alternatives[alternatives.length - 1].index > selections[selections.length - 1].index);
      bindings.push({ model: model.name, encoding: encoding.name, negated: C4_NEGATION.test(between + relationPrefix), alternative });
    }
  }
  return bindings;
}
export function checkPositionalEncodingBindings(answer) {
  const bindings = positionalEncodingBindings(answer);
  const hasCore = (model, encoding, negated = false) => bindings.some((binding) =>
    binding.model === model && binding.encoding === encoding && binding.negated === negated && !binding.alternative);
  return hasCore('Transformer', 'sinusoidal') && hasCore('BERT', 'learned')
    && !hasCore('Transformer', 'learned') && !hasCore('BERT', 'sinusoidal')
    && !hasCore('Transformer', 'sinusoidal', true) && !hasCore('BERT', 'learned', true);
}
