import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// On upgrade the old uninstaller rebuilds $INSTDIR from
// HKCU\${INSTALL_REGISTRY_KEY}\InstallLocation (multiUser.nsh setInstallModePerUser)
// and ignores the _?= path installUtil.nsh passes to it. When that value is
// missing the uninstaller falls back to the per-user default, removes nothing
// from the real install directory, and the installer reports the old files as
// still present. The installer has to record the directory the user chose.
const source = readFileSync(path.resolve('desktop', 'installer.nsh'), 'utf8');

const customInstall = source.match(/!macro customInstall\b[\s\S]*?!macroend/);
assert.ok(customInstall, 'desktop/installer.nsh must define customInstall to record the install location');

const body = customInstall[0].replace(/\s+/g, ' ');
assert.ok(body.includes('WriteRegStr'), 'customInstall must write the install location to the registry');
assert.ok(body.includes('INSTALL_REGISTRY_KEY'),
  'customInstall must use INSTALL_REGISTRY_KEY, the same key multiUser.nsh reads on uninstall');
assert.ok(body.includes('InstallLocation'),
  'customInstall must write the InstallLocation value multiUser.nsh reads on uninstall');
assert.ok(body.includes('$INSTDIR'),
  'customInstall must record $INSTDIR, the directory the user actually chose');
assert.ok(!/SHELL_CONTEXT/.test(body),
  'customInstall must target HKCU directly: SHELL_CONTEXT resolves against the shell context at run time');
assert.ok(
  source.indexOf('!macro customInstall') > source.indexOf('!ifndef BUILD_UNINSTALLER'),
  'customInstall belongs to the installer build, so it must sit inside the BUILD_UNINSTALLER block',
);
assert.match(source, /!ifndef BUILD_UNINSTALLER[\s\S]*\n!endif\s*$/,
  'the BUILD_UNINSTALLER block must still close the file');
assert.ok(!/customUnInit/.test(source),
  'customUnInit cannot recover the _?= path: NSIS core consumes it before .onInit, so it must be removed');

console.log('Installer records the chosen install directory for the uninstaller to find.');
