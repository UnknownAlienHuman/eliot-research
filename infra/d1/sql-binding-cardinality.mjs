export function createSqlBindingCardinality({ source, ts, lexical, evaluate, environmentFor }) {
  const contextCache = new WeakMap();
  const mutatingArrayMethods = new Set(["push", "pop", "shift", "unshift", "splice", "fill", "copyWithin", "reverse", "sort"]);

  function unwrap(node) {
    let current = node;
    while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current) || ts.isAwaitExpression(current))) {
      current = ts.isAwaitExpression(current) ? current.expression : current.expression;
    }
    return current;
  }

  function literalInteger(node) {
    const expression = unwrap(node);
    if (expression && ts.isNumericLiteral(expression)) {
      const value = Number(expression.text);
      return Number.isInteger(value) ? value : undefined;
    }
    if (expression && ts.isPrefixUnaryExpression(expression)
        && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(expression.operator)
        && ts.isNumericLiteral(expression.operand)) {
      const magnitude = Number(expression.operand.text);
      const value = expression.operator === ts.SyntaxKind.MinusToken ? -magnitude : magnitude;
      return Number.isInteger(value) ? value : undefined;
    }
    return undefined;
  }

  function unwrapWithAwait(node) {
    let current = node;
    let awaited = false;
    while (current) {
      if (ts.isAwaitExpression(current)) {
        awaited = true;
        current = current.expression;
      } else if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
          || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) current = current.expression;
      else break;
    }
    return { node: current, awaited };
  }

  function transparentParent(node) {
    let current = node;
    while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
        || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current))) current = current.parent;
    return current;
  }

  function ownerFor(node) {
    return lexical.nearestFunction(node);
  }

  function unknownElements(length) {
    return Array.from({ length }, () => ({ value: undefined, known: false }));
  }

  function arrayElementsOf(expression, context, seenBindings = new Set(), seenFunctions = new Set()) {
    const { node, awaited } = unwrapWithAwait(expression);
    if (!node || !context) return undefined;
    if (ts.isArrayLiteralExpression(node)) {
      const elements = [];
      for (const element of node.elements) {
        if (!ts.isSpreadElement(element)) {
          const value = evaluate(element, context.environment);
          elements.push({ value, known: value !== undefined });
          continue;
        }
        const spread = arrayElementsOf(element.expression, context, seenBindings, seenFunctions);
        if (!spread) return undefined;
        elements.push(...spread);
      }
      return elements;
    }
    if (ts.isIdentifier(node)) {
      const binding = lexical.bindingAt(node, context.owner ?? ownerFor(node));
      if (!binding || binding.ambiguous || seenBindings.has(binding.declaration)) return undefined;
      if (binding.kind === "parameter" && binding.declaration.dotDotDotToken) {
        const length = exactRestLength(binding, context, seenBindings);
        return length === undefined ? undefined : unknownElements(length);
      }
      if (!safeArrayBinding(binding, node)) return undefined;
      const nextBindings = new Set(seenBindings);
      nextBindings.add(binding.declaration);
      return arrayElementsOf(binding.declaration.initializer, {
        ...context,
        owner: declarationOwner(binding),
      }, nextBindings, seenFunctions);
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "slice") {
        const values = arrayElementsOf(callee.expression, context, seenBindings, seenFunctions);
        const start = node.arguments[0] ? literalInteger(node.arguments[0]) : 0;
        const end = node.arguments[1] ? literalInteger(node.arguments[1]) : values?.length;
        if (!values || start !== 0 || !Number.isInteger(end) || end < 0) return undefined;
        return values.slice(0, Math.min(values.length, end));
      }
      if (ts.isIdentifier(callee)) {
        const resolved = lexical.resolveFunction(callee);
        if (!resolved || !stableHelperReference(resolved.binding)) return undefined;
        if (resolved.fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) && !awaited) return undefined;
        return helperReturnElements(resolved.fn, context, seenFunctions);
      }
    }
    const length = lengthOf(expression, context, seenBindings, seenFunctions);
    return length === undefined ? undefined : unknownElements(length);
  }

  function parameterValues(owner, call, callerContext) {
    const callerEnvironment = callerContext.environment;
    const actuals = [];
    let complete = true;
    let shapeComplete = true;
    let unknownAt;
    let untrustedValuesAt;
    for (const argument of call.arguments) {
      if (!ts.isSpreadElement(argument)) {
        const value = evaluate(argument, callerEnvironment);
        actuals.push({ value, known: value !== undefined });
        if (value === undefined) complete = false;
        continue;
      }
      const spread = arrayElementsOf(argument.expression, {
        owner: ownerFor(call),
        environment: callerEnvironment,
        path: callerContext.path,
      });
      if (!spread) {
        unknownAt = actuals.length;
        complete = false;
        shapeComplete = false;
        break;
      }
      actuals.push(...spread);
      if (spread.some((value) => !value.known)) {
        untrustedValuesAt ??= actuals.length - spread.length;
        complete = false;
      }
    }
    const values = new Map();
    let argumentIndex = 0;
    for (const parameter of owner.parameters ?? []) {
      if (!ts.isIdentifier(parameter.name)) {
        complete = false;
        argumentIndex += 1;
        continue;
      }
      if (parameter.dotDotDotToken) {
        const rest = unknownAt === undefined ? actuals.slice(argumentIndex) : undefined;
        values.set(parameter.name.text, rest?.every((value) => value.known) ? rest.map((value) => value.value) : undefined);
        argumentIndex = actuals.length;
        continue;
      }
      const isUnknownPosition = unknownAt !== undefined && argumentIndex >= unknownAt;
      const isUntrustedPosition = untrustedValuesAt !== undefined && argumentIndex >= untrustedValuesAt;
      const supplied = !isUnknownPosition && argumentIndex < actuals.length;
      const actual = supplied ? actuals[argumentIndex] : undefined;
      if (isUnknownPosition || isUntrustedPosition) {
        values.set(parameter.name.text, undefined);
        complete = false;
      } else if (actual) {
        values.set(parameter.name.text, actual.value);
        if (!actual.known) complete = false;
      } else if (parameter.initializer) {
        const value = evaluate(parameter.initializer, values);
        values.set(parameter.name.text, value);
        if (value === undefined) complete = false;
      } else {
        values.set(parameter.name.text, undefined);
        complete = false;
      }
      argumentIndex += 1;
    }
    return { values, complete, shapeComplete };
  }

  function contextsForOwner(owner, stack = new Set()) {
    if (!owner) return [{ environment: new Map(), path: { steps: [], complete: true } }];
    if (contextCache.has(owner) && stack.size === 0) return contextCache.get(owner);
    const binding = lexical.functionBinding(owner);
    if (!binding || binding.ambiguous || stack.has(binding.declaration)) {
      return [{ environment: environmentFor(owner), path: { steps: [], complete: false } }];
    }
    const incoming = lexical.directCallSites(binding);
    const unknownContext = () => ({ environment: environmentFor(owner), path: { steps: [], complete: false } });
    if (!incoming.stable) {
      const fallback = [unknownContext()];
      if (stack.size === 0) contextCache.set(owner, fallback);
      return fallback;
    }
    const nextStack = new Set(stack);
    nextStack.add(binding.declaration);
    const contexts = [];
    for (const call of incoming.calls) {
      const caller = ownerFor(call);
      const callers = caller ? contextsForOwner(caller, nextStack) : [{ environment: new Map(), path: { steps: [], complete: true } }];
      for (const callerContext of callers) {
        const supplied = parameterValues(owner, call, callerContext);
        const environment = environmentFor(owner, supplied.values, callerContext.environment);
        const step = {
          owner,
          binding,
          call,
          caller,
          callerEnvironment: callerContext.environment,
          argsComplete: supplied.complete,
          edgeComplete: incoming.stable && supplied.shapeComplete,
        };
        contexts.push({
          environment,
          path: {
            steps: [...callerContext.path.steps, step],
            complete: callerContext.path.complete && step.edgeComplete,
          },
        });
      }
    }
    if (incoming.calls.length === 0 || !incoming.complete) contexts.push(unknownContext());
    const result = contexts.length ? contexts : [{ environment: environmentFor(owner), path: { steps: [], complete: false } }];
    if (stack.size === 0) contextCache.set(owner, result);
    return result;
  }

  function contextsForPrepare(call) {
    const owner = ownerFor(call);
    return owner ? contextsForOwner(owner) : [{ environment: new Map(), path: { steps: [], complete: true } }];
  }

  function declarationOwner(binding) {
    if (!binding?.declaration) return undefined;
    if (ts.isParameter(binding.declaration)) return ownerFor(binding.declaration);
    return ownerFor(binding.declaration);
  }

  function isEarlier(binding, reference) {
    return binding.declaration.end < reference.getStart(source);
  }

  function localWritesOrEscape(binding) {
    const references = lexical.references(binding);
    if (!references.length) return true;
    for (const reference of references) {
      const refOwner = ownerFor(reference);
      const bindingOwner = declarationOwner(binding);
      if (refOwner !== bindingOwner) return true;
      let parent = reference.parent;
      if (ts.isSpreadElement(parent) && parent.expression === reference) continue;
      if (ts.isReturnStatement(parent) && parent.expression === reference) continue;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === reference && parent.name.text === "slice"
          && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) continue;
      if (ts.isElementAccessExpression(parent) && parent.expression === reference) return true;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === reference && mutatingArrayMethods.has(parent.name.text)) return true;
      return true;
    }
    return false;
  }

  function safeArrayBinding(binding, reference) {
    if (!binding || binding.ambiguous || binding.kind !== "const" || !ts.isVariableDeclaration(binding.declaration)
        || !binding.declaration.initializer || !isEarlier(binding, reference) || localWritesOrEscape(binding)) return false;
    return true;
  }

  function exactRestLength(binding, context, seen) {
    const owner = declarationOwner(binding);
    if (!owner || localWritesOrEscape(binding)) return undefined;
    const ownerBinding = lexical.functionBinding(owner);
    const step = [...context.path.steps].reverse().find((candidate) => candidate.owner === owner
      && candidate.binding?.declaration === ownerBinding?.declaration);
    if (!step || !step.edgeComplete) return undefined;
    const parameter = binding.declaration;
    const restIndex = owner.parameters.indexOf(parameter);
    if (restIndex < 0 || !parameter.dotDotDotToken) return undefined;
    if (step.call.arguments.slice(0, restIndex).some((argument) => ts.isSpreadElement(argument))) return undefined;
    let supplied = 0;
    for (const argument of step.call.arguments.slice(restIndex)) {
      if (!ts.isSpreadElement(argument)) supplied += 1;
      else {
        const length = lengthOf(argument.expression, {
          path: { ...context.path, steps: context.path.steps.slice(0, context.path.steps.indexOf(step)) },
          environment: step.callerEnvironment,
          owner: step.caller,
        }, seen);
        if (length === undefined) return undefined;
        supplied += length;
      }
    }
    return supplied;
  }

  function helperReturnElements(fn, context, seenFunctions) {
    if (!fn || fn.asteriskToken || seenFunctions.has(fn)) return undefined;
    const nextFunctions = new Set(seenFunctions);
    nextFunctions.add(fn);
    const summaryContext = {
      ...context,
      owner: fn,
      environment: environmentFor(fn),
      path: { steps: [], complete: false },
    };
    function shape(node) {
      return arrayElementsOf(node, summaryContext, new Set(), nextFunctions);
    }
    function returns(statement) {
      if (!statement) return { shapes: [], fallsThrough: true, valid: true };
      if (ts.isReturnStatement(statement)) {
        const result = statement.expression ? shape(statement.expression) : undefined;
        return { shapes: [result], fallsThrough: false, valid: result !== undefined };
      }
      if (ts.isThrowStatement(statement)) return { shapes: [], fallsThrough: false, valid: true };
      if (ts.isBlock(statement)) {
        let shapes = [];
        let fallsThrough = true;
        let valid = true;
        for (const child of statement.statements) {
          if (!fallsThrough) break;
          const result = returns(child);
          shapes = [...shapes, ...result.shapes];
          fallsThrough = result.fallsThrough;
          valid &&= result.valid;
        }
        return { shapes, fallsThrough, valid };
      }
      if (ts.isIfStatement(statement)) {
        const thenResult = returns(statement.thenStatement);
        const elseResult = statement.elseStatement ? returns(statement.elseStatement) : { shapes: [], fallsThrough: true, valid: true };
        return {
          shapes: [...thenResult.shapes, ...elseResult.shapes],
          fallsThrough: thenResult.fallsThrough || elseResult.fallsThrough,
          valid: thenResult.valid && elseResult.valid,
        };
      }
      if (ts.isSwitchStatement(statement) || ts.isForStatement(statement) || ts.isForInStatement(statement)
          || ts.isForOfStatement(statement) || ts.isWhileStatement(statement) || ts.isDoStatement(statement)
          || ts.isTryStatement(statement) || ts.isLabeledStatement(statement) || ts.isWithStatement(statement)) {
        return { shapes: [], fallsThrough: true, valid: false };
      }
      if (ts.isVariableStatement(statement) || ts.isExpressionStatement(statement) || ts.isEmptyStatement(statement)) {
        return { shapes: [], fallsThrough: true, valid: true };
      }
      return { shapes: [], fallsThrough: true, valid: false };
    }
    const body = fn.body;
    if (!body) return undefined;
    if (!ts.isBlock(body)) return shape(body);
    const result = returns(body);
    if (!result.valid || result.fallsThrough || result.shapes.length === 0) return undefined;
    const length = result.shapes[0].length;
    if (!result.shapes.every((items) => items.length === length)) return undefined;
    return Array.from({ length }, (_, index) => {
      const alternatives = result.shapes.map((items) => items[index]);
      const first = alternatives[0];
      return alternatives.every((item) => item.known && first.known && Object.is(item.value, first.value))
        ? first : { value: undefined, known: false };
    });
  }

  function stableHelperReference(binding) {
    if (ts.isVariableDeclaration(binding.declaration) && binding.kind !== "const") return false;
    return lexical.references(binding).every((reference) => ts.isCallExpression(reference.parent)
      && reference.parent.expression === reference && !reference.parent.questionDotToken);
  }

  function lengthOf(expression, context, seenBindings = new Set(), seenFunctions = new Set()) {
    const { node, awaited } = unwrapWithAwait(expression);
    if (!node || !context) return undefined;
    if (ts.isArrayLiteralExpression(node)) {
      let length = 0;
      for (const element of node.elements) {
        if (!ts.isSpreadElement(element)) length += 1;
        else {
          const spreadLength = lengthOf(element.expression, context, seenBindings, seenFunctions);
          if (spreadLength === undefined) return undefined;
          length += spreadLength;
        }
      }
      return length;
    }
    if (ts.isIdentifier(node)) {
      const binding = lexical.bindingAt(node, context.owner ?? ownerFor(node));
      if (!binding || binding.ambiguous || seenBindings.has(binding.declaration)) return undefined;
      if (binding.kind === "parameter" && binding.declaration.dotDotDotToken) return exactRestLength(binding, context, seenBindings);
      if (!safeArrayBinding(binding, node)) return undefined;
      const nextBindings = new Set(seenBindings);
      nextBindings.add(binding.declaration);
      return lengthOf(binding.declaration.initializer, { ...context, owner: declarationOwner(binding) }, nextBindings, seenFunctions);
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "slice"
          && ts.isCallExpression(node) && callee.expression) {
        const receiverLength = lengthOf(callee.expression, context, seenBindings, seenFunctions);
        const start = node.arguments[0] ? literalInteger(node.arguments[0]) : 0;
        const end = node.arguments[1] ? literalInteger(node.arguments[1]) : receiverLength;
        if (receiverLength === undefined || start !== 0 || !Number.isInteger(end) || end < 0) return undefined;
        return Math.min(receiverLength, end);
      }
      if (ts.isIdentifier(callee)) {
        const resolved = lexical.resolveFunction(callee);
        if (!resolved || !stableHelperReference(resolved.binding)) return undefined;
        if (resolved.fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) && !awaited) return undefined;
        return helperReturnElements(resolved.fn, context, seenFunctions)?.length;
      }
    }
    return undefined;
  }

  function bindingMetadata(prepareCall, context) {
    const parent = transparentParent(prepareCall.parent);
    if (parent && ts.isPropertyAccessExpression(parent) && parent.name.text === "bind"
        && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
      let arity = 0;
      for (const argument of parent.parent.arguments) {
        if (!ts.isSpreadElement(argument)) arity += 1;
        else {
          const length = lengthOf(argument.expression, { ...context, owner: ownerFor(prepareCall) });
          if (length === undefined) return { bindingArity: null, bindingProvenance: "dynamic-bind-arguments" };
          arity += length;
        }
      }
      return { bindingArity: arity, bindingProvenance: "direct-bind" };
    }
    const terminalMethods = new Set(["all", "first", "raw", "run"]);
    if (parent && ts.isPropertyAccessExpression(parent) && terminalMethods.has(parent.name.text)
        && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
      return { bindingArity: 0, bindingProvenance: "direct-no-bind" };
    }
    return { bindingArity: null, bindingProvenance: "indirect-or-unknown" };
  }

  return { contextsForPrepare, bindingMetadata, lengthOf };
}
