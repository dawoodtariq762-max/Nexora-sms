'use strict';
const VERSION='2026.11.12-chat.1';
self.addEventListener('install',()=>{/* Wait for explicit Update when replacing an active worker. */});
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')self.skipWaiting();if(e.data?.type==='GET_VERSION')e.source?.postMessage({type:'CHAT_VERSION',version:VERSION});});
// Intentionally no response cache: neither chat HTML, API data nor uploaded
// files are persisted in a shared service-worker cache.
self.addEventListener('fetch',()=>{});
function rememberPush(id){
 return new Promise(resolve=>{
  const open=indexedDB.open('nx-chat-notification-receipts',1);
  open.onupgradeneeded=()=>open.result.createObjectStore('seen');
  open.onerror=()=>resolve(true);
  open.onsuccess=()=>{const db=open.result,tx=db.transaction('seen','readwrite'),store=tx.objectStore('seen');let fresh=true;const key=String(id),get=store.get(key);get.onsuccess=()=>{if(get.result){fresh=false;return;}store.put(Date.now(),key);const keys=store.getAllKeys();keys.onsuccess=()=>{const sorted=keys.result.sort((a,b)=>Number(a)-Number(b));while(sorted.length>1000)store.delete(sorted.shift());};};tx.oncomplete=()=>{db.close();resolve(fresh);};tx.onerror=()=>{db.close();resolve(true);};};
 });
}
self.addEventListener('push',e=>{e.waitUntil((async()=>{let d;try{d=e.data.json();}catch(_){return;}const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});if(windows.some(w=>w.visibilityState==='visible'&&new URL(w.url).pathname.startsWith('/chat-app/')))return;if(!Number.isSafeInteger(d.id)||!Number.isSafeInteger(d.conversation_id)||!await rememberPush(d.id))return;await self.registration.showNotification(d.title||'NEXORA Chat',{body:d.body||'New message',icon:'/assets/pwa/icon-192.png',badge:'/assets/pwa/icon-192.png',tag:'nx-chat-message-'+d.id,data:{url:'/chat-app/?conversation='+encodeURIComponent(d.conversation_id)},renotify:false});})());});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil((async()=>{let url=e.notification.data?.url||'/chat-app/';if(!/^\/chat-app\/\?conversation=\d+$/.test(url))url='/chat-app/';for(const c of await self.clients.matchAll({type:'window',includeUncontrolled:true})){if(new URL(c.url).pathname.startsWith('/chat-app/')){await c.navigate(url);return c.focus();}}return self.clients.openWindow(url);})());});
