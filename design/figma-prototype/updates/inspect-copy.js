async function inspect(){
 const page=await figma.getNodeByIdAsync('0:1');await figma.setCurrentPageAsync(page);
 const roots=page.findAll(n=>n.type==='FRAME'&&/^[A-Z]\d\d ·/.test(n.name));
 const data=roots.map(r=>({id:r.id,name:r.name,nodes:r.findAll(n=>n.type==='TEXT'||n.type==='FRAME'||n.type==='INSTANCE').map(n=>({id:n.id,parent:n.parent.id,type:n.type,name:n.name,text:n.type==='TEXT'?n.characters:undefined,visible:n.visible,x:n.x,y:n.y,w:n.width,h:n.height,size:n.type==='TEXT'?n.fontSize:undefined,properties:n.type==='INSTANCE'?n.componentProperties:undefined,reactions:'reactions'in n?n.reactions:undefined}))}));
 figma.showUI('<html><body style="font:18px system-ui;padding:20px"><h3>读取页面文字</h3><button id="d">下载文字清单</button><script>let data;onmessage=e=>data=e.data.pluginMessage;d.onclick=()=>{let a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:"application/json"}));a.download="timenook-copy-before.json";a.click();};</script></body></html>',{width:400,height:200});figma.ui.postMessage(data);
}inspect().catch(e=>figma.closePlugin(String(e)));
