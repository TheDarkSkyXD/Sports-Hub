const path = require('node:path');
const { NsisUpdater: BaseNsisUpdater } = require('electron-updater');

// The installed electron-updater returns from doInstall before spawnLog settles.
// Keep the app alive until Windows accepts the installer process.
class DesktopNsisUpdater extends BaseNsisUpdater {
  constructor(options, app, beforeQuitForUpdate = () => require('electron').autoUpdater.emit('before-quit-for-update')) {
    super(options, app);
    this.beforeQuitForUpdate = beforeQuitForUpdate;
  }

  async doInstall(options) {
    const installerPath = this.installerPath;
    if (!installerPath) throw new Error('No downloaded installer is available. Download the update again.');

    const args = ['--updated'];
    if (options.isSilent) args.push('/S');
    if (options.isForceRunAfter) args.push('--force-run');
    const packagePath = this.downloadedUpdateHelper?.packageFile;
    if (packagePath) args.push(`--package-file=${packagePath}`);
    if (this.installDirectory) args.push(`/D=${this.installDirectory}`);

    const elevated = () => this.spawnLog(path.join(process.resourcesPath, 'elevate.exe'), [installerPath, ...args]);
    if (options.isAdminRightsRequired) {
      this._logger.info('isAdminRightsRequired is set to true, run installer using elevate.exe');
      return elevated();
    }
    try {
      return await this.spawnLog(installerPath, args);
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'UNKNOWN') return elevated();
      throw error;
    }
  }

  async quitAndInstall(isSilent = false, isForceRunAfter = false) {
    if (this.quitAndInstallCalled) return;
    try {
      const forceRun = isSilent ? isForceRunAfter : this.autoRunAppAfterInstall;
      if (!await this.install(isSilent, forceRun)) throw new Error('The installer could not be started.');
    } catch (error) {
      this.quitAndInstallCalled = false;
      throw error;
    }
    this.beforeQuitForUpdate();
    this.app.quit();
  }

  addQuitHandler() {
    if (this.quitHandlerAdded || !this.autoInstallOnAppQuit) return;
    this.quitHandlerAdded = true;
    this.app.onQuit(exitCode => {
      if (this.quitAndInstallCalled || !this.autoInstallOnAppQuit || exitCode !== 0) return;
      void Promise.resolve(this.install(true, false)).catch(error => {
        this._logger.error(`Auto install on quit failed: ${error}`);
      });
    });
  }
}

module.exports = { DesktopNsisUpdater };
