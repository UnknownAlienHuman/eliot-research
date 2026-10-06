import ts from "typescript";
import { isFunctionDeclaration, propertyName, targetBits, trackedFields, unwrap } from "./receiver-target-provenance-values.mjs";

/** Poison provenance that crosses an unqualified call, write, return, or closure boundary. */
export function propagateEscapedTargetBindings({
  program,
  rootFileSet,
  reachable,
  calls,
  checker,
  functionKey,
  allowedCaller,
  parameterSymbol,
  evaluate,
  evaluateSymbol,
  escapedSymbols,
  escapedProperties,
}) {
  const targetMask = targetBits.core | targetBits.search;
  const callByNode = new Map(calls.map((call) => [call.node, call]));

  function containsTarget(value) {
    return (value.self & targetMask) !== 0
      || [...value.fields.values()].some((bits) => (bits & targetMask) !== 0)
      || [...value.objects.values()].some(containsTarget);
  }

  function expressionContainsTarget(node, includeClosureValues = true) {
    const expression = unwrap(node);
    if (!expression) return false;
    if (containsTarget(evaluate(expression, new Set()))) return true;
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.some((element) => expressionContainsTarget(element, includeClosureValues));
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.some((property) => ts.isSpreadAssignment(property)
        ? expressionContainsTarget(property.expression, includeClosureValues)
        : ts.isPropertyAssignment(property)
          ? (includeClosureValues || trackedFields.has(propertyName(property.name)))
            && expressionContainsTarget(property.initializer, includeClosureValues)
          : ts.isShorthandPropertyAssignment(property)
            && (includeClosureValues || trackedFields.has(property.name.text))
            && containsTarget(evaluateSymbol(checker.getShorthandAssignmentValueSymbol(property), new Set())));
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      if (!includeClosureValues) return false;
      let found = false;
      function visitCapture(candidate) {
        if (!found && ts.isIdentifier(candidate) && containsTarget(evaluate(candidate, new Set()))) found = true;
        if (!found) ts.forEachChild(candidate, visitCapture);
      }
      visitCapture(expression.body);
      return found;
    }
    if (ts.isConditionalExpression(expression)) {
      return expressionContainsTarget(expression.whenTrue, includeClosureValues)
        || expressionContainsTarget(expression.whenFalse, includeClosureValues);
    }
    return false;
  }

  function markEscapedSymbol(symbol, resolving) {
    if (!symbol || resolving.has(symbol)) return;
    escapedSymbols.add(symbol);
    resolving.add(symbol);
    const declaration = symbol.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      markEscaped(declaration.initializer, resolving);
    }
    resolving.delete(symbol);
  }

  function markEscaped(node, resolving = new Set()) {
    const expression = unwrap(node);
    if (!expression) return;
    if (ts.isIdentifier(expression)) {
      markEscapedSymbol(checker.getSymbolAtLocation(expression), resolving);
      return;
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const name = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
      const property = ts.isPropertyAccessExpression(expression) ? checker.getSymbolAtLocation(expression.name)
        : name ? checker.getPropertyOfType(checker.getTypeAtLocation(expression.expression), name) : undefined;
      if (property) escapedProperties.add(property);
      markEscaped(expression.expression, resolving);
      return;
    }
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) markEscaped(property.expression, resolving);
        else if (ts.isPropertyAssignment(property)) markEscaped(property.initializer, resolving);
        else if (ts.isShorthandPropertyAssignment(property)) {
          markEscapedSymbol(checker.getShorthandAssignmentValueSymbol(property), resolving);
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) {
        markEscaped(ts.isSpreadElement(element) ? element.expression : element, resolving);
      }
      return;
    }
    if (ts.isConditionalExpression(expression)) {
      markEscaped(expression.whenTrue, resolving);
      markEscaped(expression.whenFalse, resolving);
      return;
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      function visitCapture(candidate) {
        if (ts.isIdentifier(candidate) && containsTarget(evaluate(candidate, new Set()))) markEscaped(candidate, resolving);
        ts.forEachChild(candidate, visitCapture);
      }
      visitCapture(expression.body);
    }
  }

  for (const source of program.getSourceFiles()) {
    if (!rootFileSet.has(source.fileName.replaceAll("\\", "/").toLowerCase())) continue;
    function visit(node) {
      let owner = node.parent;
      while (owner && !isFunctionDeclaration(owner)) owner = owner.parent;
      const ownerKey = owner && functionKey(checker, owner);
      if (ownerKey && reachable.has(ownerKey)) {
        if (ts.isCallExpression(node)) {
          const call = callByNode.get(node);
          if (!call || !allowedCaller(call)) {
            for (const argument of node.arguments) {
              const actual = ts.isSpreadElement(argument) ? argument.expression : argument;
              if (expressionContainsTarget(actual)) {
                markEscaped(actual);
              }
            }
          }
        } else if (ts.isNewExpression(node)) {
          for (const argument of node.arguments ?? []) {
            const actual = ts.isSpreadElement(argument) ? argument.expression : argument;
            if (expressionContainsTarget(actual)) {
              markEscaped(actual);
            }
          }
        } else if (ts.isReturnStatement(node) && node.expression && expressionContainsTarget(node.expression, false)) {
          markEscaped(node.expression);
        } else if (ts.isBinaryExpression(node)
            && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            && expressionContainsTarget(node.right)) {
          const left = unwrap(node.left);
          if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) markEscaped(node.right);
          else if (ts.isIdentifier(left)) {
            const symbol = checker.getSymbolAtLocation(left);
            const declaration = symbol?.valueDeclaration;
            let declarationOwner = declaration?.parent;
            while (declarationOwner && !isFunctionDeclaration(declarationOwner)) declarationOwner = declarationOwner.parent;
            if (declarationOwner !== owner) markEscaped(node.right);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }

  let changed = true;
  let rounds = 0;
  while (changed && rounds < 64) {
    changed = false;
    rounds += 1;
    for (const call of calls) {
      if (!allowedCaller(call)) continue;
      call.callee.parameters.forEach((parameter, index) => {
        const symbol = parameterSymbol(parameter);
        const argument = call.node.arguments[index];
        if (!symbol || !escapedSymbols.has(symbol) || !argument) return;
        const actual = ts.isSpreadElement(argument) ? argument.expression : argument;
        const before = escapedSymbols.size + escapedProperties.size;
        markEscaped(actual);
        if (escapedSymbols.size + escapedProperties.size !== before) changed = true;
      });
    }
  }
}
