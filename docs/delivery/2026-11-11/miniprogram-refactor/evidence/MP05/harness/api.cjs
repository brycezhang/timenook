// Run from a built repository with --env-file=.env. Supplier responses are synthetic;
// chapter/story commands and persistence use the real application and loopback DB.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const repo=process.cwd();
const api=require(path.join(repo,'apps/api/dist-test/test/book-fixture.js'));
let stopping=false,privateDir;
async function stop(code=0){if(stopping)return;stopping=true;await api.stopBookFixture();if(privateDir)await fs.rm(privateDir,{recursive:true,force:true});process.exit(code);}
(async()=>{
 process.chdir(path.join(repo,'apps/api'));
 await api.startBookFixture();
 const p=await api.readyStory();
 await api.readyStory(p,{questionKey:'childhood-02'});
 await api.readyStory(p,{starterKind:'free-narration'});
 await api.app.listen(3422,'127.0.0.1');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'timenook-mp05-private-'));
 privateDir=dir;await fs.chmod(dir,0o700);
 const state=path.join(dir,'session.json');
 await fs.writeFile(state,JSON.stringify({projectId:p.projectId,base:'http://127.0.0.1:3422/v1',session:{user:{id:p.narrator.id},session:{id:p.narrator.sessionId,token:p.narrator.token,expiresAt:new Date(Date.now()+3600000).toISOString()}}}),{mode:0o600});
 console.log(JSON.stringify({ready:true,projectId:p.projectId,base:'http://127.0.0.1:3422/v1',privateSessionFile:state}));
 process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
})().catch(async()=>{console.error('MP05 fixture startup failed');await stop(1);});
