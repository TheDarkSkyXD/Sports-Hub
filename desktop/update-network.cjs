const {ElectronHttpExecutor,getNetSession}=require('electron-updater/out/electronHttpExecutor');
const {HttpExecutor}=require('builder-util-runtime');
const semver=require('semver');

function denied(){return new Error('Update request is outside the selected GitHub repository release.');}
function repository(feed){
  const match=/^https:\/\/github\.com(\/[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9._-]{1,100})\/releases\/latest\/download$/.exec(feed);
  if(!match)throw denied();return match[1];
}
function secureUrl(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)throw denied();
  return url;
}
function requestUrl(options){
  if(options.protocol!=='https:'||options.auth||options.port&&String(options.port)!=='443'||options.host&&options.hostname&&options.host!==options.hostname)throw denied();
  if(Object.keys(options.headers||{}).some(key=>key.toLowerCase()==='host'))throw denied();
  return secureUrl(`https://${options.hostname||options.host}${options.path||'/'}`);
}

class GitHubUpdateExecutor extends ElectronHttpExecutor{
  constructor({getSession=getNetSession,request=options=>require('electron').net.request(options),login}={}){
    super(login);this.getSession=getSession;this.netRequest=request;
    this.contexts=new WeakMap();this.redirects=new WeakMap();this.pending=new Set();this.epoch=0;
  }
  setFeed(feed){this.repo=repository(feed);this.feed=feed;this.release=null;this.epoch++;}
  admitRelease(info,files){
    if(!this.repo||!semver.valid(info.version)||info.packages||files.length!==1)throw new Error('Update installer metadata is not supported.');
    const name=`Sunday-Room-${info.version}-Setup-x64.exe`,file=files[0],url=secureUrl(file.url);
    const validPath=url.pathname===`${this.repo}/releases/latest/download/${name}`||url.pathname===`${this.repo}/releases/download/v${info.version}/${name}`;
    const checksum=file.info.sha512;
    if(file.packageInfo||url.hostname!=='github.com'||url.search||!validPath||typeof checksum!=='string'||Buffer.from(checksum,'base64').length!==64||Buffer.from(checksum,'base64').toString('base64')!==checksum)throw new Error('Update installer must belong to the selected repository and include SHA512.');
    if(info.path&&new URL(info.path,this.feed+'/').href!==url.href||info.sha512&&info.sha512!==checksum)throw new Error('Update installer metadata conflicts.');
    this.release=Object.freeze({name,version:info.version,url:url.href,sha512:checksum});return this.release;
  }
  initial(url){
    if(url.hostname!=='github.com')throw denied();
    if(url.pathname===`${this.repo}/releases/latest/download/latest.yml`&&(!url.search||/^\?noCache=[a-z0-9]{1,32}$/.test(url.search)))return 'metadata';
    if(this.release&&url.href===this.release.url)return 'installer';
    throw denied();
  }
  redirected(url,context){
    if(url.hostname==='release-assets.githubusercontent.com')return;
    if(url.hostname!=='github.com'||url.search)throw denied();
    const prefix=`${this.repo}/releases/download/`;
    if(!url.pathname.startsWith(prefix))throw denied();
    const parts=url.pathname.slice(prefix.length).split('/');
    if(parts.length!==2||!semver.valid(parts[0]))throw denied();
    if(context.role==='metadata'?parts[1]!=='latest.yml':!this.release||parts[0]!==`v${this.release.version}`||parts[1]!==this.release.name)throw denied();
  }
  createRequest(options,callback){
    const url=requestUrl(options),grant=this.redirects.get(options);this.redirects.delete(options);
    const context=grant||{epoch:this.epoch,role:this.initial(url),depth:0,url:url.href};
    if(context.epoch!==this.epoch||context.url!==url.href||!['GET','HEAD'].includes(options.method||'GET'))throw denied();
    this.contexts.set(options,context);
    if(!this.cachedSession){
      this.cachedSession=this.getSession();
      this.cachedSession.webRequest.onBeforeRequest((details,respond)=>{
        const permit=[...this.pending].find(item=>item.epoch===this.epoch&&(item.id===details.id||item.id===null&&item.url===details.url));
        const allowed=permit&&permit.url===details.url&&['GET','HEAD'].includes(details.method);
        if(allowed)permit.id=details.id;
        respond({cancel:!allowed});
      });
    }
    if(this.pending.size>=16)throw denied();
    const permit={url:url.href,epoch:this.epoch,id:null};this.pending.add(permit);
    let result;
    try{result=this.netRequest({...options,redirect:'manual',session:this.cachedSession});}
    catch(error){this.pending.delete(permit);throw error;}
    const release=()=>this.pending.delete(permit);
    result.on('response',response=>{response.once('end',release);response.once('error',release);response.once('aborted',release);callback(response);});
    result.once('abort',release);result.once('error',release);
    if(this.proxyLoginCallback)result.on('login',this.proxyLoginCallback);
    return result;
  }
  addRedirectHandlers(request,options,reject,_redirectCount,handler){
    request.on('redirect',(status,method,value)=>{
      request.abort();
      try{
        const previous=this.contexts.get(options),url=secureUrl(value);
        if(!previous||previous.epoch!==this.epoch||previous.depth>=8||![301,302,303,307,308].includes(status)||!['GET','HEAD'].includes(method))throw denied();
        if(new URL(previous.url).hostname!=='github.com')throw denied();
        this.redirected(url,previous);
        const next=HttpExecutor.prepareRedirectUrlOptions(value,options);
        this.redirects.set(next,{...previous,url:url.href,depth:previous.depth+1});
        handler(next);
      }catch(error){reject(error);}
    });
  }
}
module.exports={GitHubUpdateExecutor};
