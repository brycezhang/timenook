const x=require('./native.cjs');const assert=require('node:assert/strict');
x.step('native cross-chapter add moves saved story and its answered question together',()=>{
 const original=x.readPlan();const storyId=original.chapters.find(c=>c.key==='childhood').storyRefs[0];const questionKey=original.answers.find(a=>a.storyId===storyId).questionKey;
 x.tool('automation_navigate',{action:'navigateTo',url:'/pages/chapter-outline/index?projectId='+x.projectId+'&chapter=learning'});x.page('chapter-outline');x.tap('.story-tab');x.tap('.tn-dock .tn-button');x.page('chapter-stories');x.tap('#add-'+storyId);x.page('chapter-stories',d=>d.selected.some(s=>s.id===storyId));
 let plan=x.readPlan();assert.ok(plan.chapters.find(c=>c.key==='learning').storyRefs.includes(storyId));assert.ok(!plan.chapters.find(c=>c.key==='childhood').storyRefs.includes(storyId));assert.equal(plan.answers.find(a=>a.storyId===storyId).chapterKey,'learning');assert.ok(plan.chapters.find(c=>c.key==='learning').questions.some(q=>q.key===questionKey));
 x.tool('simulator_screenshot',{path:x.evidence+'/CrossChapterStory-390.png',optimize:false});
 x.back();x.page('chapter-outline');x.tap('.question-tab');const chapter=x.page('chapter-outline');assert.ok(chapter.questions.some(q=>q.id===questionKey&&q.state==='已回答'));
 x.tool('simulator_screenshot',{path:x.evidence+'/CrossChapterQuestion-390.png',optimize:false});
 // Return through the same public membership UI so both direction changes persist.
 x.tool('automation_navigate',{action:'navigateTo',url:'/pages/chapter-outline/index?projectId='+x.projectId+'&chapter=childhood'});x.page('chapter-outline');x.tap('.story-tab');x.tap('.tn-dock .tn-button');x.page('chapter-stories');x.tap('#add-'+storyId);x.page('chapter-stories',d=>d.selected.some(s=>s.id===storyId));plan=x.readPlan();assert.equal(plan.answers.find(a=>a.storyId===storyId).chapterKey,'childhood');assert.ok(plan.chapters.find(c=>c.key==='childhood').questions.some(q=>q.key===questionKey));
});
