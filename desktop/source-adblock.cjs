const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {FiltersEngine,Request}=require('@ghostery/adblocker');

const types={mainFrame:'main_frame',subFrame:'sub_frame',xhr:'xmlhttprequest',webSocket:'websocket',cspReport:'csp_report'};
let engine;

function blocksSourceRequest(details,sourceUrl){
  engine??=FiltersEngine.deserialize(readFileSync(join(__dirname,'filters','network.bin')));
  let frameUrl;
  try{frameUrl=details.frame?.url;}catch{}
  return engine.match(Request.fromRawDetails({url:details.url,type:types[details.resourceType]||details.resourceType||'other',
    sourceUrl:frameUrl||details.referrer||sourceUrl||details.initiatorOrigin||''})).match;
}

module.exports={blocksSourceRequest};
