function claimAlert(id,expiresAt){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('my-trade-alerts',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('seen');
    request.onerror=()=>reject(Error('Alert storage unavailable'));
    request.onsuccess=()=>{
      const db=request.result,tx=db.transaction('seen','readwrite'),store=tx.objectStore('seen');let fresh=false;
      const read=store.get(id);read.onsuccess=()=>{if(!read.result){store.put(expiresAt,id);fresh=true;}};
      const cursor=store.openCursor();cursor.onsuccess=()=>{const c=cursor.result;if(c){if(c.value<=Date.now())c.delete();c.continue();}};
      tx.oncomplete=()=>{db.close();resolve(fresh);};tx.onerror=()=>{db.close();reject(Error('Alert storage unavailable'));};
    };
  });
}
// No fetch handler or dashboard cache: live entry checks always use the network.
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let p;try{p=event.data.json();}catch{return;}
    if(!p||typeof p.id!=='string'||typeof p.title!=='string'||typeof p.body!=='string'||!Number.isFinite(p.expiresAt)||!Number.isFinite(p.sentAt)||p.expiresAt<=Date.now()||p.sentAt>Date.now()+5000)return;
    if(!await claimAlert(p.id,p.expiresAt))return;
    await self.registration.showNotification(p.title,{body:p.body,tag:p.id,renotify:false,icon:'/app-icon.svg',data:{url:'/'}});
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();event.waitUntil((async()=>{
    const list=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of list)if(new URL(client.url).origin===self.location.origin){await client.navigate('/');return client.focus();}
    return self.clients.openWindow('/');
  })());
});
