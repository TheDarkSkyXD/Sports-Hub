import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const app = join(root, 'app');
const components = join(root, 'components');
const storybook = join(root, '.storybook');
const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const compilerOptions = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;

async function tsxFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry => tsxFiles(join(directory, entry.name))));
  return [
    ...entries.filter(entry => entry.isFile() && entry.name.endsWith('.tsx')).map(entry => join(directory, entry.name)),
    ...nested.flat(),
  ];
}

function isValueImport(statement) {
  if (ts.isExportDeclaration(statement)) return !statement.isTypeOnly;
  if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) return false;
  const named = statement.importClause.namedBindings;
  return Boolean(statement.importClause.name) || !named || ts.isNamespaceImport(named)
    || named.elements.some(element => !element.isTypeOnly);
}

function localImports(source, from) {
  return source.statements.flatMap(statement => {
    if (!isValueImport(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return [];
    const resolved = ts.resolveModuleName(specifier, from, compilerOptions, ts.sys).resolvedModule;
    if (!resolved) return [];
    const path = resolve(resolved.resolvedFileName);
    return path.startsWith(`${root}${sep}`) && /\.tsx?$/.test(path) && !path.endsWith('.d.ts') && !path.endsWith('.stories.tsx') ? [path] : [];
  });
}

function importsComponent(source, component) {
  const expected = `./${basename(component, '.tsx')}`;
  const aliased = `@/${relative(root, component).replaceAll('\\', '/').slice(0, -4)}`;
  return source.statements.some(statement =>
    ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier)
    && [expected, aliased, `${expected}.tsx`, `${aliased}.tsx`].includes(statement.moduleSpecifier.text)
    && isValueImport(statement)
  );
}

function exportsStory(source) {
  const hasDefault = source.statements.some(statement => ts.isExportAssignment(statement) && !statement.isExportEquals);
  const hasNamed = source.statements.some(statement => ts.isVariableStatement(statement)
    && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
    && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name)));
  return hasDefault && hasNamed;
}

async function reachableComponents(start) {
  const queue = [...start];
  const visited = new Set();
  const result = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    if (file.startsWith(`${components}${sep}`) && file.endsWith('.tsx')) result.add(file);
    const content = await readFile(file, 'utf8');
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    queue.push(...localImports(source, file));
  }
  return result;
}

const usedComponents = await reachableComponents(await tsxFiles(app));
const storyFiles = [...await tsxFiles(components), ...await tsxFiles(storybook)]
  .filter(file => file.endsWith('.stories.tsx'));
const coveredComponents = await reachableComponents(storyFiles);
const missing = [];
for (const component of [...usedComponents].sort()) {
  if (!coveredComponents.has(component)) missing.push(`${relative(root, component)}: not imported by any product story`);
}
for (const story of storyFiles) {
  const content = await readFile(story, 'utf8');
  const source = ts.createSourceFile(story, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  if (story.startsWith(`${components}${sep}`)) {
    const component = story.slice(0, -'.stories.tsx'.length) + '.tsx';
    if (!usedComponents.has(component)) missing.push(`${relative(root, story)}: component is not used by the app`);
    if (!importsComponent(source, component)) missing.push(`${relative(root, story)}: missing value import of component`);
  }
  if (!exportsStory(source)) missing.push(`${relative(root, story)}: missing default metadata or named story export`);
}

if (missing.length) {
  console.error(missing.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Storybook covers all ${usedComponents.size} components used by the app across ${storyFiles.length} story modules.`);
}
