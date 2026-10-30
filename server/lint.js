// Static checks for AI-written game modules: syntax errors and identifiers that are used
// but never declared (typos, leftovers, wrong variable names). Runs instantly, costs nothing.
import * as acorn from "acorn";
import * as walk from "acorn-walk";

const GLOBALS = new Set(["Math", "JSON", "Number", "String", "Boolean", "Array", "Object", "Infinity", "NaN", "undefined", "isFinite", "isNaN",
  "parseInt", "parseFloat", "Set", "Map", "WeakMap", "Symbol", "Date", "Error", "TypeError", "RangeError", "console", "Float32Array", "Uint8Array",
  "Int32Array", "Promise", "Reflect", "globalThis", "arguments", "structuredClone"]);
const FORBIDDEN = { Math_random: "Use api.rand() (seeded) instead of Math.random()", document: "No DOM access in game code", window: "No window access in game code", fetch: "No network access in game code" };

function patternNames(p, out = []) {
  if (!p) return out;
  if (p.type === "Identifier") out.push(p.name);
  else if (p.type === "ObjectPattern") for (const q of p.properties) patternNames(q.type === "RestElement" ? q.argument : q.value, out);
  else if (p.type === "ArrayPattern") for (const q of p.elements) patternNames(q, out);
  else if (p.type === "AssignmentPattern") patternNames(p.left, out);
  else if (p.type === "RestElement") patternNames(p.argument, out);
  return out;
}
const isFn = (n) => n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ArrowFunctionExpression";

export function lintGame(code) {
  let ast;
  try { ast = acorn.parse(code, { ecmaVersion: "latest", sourceType: "module", locations: true }); }
  catch (e) { return [`Syntax error at line ${e.loc?.line}: ${e.message}`]; }
  // Declarations, treated as function-scoped (lenient: avoids false alarms, still catches typos).
  const scopes = new Map([[ast, new Set()]]);
  const scopeOf = (ancestors) => { for (let i = ancestors.length - 1; i >= 0; i--) if (scopes.has(ancestors[i])) return scopes.get(ancestors[i]); return scopes.get(ast); };
  walk.fullAncestor(ast, (node, _s, anc) => {
    if (isFn(node)) {
      const set = new Set(); scopes.set(node, set);
      for (const p of node.params) patternNames(p).forEach((n) => set.add(n));
      if (node.type === "FunctionExpression" && node.id) set.add(node.id.name);
    }
  });
  walk.fullAncestor(ast, (node, _s, anc) => {
    const parentScope = () => scopeOf(anc.slice(0, -1));
    if (node.type === "VariableDeclarator") patternNames(node.id).forEach((n) => parentScope().add(n));
    else if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) scopeOf(anc.slice(0, -1)).add(node.id.name);
    else if (node.type === "CatchClause" && node.param) patternNames(node.param).forEach((n) => parentScope().add(n));
    else if (node.type === "ImportSpecifier" || node.type === "ImportDefaultSpecifier" || node.type === "ImportNamespaceSpecifier") scopes.get(ast).add(node.local.name);
  });
  const problems = new Map(), lines = code.split("\n");
  const note = (k, msg) => { if (!problems.has(k)) problems.set(k, msg); };
  walk.fullAncestor(ast, (node, _s, anc) => {
    if (node.type === "ImportDeclaration") note("import", `Line ${node.loc.start.line}: imports are not allowed — use api.THREE and the api object.`);
    if (node.type === "MemberExpression" && node.object.type === "Identifier" && node.object.name === "Math" && node.property.name === "random") note("Math.random", `Line ${node.loc.start.line}: ${FORBIDDEN.Math_random}.`);
    if (node.type !== "Identifier") return;
    const parent = anc[anc.length - 2];
    if (!parent) return;
    if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && parent.key === node && !parent.computed && !(parent.shorthand && parent.value === node)) return;
    if (parent.type === "Property" && parent.shorthand && anc[anc.length - 3]?.type === "ObjectPattern") return;
    if (["LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent.type)) return;
    if (parent.type === "ExportSpecifier" && parent.exported === node) return;
    if (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(parent.type)) return;
    if (parent.type === "VariableDeclarator" && parent.id === node) return;
    if ((isFn(parent) || parent.type === "ClassDeclaration" || parent.type === "ClassExpression") && parent.id === node) return;
    if (isFn(parent) && parent.params.includes(node)) return;
    if (anc.some((a) => (a.type === "ObjectPattern" || a.type === "ArrayPattern" || a.type === "AssignmentPattern" || a.type === "RestElement") && (anc.some((b) => b.type === "VariableDeclarator" && b.id === a) || anc.some((b) => isFn(b) && b.params.includes(a))))) {
      if (!(parent.type === "AssignmentPattern" && parent.right === node)) return;
    }
    const name = node.name;
    if (GLOBALS.has(name)) return;
    if (FORBIDDEN[name]) return note(name, `Line ${node.loc.start.line}: ${FORBIDDEN[name]}.`);
    for (let i = anc.length - 1; i >= 0; i--) if (scopes.get(anc[i])?.has(name)) return;
    const src = lines[node.loc.start.line - 1]?.trim().slice(0, 140);
    const hint = name === "api" || name === "dt" ? ` It is not in scope here: add "${name}" as a parameter of this function and pass it from the caller.` : "";
    note(name, `Line ${node.loc.start.line}: "${name}" is used but never declared, in: \`${src}\`.${hint}`);
  });
  if (!/export\s+function\s+setup/.test(code)) note("setup", "Missing `export function setup(api)`.");
  if (!/export\s+function\s+update/.test(code)) note("update", "Missing `export function update(api, dt)`.");
  return [...problems.values()].slice(0, 25);
}
