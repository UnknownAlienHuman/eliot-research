import ts from "typescript";

function isScalarType(type) {
  if (!type || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Object | ts.TypeFlags.Never)) return false;
  const parts = type.isUnion() ? type.types : [type];
  const scalar = ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean | ts.TypeFlags.BigInt
    | ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral
    | ts.TypeFlags.BigIntLiteral | ts.TypeFlags.Enum | ts.TypeFlags.EnumLiteral
    | ts.TypeFlags.Null | ts.TypeFlags.Undefined;
  return parts.length > 0 && parts.every((part) => (part.flags & ~scalar) === 0);
}

function isWriteUse(access) {
  const parent = access.parent;
  return Boolean((ts.isBinaryExpression(parent) && parent.left === access
      && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
    || ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
      && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken))
    || (ts.isDeleteExpression(parent) && parent.expression === access));
}

function identifierValue(node, checker) {
  if (!node || !ts.isIdentifier(node)) return undefined;
  return ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
}

/** Prove a callee only reads scalar Env properties and cannot retain the Env object. */
export function proveScalarEnvironmentConsumer(functionNode, parameterIndex, checker, callsByNode, active = new Set()) {
  if (!functionNode?.body || !functionNode.parameters?.[parameterIndex]
      || !ts.isIdentifier(functionNode.parameters[parameterIndex].name)) return false;
  const parameter = functionNode.parameters[parameterIndex];
  const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
  if (!parameterSymbol || active.has(parameterSymbol)) return false;
  const environmentType = checker.getTypeAtLocation(parameter);
  if (environmentType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  active.add(parameterSymbol);
  let valid = true;
  function visit(node, nestedFunction) {
    if (!valid) return;
    if (node !== functionNode.body && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) nestedFunction = true;
    if (ts.isIdentifier(node) && identifierValue(node, checker) === parameterSymbol) {
      if (nestedFunction) { valid = false; return; }
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        const property = checker.getPropertyOfType(environmentType, parent.name.text);
        if (!property || checker.getSymbolAtLocation(parent.name) !== property || isWriteUse(parent)
            || !isScalarType(checker.getTypeAtLocation(parent))) {
          valid = false;
          return;
        }
      } else if (ts.isCallExpression(parent) && parent.arguments.includes(node)) {
        const index = parent.arguments.indexOf(node);
        const call = callsByNode.get(parent);
        if (!call || !call.callee?.body
            || !proveScalarEnvironmentConsumer(call.callee, index, checker, callsByNode, active)) {
          valid = false;
          return;
        }
      } else {
        valid = false;
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, nestedFunction));
  }
  visit(functionNode.body, false);
  active.delete(parameterSymbol);
  return valid;
}
