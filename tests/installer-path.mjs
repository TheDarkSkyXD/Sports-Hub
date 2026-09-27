import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows.js');

const appBuilderPath = path.dirname(require.resolve('app-builder-lib/package.json'));
const includePath = path.join(appBuilderPath, 'templates', 'nsis', 'include');
const assistedPath = path.join(appBuilderPath, 'templates', 'nsis', 'assistedInstaller.nsh');
const installerPath = path.resolve('desktop', 'installer.nsh');
const assistedSource = readFileSync(assistedPath, 'utf8');
const upstreamCallback = assistedSource.match(/Function instFilesPre\r?\n[\s\S]*?FunctionEnd/)?.[0];
assert.ok(upstreamCallback, 'electron-builder assisted installer callback was not found');

const cases = [
  ['parent only', 'C:\\Selected', 'C:\\Selected\\Sunday Room'],
  ['name in ancestor', 'C:\\Sunday Room\\Games', 'C:\\Sunday Room\\Games\\Sunday Room'],
  ['name inside ancestor', 'C:\\Sunday Room Archives', 'C:\\Sunday Room Archives\\Sunday Room'],
  ['partial leaf', 'C:\\Selected\\Sunday Roomer', 'C:\\Selected\\Sunday Roomer\\Sunday Room'],
  ['matching leaf', 'C:\\Selected\\Sunday Room', 'C:\\Selected\\Sunday Room'],
  ['matching leaf with separator', 'C:\\Selected\\Sunday Room\\', 'C:\\Selected\\Sunday Room'],
  ['matching leaf with case difference', 'C:\\Selected\\sUnDaY rOoM\\', 'C:\\Selected\\sUnDaY rOoM'],
  ['drive root', 'C:\\', 'C:\\Sunday Room'],
  ['UNC share', '\\\\server\\share\\', '\\\\server\\share\\Sunday Room'],
  ['spaces', 'C:\\My Games\\Football', 'C:\\My Games\\Football\\Sunday Room'],
];

const scratch = mkdtempSync(path.resolve('installer-path-probe-'));
const nsisPath = path.join(scratch, 'probe.nsi');
const executablePath = path.join(scratch, 'probe.exe');
const resultPath = path.join(scratch, 'results.txt');
const nsisQuote = (value) => value.replaceAll('"', '$\\"');
const nsisSource = [
  'Unicode true',
  'Name "Installer path probe"',
  'RequestExecutionLevel user',
  `OutFile "${nsisQuote(executablePath)}"`,
  'SilentInstall silent',
  '!define APP_FILENAME "Sunday Room"',
  `!addincludedir "${nsisQuote(includePath)}"`,
  '!include LogicLib.nsh',
  '!include StrContains.nsh',
  'Var updatedFlag',
  '!macro _isUpdated _a _b _t _f',
  '  StrCmp $updatedFlag "1" `${_t}` `${_f}`',
  '!macroend',
  '!define isUpdated `"" isUpdated ""`',
  '!define MUI_PAGE_CUSTOMFUNCTION_PRE instFilesPre',
  upstreamCallback,
  `!include "${nsisQuote(installerPath)}"`,
  '!insertmacro customPageAfterChangeDir',
  '!insertmacro customHeader',
  'Section',
  `  FileOpen $9 "${nsisQuote(resultPath)}" w`,
  '  StrCpy $updatedFlag 0',
  '  StrCpy $INSTDIR "C:\\Sunday Room Archives"',
  '  Call instFilesPre',
  '  FileWrite $9 "baseline|$INSTDIR$\\r$\\n"',
  ...cases.flatMap(([name, input]) => [
    `  StrCpy $INSTDIR "${nsisQuote(input)}"`,
    '  Call ${MUI_PAGE_CUSTOMFUNCTION_PRE}',
    `  FileWrite $9 "${name}|$INSTDIR$\\r$\\n"`,
    '  Call ${MUI_PAGE_CUSTOMFUNCTION_PRE}',
    `  FileWrite $9 "${name} repeated|$INSTDIR$\\r$\\n"`,
  ]),
  '  StrCpy $updatedFlag 1',
  '  StrCpy $INSTDIR "C:\\Legacy Install"',
  '  Call ${MUI_PAGE_CUSTOMFUNCTION_PRE}',
  '  FileWrite $9 "update|$INSTDIR$\\r$\\n"',
  '  FileClose $9',
  'SectionEnd',
].join('\n');

try {
  writeFileSync(nsisPath, nsisSource);
  const nsis = await getMakeNsisPath();
  execFileSync(nsis.path, [nsisPath], { stdio: 'pipe', env: { ...process.env, ...nsis.env } });
  const escapedExecutable = executablePath.replaceAll("'", "''");
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$probe = Start-Process -FilePath '${escapedExecutable}' -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden; exit $probe.ExitCode`], { stdio: 'pipe', timeout: 30000 });
  const actual = readFileSync(resultPath, 'utf8').trim().split(/\r?\n/);
  const expected = [
    'baseline|C:\\Sunday Room Archives',
    ...cases.flatMap(([name, , result]) => [`${name}|${result}`, `${name} repeated|${result}`]),
    'update|C:\\Legacy Install',
  ];
  assert.deepEqual(actual, expected);
  console.log('Upstream baseline keeps C:\\Sunday Room Archives without the app leaf.');
  console.log(`Production NSIS callback passed ${cases.length} paths, repeat calls, and update preservation.`);
} finally {
  if (process.env.KEEP_NSIS_PROBE !== '1') {
    assert.ok(scratch.startsWith(`${path.resolve('.')}${path.sep}`));
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
}
