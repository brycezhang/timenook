const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const project=process.env.TIMENOOK_NATIVE_PROJECT;
if(!project || !path.isAbsolute(project))throw Error('Set TIMENOOK_NATIVE_PROJECT to the isolated built-package project');
const projectId=process.env.TIMENOOK_NATIVE_PROJECT_ID;
if(!projectId)throw Error('Set TIMENOOK_NATIVE_PROJECT_ID to the isolated business project');
const evidence=process.env.TIMENOOK_NATIVE_EVIDENCE || path.join(project,'evidence');
fs.mkdirSync(evidence,{recursive:true});
const resultsFile=path.join(evidence,'cli-results.json');
function tool(name,args={}) {
 const flags=Object.entries(args).flatMap(([k,v])=>['--'+k,typeof v==='object'?JSON.stringify(v):String(v)]);
 const out=execFileSync('wechatide',['-c','Codex',name,'--project',project,...flags],{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
 const data=JSON.parse(out.slice(out.indexOf('{')));if(!data.ok)throw Error(`${name}: ${data.errorType||data.message}`);
 fs.appendFileSync(path.join(evidence,'cli-actions.jsonl'),JSON.stringify({tool:name,args,result:data.result})+'\n');
 return data.result;
}
function evaluate(fn,args){const result=tool('automation_evaluate',{'fn-source':args?'function(){return ('+String(fn)+')(...'+JSON.stringify(args)+');}':String(fn)});return result.result.result;}
function tap(selector){return tool('automation_element_action',{selector,action:'tap','wait-for-selector':selector});}
function input(selector,value){return tool('automation_element_action',{selector,action:'input',value,'wait-for-selector':selector});}
function data(){return evaluate(function(){const p=getCurrentPages().slice(-1)[0];const d=p.data;return {route:p.route,data:{busy:d.busy,loading:d.loading,pageLoading:d.pageLoading,status:d.status,title:d.title,text:d.text,tab:d.tab,questions:d.questions,selected:d.selected,available:d.available,overview:!!d.overview,interview:d.interview?{actualQuestion:d.interview.actualQuestion}:null}};});}
function page(name,predicate=()=>true){for(let n=0;n<15;n++){const v=data();if(v.route===`pages/${name}/index`&&!v.data.pageLoading&&!v.data.busy&&!v.data.loading&&predicate(v.data)){if(name!=='interview')assert.ok(!v.data.status,v.data.status);return v.data;}}throw Error(`Page ${name} not ready`);}
function back(){tool('automation_navigate',{action:'navigateBack',delta:1});}
function directory(){if(data().route!=='pages/home/index'){tool('automation_navigate',{action:'switchTab',url:'/pages/home/index'});}page('home',d=>!!d.overview);tap('.book-entry');page('book');tap('.directory-entry');page('directory');}
function openChapter(){throw Error('Use the native simulator/CUA to click the sort-list chapter, then run chapter capture; CLI selectors cannot enter this custom component');}
function readPlan(){return evaluate(function(projectId){return new Promise((resolve,reject)=>{const base='http://127.0.0.1:3422/v1';const session=wx.getStorageSync('timenook.session.v1:'+base);wx.request({url:base+'/projects/'+projectId+'/plan',header:{Authorization:'Bearer '+session.session.token},success:r=>r.statusCode===200?resolve({revision:r.data.data.revision,chapters:r.data.data.chapters,answers:r.data.data.answers}):reject(Error(String(r.statusCode))),fail:reject});});},[projectId]);}
function snap(name,width){const info=evaluate(function(){return wx.getWindowInfo();});assert.equal(info.windowWidth,width);const rects=evaluate(function(){return new Promise(resolve=>wx.createSelectorQuery().select('.tn-page').boundingClientRect().select('.tn-dock').boundingClientRect().exec(resolve));});assert.ok(rects[0].width<=width);if(rects[1]){assert.ok(rects[1].width<=width);assert.ok(rects[1].top>=150);}tool('simulator_screenshot',{path:path.join(evidence,`${name}-${width}.png`),optimize:false,'wait-for-selector':'.tn-page'});console.log(`CAPTURE ${name} ${width}`);}
function step(name,fn){let result;try{fn();result={name,passed:true};}catch(e){result={name,passed:false,error:e.message};throw e;}finally{const rows=fs.existsSync(resultsFile)?JSON.parse(fs.readFileSync(resultsFile)):[];rows.push(result);fs.writeFileSync(resultsFile,JSON.stringify(rows,null,2));}console.log('PASS '+name);}
function capture(){const width=evaluate(function(){return wx.getWindowInfo().windowWidth;});assert.ok([390,320].includes(width));step('six native pages '+width,()=>{directory();snap('BookDirectory',width);openChapter();snap('ChapterOutline',width);tap('#question-childhood-03');page('question');snap('QuestionDetail',width);tap('.outline-between .tn-link');page('question-edit');snap('QuestionEdit',width);back();page('question');back();page('chapter-outline');tap('.outline-between .tn-link');page('chapter');snap('ChapterEdit',width);tap('.chapter-story-link');page('chapter-stories');snap('ChapterStories',width);});}
module.exports={tool,evaluate,tap,input,page,data,back,directory,openChapter,readPlan,snap,step,capture,project,evidence,projectId};
if(require.main===module){if(process.argv[2]==='capture')throw Error('Use directory capture, a native chapter click, then chapter capture');}

function captureChapter(){const width=evaluate(function(){return wx.getWindowInfo().windowWidth;});step('five chapter pages '+width,()=>{page('chapter-outline');snap('ChapterOutline',width);tap('#question-childhood-03');page('question');snap('QuestionDetail',width);tap('.outline-between .tn-link');page('question-edit');snap('QuestionEdit',width);back();page('question');back();page('chapter-outline');tap('.outline-between .tn-link');page('chapter');snap('ChapterEdit',width);tap('.chapter-story-link');page('chapter-stories');snap('ChapterStories',width);});}
module.exports.captureChapter=captureChapter;
if(require.main===module&&process.argv[2]==='chapter')captureChapter();
function verify(){step('native chapter title and body, question edit and actual interview entry persist',()=>{
 page('chapter-stories');back();page('chapter');
 const before=readPlan();const storyId=before.chapters.find(c=>c.key==='childhood').storyRefs[0];
 input('.tn-input','我的童年与家乡');input('.chapter-body','我记得童年，院子里有一棵树。');tap('.tn-dock .tn-button');
 let d=page('chapter-outline');assert.equal(d.title,'我的童年与家乡');assert.equal(readPlan().chapters.find(c=>c.key==='childhood').title,d.title);
 const story=evaluate(function(projectId,storyId){return new Promise((resolve,reject)=>{const base='http://127.0.0.1:3422/v1';const s=wx.getStorageSync('timenook.session.v1:'+base);wx.request({url:base+'/projects/'+projectId+'/stories/'+storyId,header:{Authorization:'Bearer '+s.session.token},success:r=>r.statusCode===200?resolve(r.data.data.revision.paragraphs.map(p=>p.text)):reject(Error(String(r.statusCode))),fail:reject});});},[projectId,storyId]);assert.ok(story.includes('我记得童年，院子里有一棵树。'));
 tap('#question-childhood-03');page('question');tap('.outline-between .tn-link');page('question-edit');input('.outline-textarea','童年里，谁陪伴我最多？');tap('.tn-dock .tn-button');d=page('question');assert.equal(d.text,'童年里，谁陪伴我最多？');assert.equal(readPlan().chapters.find(c=>c.key==='childhood').questions.find(q=>q.key==='childhood-03').text,d.text);
 tap('.tn-dock .tn-button');d=page('interview',d=>!!d.interview);assert.equal(d.interview.actualQuestion.questionKey,'childhood-03');assert.equal(d.interview.actualQuestion.snapshot.text,'童年里，谁陪伴我最多？');
 tool('simulator_screenshot',{path:path.join(evidence,'QuestionToRecording-390.png'),optimize:false});
 });}
module.exports.verify=verify;
if(require.main===module&&process.argv[2]==='verify')verify();
