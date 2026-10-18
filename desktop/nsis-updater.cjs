const path = require('node:path');
const fs = require('node:fs');
const {createHash}=require('node:crypto');
const { NsisUpdater: BaseNsisUpdater } = require('electron-updater');
const {GitHubUpdateExecutor}=require('./update-network.cjs');

async function validArtifact(helper,release,file){
  if(!release||helper.packageFile||file!==path.join(helper.cacheDirForPendingUpdate,release.name))throw new Error('Installer is outside the admitted update cache.');
  const [root,actual,stat]=await Promise.all([fs.promises.realpath(helper.cacheDirForPendingUpdate),fs.promises.realpath(file),fs.promises.lstat(file)]);
  if(!stat.isFile()||stat.isSymbolicLink()||actual!==path.join(root,release.name))throw new Error('Installer cache path is invalid.');
  const hash=createHash('sha512');
  for await(const chunk of fs.createReadStream(file))hash.update(chunk);
  if(hash.digest('base64')!==release.sha512)throw new Error('Installer SHA512 does not match the admitted release.');
}

// The installed electron-updater returns from doInstall before spawnLog settles.
// Keep the app alive until Windows accepts the installer process.
class DesktopNsisUpdater extends BaseNsisUpdater {
  constructor(options, app, beforeQuitForUpdate = () => require('electron').autoUpdater.emit('before-quit-for-update'), quitEvents=app||require('electron').app) {
    super(undefined, app);
    this.httpExecutor=new GitHubUpdateExecutor({login:(authInfo,callback)=>this.emit('login',authInfo,callback)});
    this.disableWebInstaller=true;
    this.disableDifferentialDownload=true;
    this.securedHelpers=new WeakSet();
    if(options)this.setFeedURL(options);
    this.beforeQuitForUpdate = beforeQuitForUpdate;
    this.quitEvents=quitEvents;
  }

  setFeedURL(options){
    if(typeof options!=='string'&&options.provider!=='generic')throw new Error('Updates require a GitHub repository release.');
    this.httpExecutor.setFeed(typeof options==='string'?options:options.url);
    return super.setFeedURL(options);
  }

  async doDownloadUpdate(options){
    const {info,provider}=options.updateInfoAndProvider;
    this.httpExecutor.admitRelease(info,provider.resolveFiles(info));
    return super.doDownloadUpdate({...options,disableWebInstaller:true,disableDifferentialDownload:true});
  }

  async getOrCreateDownloadHelper(){
    const helper=await super.getOrCreateDownloadHelper();
    if(!this.securedHelpers.has(helper)){
      this.securedHelpers.add(helper);
      helper.validateDownloadedPath=async(file,info,fileInfo)=>{
        const release=this.httpExecutor.admitRelease(info,[fileInfo]);
        if(file!==path.join(helper.cacheDirForPendingUpdate,release.name))throw new Error('Installer cache filename is invalid.');
        try{
          const metadataFile=path.join(helper.cacheDirForPendingUpdate,'update-info.json');
          if((await fs.promises.stat(metadataFile)).size>16_384)return null;
          const metadata=JSON.parse(await fs.promises.readFile(metadataFile,'utf8'));
          if(metadata?.fileName!==release.name||metadata.sha512!==release.sha512)return null;
          await validArtifact(helper,release,file);
          return file;
        }catch{return null;}
      };
    }
    return helper;
  }

  async doInstall(options) {
    const installerPath = this.installerPath;
    if (!installerPath) throw new Error('No downloaded installer is available. Download the update again.');
    const helper=this.downloadedUpdateHelper,release=this.httpExecutor.release;
    if(!release||helper.downloadedFileInfo?.fileName!==release.name||helper.downloadedFileInfo.sha512!==release.sha512)throw new Error('Installer has no admitted release metadata.');
    await validArtifact(helper,release,installerPath);

    const args = ['--updated'];
    if (options.isSilent) args.push('/S');
    if (options.isForceRunAfter) args.push('--force-run');
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
    (this.quitEvents||this.app).on('before-quit',event => {
      if(this.autoQuitPending){event.preventDefault();return;}
      if(event.defaultPrevented||this.quitAndInstallCalled||!this.autoInstallOnAppQuit)return;
      event.preventDefault();this.autoQuitPending=true;
      void Promise.resolve().then(()=>this.install(true,false)).then(installed=>{
        if(!installed)throw new Error('The installer could not be started.');
        this.autoQuitPending=false;this.app.quit();
      }).catch(error => {
        this.autoQuitPending=false;this.quitAndInstallCalled=false;
        this._logger.error(`Auto install on quit failed: ${error}`);
      });
    });
  }
}

module.exports = { DesktopNsisUpdater };
