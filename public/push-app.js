(()=>{
 const enable=document.getElementById('push-enable'),disable=document.getElementById('push-disable'),test=document.getElementById('push-test'),status=document.getElementById('push-status');
 const supported='serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
 let registration,token=null,timer;const tokenKey='my-trade-push-token';
 try{token=localStorage.getItem(tokenKey);}catch{}
 const message=text=>status.textContent=text;
 const api=async(path,method='GET',body)=>{const r=await fetch('/api/push/'+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});const j=await r.json();if(!r.ok)throw Error(j.error||'Notification service unavailable');return j;};
 async function refresh(){
  if(!token)return;
  try{
   const r=await ready,sub=await r.pushManager.getSubscription();
   if(Notification.permission!=='granted'||!sub){message('Browser alerts are disabled on this device. Enable notifications or change this site’s permission in browser settings.');enable.hidden=false;disable.hidden=false;test.hidden=true;return;}
   const s=await api('status');disable.hidden=false;test.hidden=!s.active;
   if(s.active){message('Background signal alerts enabled on this device. Only fresh, newly saved signals are eligible; opening an alert rechecks the live entry.');enable.hidden=true;clearInterval(timer);}
   else if(s.pending)message('Saving this device securely… allow up to 3 minutes. Keep this page open until enabled.');
   else{message('This device is not registered. Enable notifications to reconnect it.');enable.hidden=false;}
  }catch{message('Could not confirm alert registration. Reopen this page when connected.');}
 }
 if(!supported){enable.disabled=true;message('Background push is unavailable in this browser. On iPhone/iPad, add the site to your Home Screen, then open that app to enable notifications.');return;}
 // Register ahead of the permission click to preserve the user gesture on Safari.
 const ready=navigator.serviceWorker.register('/sw.js',{scope:'/'}).then(()=>navigator.serviceWorker.ready).then(r=>{registration=r;return r;});ready.catch(()=>message('Notification setup failed; reload over a secure connection.'));
 enable.addEventListener('click',async()=>{
  enable.disabled=true;
  try{
   // Permission is requested only by this explicit device action.
   const permission=await Notification.requestPermission();if(permission!=='granted')throw Error('Notifications were not allowed. Change this site’s notification permission in browser settings to enable alerts.');
   const r=await ready,c=await api('config');if(!c.available)throw Error('Notification storage is warming; retry shortly.');
   let sub=await r.pushManager.getSubscription();
   if(sub&&!token){await sub.unsubscribe();sub=null;}
   const bytes=Uint8Array.from(atob(c.publicKey.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-c.publicKey.length%4)%4)),c=>c.charCodeAt(0));
   sub||=await r.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
   const result=await api('subscribe','POST',{subscription:sub.toJSON()});token=result.token;
   try{localStorage.setItem(tokenKey,token);}catch{throw Error('Allow browser storage to keep your device registration; alerts may need re-enabling after reload.');}
   await refresh();clearInterval(timer);timer=setInterval(refresh,10000);
  }catch(e){message(e.message);}finally{enable.disabled=false;}
 });
 disable.addEventListener('click',async()=>{
  disable.disabled=true;try{const r=await ready,sub=await r.pushManager.getSubscription();if(sub)await sub.unsubscribe();await api('unsubscribe','POST',{});localStorage.removeItem(tokenKey);token=null;clearInterval(timer);enable.hidden=false;disable.hidden=true;test.hidden=true;message('Notifications disabled on this device.');}catch{message('Could not finish removing the registration. Retry Disable notifications.');}finally{disable.disabled=false;}
 });
 test.addEventListener('click',async()=>{try{await(await ready).showNotification('My Trade Engine · device test',{body:'Device notifications work. This is a local test, not a trading signal or a server delivery test.',tag:'device-test',icon:'/app-icon.svg'});}catch{message('Device notifications are blocked; check browser and system settings.');}});
 if(token){refresh();timer=setInterval(refresh,10000);}
})();
