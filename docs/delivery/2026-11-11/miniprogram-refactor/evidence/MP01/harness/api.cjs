const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
// Run from repository root. Identity-only fixture; it does not register project routes.
const root = process.env.TIMENOOK_REPO || process.cwd();
const { createApplication } = require(root+'/apps/api/dist-test/src/application.js');
const { withWechatProfile } = require(root+'/apps/api/dist-test/test/wechat-profile-fixture.js');
const { PrismaClient } = require(root+'/apps/api/node_modules/@prisma/client');
const Redis = require(root+'/apps/api/node_modules/ioredis');
(async()=>{
 const schema='mp01_native_'+randomUUID().replaceAll('-','');
 const dbUrl=new URL(process.env.DATABASE_URL);dbUrl.searchParams.set('schema',schema);
 for(const url of [dbUrl,new URL(process.env.REDIS_URL)]) if(!['localhost','127.0.0.1'].includes(url.hostname)) throw Error('Expected loopback');
 const migration=spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{cwd:root+'/apps/api',env:{...process.env,DATABASE_URL:dbUrl.toString()},encoding:'utf8'});
 if(migration.status)throw Error('Migration failed');
 const app=await createApplication({environment:'test',host:'127.0.0.1',port:3419,databaseUrl:dbUrl.toString(),redisUrl:process.env.REDIS_URL,redisKeyPrefix:schema,wechat:{appId:'synthetic-mp01',secret:'synthetic-secret'}},{wechatFetch:withWechatProfile(async()=>new Response(JSON.stringify({openid:'synthetic-mp01-owner',session_key:'synthetic-session'})))});
 await app.listen({host:'127.0.0.1',port:3419});
 console.log('MP01 isolated API ready at loopback:3419');
 async function cleanup(){await app.close();const db=new PrismaClient({datasourceUrl:dbUrl.toString()});await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await db.$disconnect();const redis=new Redis(process.env.REDIS_URL);const keys=await redis.keys(schema+':*');if(keys.length)await redis.del(...keys);redis.disconnect();process.exit(0);}
 process.on('SIGINT',cleanup);process.on('SIGTERM',cleanup);
})();
