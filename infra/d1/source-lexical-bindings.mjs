export function createSourceLexicalBindings(source, ts) {
  const declarationCache = new WeakMap();
  const referenceCache = new WeakMap();

  function nearestFunction(node) {
    let owner = node?.parent;
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
    return owner;
  }

  function lexicalScope(node, owner) {
    let current = node.parent;
    while (current && current !== owner) {
      if (ts.isBlock(current) || ts.isCaseBlock(current) || ts.isCatchClause(current)
          || ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) return current;
      current = current.parent;
    }
    return owner;
  }

  function addPatternNames(pattern, declaration, kind, scope, declarations) {
    if (ts.isIdentifier(pattern)) {
      declarations.push({ name: pattern.text, declaration, kind, scope });
    } else if (ts.isObjectBindingPattern(pattern) || ts.isArrayBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        if (ts.isBindingElement(element)) addPatternNames(element.name, declaration, "destructuring", scope, declarations);
      }
    }
  }

  function declarationsFor(owner) {
    if (!owner?.body) return [];
    if (declarationCache.has(owner)) return declarationCache.get(owner);
    const declarations = [];
    function visit(node) {
      if (node !== owner.body && ts.isFunctionLike(node)) {
        if (ts.isFunctionDeclaration(node) && node.name) {
          declarations.push({ name: node.name.text, declaration: node, kind: "function", scope: lexicalScope(node, owner) });
        }
        return;
      }
      if (ts.isVariableDeclaration(node)) {
        const parent = node.parent;
        if (ts.isCatchClause(parent)) {
          addPatternNames(node.name, node, "catch", parent, declarations);
        } else {
          const flags = ts.getCombinedNodeFlags(parent);
          const scope = (flags & ts.NodeFlags.BlockScoped) !== 0 ? lexicalScope(node, owner) : owner;
          const kind = (flags & ts.NodeFlags.Const) !== 0 ? "const"
            : (flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
          addPatternNames(node.name, node, kind, scope, declarations);
        }
      } else if (ts.isClassDeclaration(node) && node.name) {
        declarations.push({ name: node.name.text, declaration: node, kind: "class", scope: lexicalScope(node, owner) });
      } else if (ts.isEnumDeclaration(node)) {
        declarations.push({ name: node.name.text, declaration: node, kind: "enum", scope: lexicalScope(node, owner) });
      }
      ts.forEachChild(node, visit);
    }
    for (const parameter of owner.parameters ?? []) addPatternNames(parameter.name, parameter, "parameter", owner, declarations);
    visit(owner.body);
    declarationCache.set(owner, declarations);
    return declarations;
  }

  function scopeChain(node, owner) {
    const scopes = [];
    let current = node.parent;
    while (current && current !== owner) {
      if (ts.isBlock(current) || ts.isCaseBlock(current) || ts.isCatchClause(current)
          || ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) scopes.push(current);
      if (ts.isWithStatement(current)) return undefined;
      current = current.parent;
    }
    if (current !== owner) return undefined;
    scopes.push(owner);
    return scopes;
  }

  function bindingAt(identifier, owner = nearestFunction(identifier)) {
    let currentOwner = owner;
    while (currentOwner) {
      const scopes = scopeChain(identifier, currentOwner);
      if (!scopes) return { ambiguous: true };
      const declarations = declarationsFor(currentOwner);
      for (const scope of scopes) {
        const matches = declarations.filter((item) => item.scope === scope && item.name === identifier.text);
        if (matches.length > 1) return { ambiguous: true };
        if (matches.length === 1) return matches[0];
      }
      let parent = currentOwner.parent;
      while (parent && !ts.isFunctionLike(parent)) parent = parent.parent;
      currentOwner = parent;
    }
    return globalBindingAt(identifier);
  }

  function bindingAtInOwner(identifier, owner) {
    if (!owner) return undefined;
    const scopes = scopeChain(identifier, owner);
    if (!scopes) return undefined;
    const declarations = declarationsFor(owner);
    for (const scope of scopes) {
      const matches = declarations.filter((item) => item.scope === scope && item.name === identifier.text);
      if (matches.length > 1) return { ambiguous: true };
      if (matches.length === 1) return matches[0];
    }
    return undefined;
  }

  const globals = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      globals.push({ name: statement.name.text, declaration: statement, kind: "function", scope: source });
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      globals.push({ name: statement.name.text, declaration: statement, kind: "class", scope: source });
    } else if (ts.isEnumDeclaration(statement)) {
      globals.push({ name: statement.name.text, declaration: statement, kind: "enum", scope: source });
    } else if (ts.isVariableStatement(statement)) {
      const flags = ts.getCombinedNodeFlags(statement.declarationList);
      const kind = (flags & ts.NodeFlags.Const) !== 0 ? "const"
        : (flags & ts.NodeFlags.Let) !== 0 ? "let" : "var";
      for (const declaration of statement.declarationList.declarations) {
        addPatternNames(declaration.name, declaration, kind, source, globals);
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      if (statement.importClause.name) globals.push({ name: statement.importClause.name.text, declaration: statement, kind: "import", scope: source });
      const bindings = statement.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) globals.push({ name: bindings.name.text, declaration: statement, kind: "import", scope: source });
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) globals.push({ name: element.name.text, declaration: statement, kind: "import", scope: source });
      }
    }
  }

  function globalBindingAt(identifier) {
    const matches = globals.filter((item) => item.name === identifier.text);
    if (matches.length > 1) return { ambiguous: true };
    return matches[0];
  }

  function references(binding) {
    if (!binding || binding.ambiguous) return [];
    if (referenceCache.has(binding.declaration)) return referenceCache.get(binding.declaration);
    const found = [];
    function visit(node) {
      if (ts.isIdentifier(node) && node !== binding.declaration.name && bindingAt(node)?.declaration === binding.declaration) found.push(node);
      ts.forEachChild(node, visit);
    }
    visit(source);
    referenceCache.set(binding.declaration, found);
    return found;
  }

  function functionBinding(owner) {
    if (!owner) return undefined;
    if (ts.isFunctionDeclaration(owner) && owner.name) return bindingAt(owner.name, nearestFunction(owner));
    if ((ts.isArrowFunction(owner) || ts.isFunctionExpression(owner))
        && ts.isVariableDeclaration(owner.parent) && ts.isIdentifier(owner.parent.name)) {
      return bindingAt(owner.parent.name, nearestFunction(owner.parent));
    }
    return undefined;
  }

  function resolveFunction(identifier) {
    const binding = bindingAt(identifier);
    if (!binding || binding.ambiguous || binding.kind === "import") return undefined;
    const declaration = binding.declaration;
    const fn = ts.isFunctionDeclaration(declaration) ? declaration
      : ts.isVariableDeclaration(declaration) && declaration.initializer
        && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
        ? declaration.initializer : undefined;
    return fn ? { binding, fn } : undefined;
  }

  function directCallSites(binding) {
    const refs = references(binding);
    const calls = [];
    let complete = !isExported(binding);
    let stable = !(ts.isVariableDeclaration(binding.declaration) && binding.kind !== "const");
    for (const reference of refs) {
      if (isWriteReference(reference)) stable = false;
      const call = reference.parent;
      if (ts.isCallExpression(call) && call.expression === reference && !call.questionDotToken) calls.push(call);
      else complete = false;
    }
    return { calls, complete, stable };
  }

  function isWriteReference(reference) {
    function contains(node, target) {
      if (node === target) return true;
      if (!node) return false;
      let found = false;
      ts.forEachChild(node, (child) => {
        if (contains(child, target)) {
          found = true;
          return true;
        }
        return undefined;
      });
      return found;
    }
    let child = reference;
    for (let parent = reference.parent; parent; child = parent, parent = parent.parent) {
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment && contains(parent.left, reference)) return true;
      if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && contains(parent.initializer, reference)) return true;
      if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
          && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)
          && contains(parent.operand, reference)) return true;
      if (ts.isDeleteExpression(parent) && contains(parent.expression, reference)) return true;
      if (ts.isFunctionLike(parent) && parent !== nearestFunction(reference)) break;
      if (child === source) break;
    }
    return false;
  }

  function isExported(binding) {
    if (!binding) return true;
    const declaration = binding.declaration;
    if (declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
    if (ts.isVariableDeclaration(declaration)
        && declaration.parent?.parent?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
    return source.statements.some((statement) => ts.isExportDeclaration(statement)
      && statement.exportClause && ts.isNamedExports(statement.exportClause)
      && statement.exportClause.elements.some((element) => element.propertyName?.text === binding.name || element.name.text === binding.name));
  }

  return { nearestFunction, declarationsFor, bindingAt, bindingAtInOwner, references, functionBinding, resolveFunction, directCallSites, isExported };
}

export function resolveLocalTarget(receiver, call, { source, ts, lexical, targetBinding, canonicalBindingParts, unwrapExpression }) {
  let owner = call.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (!owner || !owner.body) return targetBinding(receiver);

  const direct = targetBinding(receiver);
  if (direct.targetStore !== "unknown") return direct;

  const declarations = lexical.declarationsFor(owner);
  const bindingAt = (identifier) => lexical.bindingAtInOwner(identifier, owner);
  function isEarlier(binding, reference) {
    return binding.declaration.end < reference.getStart(source);
  }
  function isEnvObject(identifier, wanted, resolving = new Set()) {
    const binding = bindingAt(identifier);
    if (binding?.declaration === wanted) return true;
    if (!binding || binding.ambiguous || binding.kind !== "const" || !ts.isVariableDeclaration(binding.declaration)
        || !binding.declaration.initializer || !isEarlier(binding, identifier) || resolving.has(binding.declaration)) return false;
    const initializer = unwrapExpression(binding.declaration.initializer);
    if (!initializer || !ts.isIdentifier(initializer) || hasWrites(binding.declaration)) return false;
    resolving.add(binding.declaration);
    const result = isEnvObject(initializer, wanted, resolving);
    resolving.delete(binding.declaration);
    return result;
  }
  function lhsWritesDeclaration(left, wanted) {
    const expression = unwrapExpression(left);
    if (!expression) return false;
    if (ts.isIdentifier(expression)) return bindingAt(expression)?.declaration === wanted.declaration;
    if (ts.isArrayLiteralExpression(expression) || ts.isObjectLiteralExpression(expression)) {
      return expression.elements?.some((element) => lhsWritesDeclaration(element, wanted))
        || expression.properties?.some((property) => ts.isShorthandPropertyAssignment(property)
          ? bindingAt(property.name)?.declaration === wanted.declaration
          : ts.isPropertyAssignment(property) && lhsWritesDeclaration(property.initializer, wanted)) || false;
    }
    if (ts.isSpreadElement(expression) || ts.isSpreadAssignment(expression)) return lhsWritesDeclaration(expression.expression, wanted);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const base = unwrapExpression(expression.expression);
      const property = ts.isPropertyAccessExpression(expression) ? expression.name.text
        : expression.argumentExpression && ts.isStringLiteral(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
      return (property === "CORE_DB" || property === "SEARCH_DB") && ts.isIdentifier(base)
        && wanted.kind === "parameter" && wanted.name === "env" && isEnvObject(base, wanted.declaration);
    }
    return false;
  }
  function hasWrites(wantedDeclaration) {
    const wanted = declarations.find((binding) => binding.declaration === wantedDeclaration);
    if (!wanted) return true;
    let written = false;
    function visitWrites(node) {
      if (node !== owner.body && ts.isFunctionLike(node) && !(wanted.kind === "parameter" && wanted.name === "env")) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && lhsWritesDeclaration(node.left, wanted)) written = true;
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && lhsWritesDeclaration(node.initializer, wanted)) written = true;
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
          && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
          && lhsWritesDeclaration(node.operand, wanted)) written = true;
      if (ts.isDeleteExpression(node) && lhsWritesDeclaration(node.expression, wanted)) written = true;
      ts.forEachChild(node, visitWrites);
    }
    visitWrites(owner.body);
    return written;
  }
  function resolveAlias(expressionNode, reference, resolving = new Set()) {
    const expression = unwrapExpression(expressionNode);
    const parts = canonicalBindingParts(expression);
    if (parts?.bindingName === "CORE_DB" || parts?.bindingName === "SEARCH_DB") {
      if (!ts.isIdentifier(parts.base)) return undefined;
      const baseBinding = bindingAt(parts.base);
      if (!baseBinding || baseBinding.ambiguous || baseBinding.kind !== "parameter" || baseBinding.name !== "env"
          || hasWrites(baseBinding.declaration)) return undefined;
      const resolved = targetBinding(expression);
      return resolved.targetStore === "unknown" ? undefined : { ...resolved, targetStatus: "resolved-local-const-alias" };
    }
    if (!expression || !ts.isIdentifier(expression)) return undefined;
    const binding = bindingAt(expression);
    if (!binding || binding.ambiguous || binding.kind !== "const" || !ts.isVariableDeclaration(binding.declaration)
        || !binding.declaration.initializer || !isEarlier(binding, reference) || resolving.has(binding.declaration)
        || hasWrites(binding.declaration)) return undefined;
    resolving.add(binding.declaration);
    const result = resolveAlias(binding.declaration.initializer, binding.declaration, resolving);
    resolving.delete(binding.declaration);
    return result;
  }
  return resolveAlias(receiver, call) ?? targetBinding(receiver);
}
