const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const project=process.env.TIMENOOK_NATIVE_PROJECT;
if(!project || !path.isAbsolute(project))throw Error('Set TIMENOOK_NATIVE_PROJECT to an isolated built-package project');
const evidence=process.env.TIMENOOK_NATIVE_EVIDENCE || path.resolve('test-results/miniprogram-refactor/MP01');
fs.mkdirSync(evidence,{recursive:true});
function tool(name,args={}) {
 const flags=Object.entries(args).flatMap(([k,v])=>['--'+k,typeof v==='object'?JSON.stringify(v):String(v)]);
 const out=execFileSync('wechatide',['-c','Codex',name,'--project',project,...flags],{encoding:'utf8',timeout:45000,maxBuffer:8*1024*1024});
 const data=JSON.parse(out.slice(out.indexOf('{')));if(!data.ok)throw Error(JSON.stringify(data));
 fs.appendFileSync(path.join(evidence,'actions.jsonl'),JSON.stringify({tool:name,args,result:data.result})+'\n');
 return data.result;
}
function tap(selector){return tool('automation_element_action',{selector,action:'tap','wait-for-selector':selector});}
function snap(name,selector){return tool('simulator_screenshot',{path:path.join(evidence,name+'.png'),optimize:false,'wait-for-selector':selector});}
function evaluate(fn){return tool('automation_evaluate',{'fn-source':fn});}
function install(){return evaluate('function(){wx.login=function(o){o.success({code:"mp01-native-"+Date.now(),errMsg:"login:ok"});}; return {width:wx.getWindowInfo().windowWidth,height:wx.getWindowInfo().windowHeight};}');}
module.exports={tool,tap,snap,evaluate,install};
