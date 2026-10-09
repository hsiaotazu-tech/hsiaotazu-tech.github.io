// sync.js — saves the trip on this device, or in Firebase when configured, and keeps shared trips in sync.
import {CONFIG} from './firebase-config.js';
const FB='https://www.gstatic.com/firebasejs/10.14.1/';
const A=window.__app;
const S=window.__sync={mode:'local',role:'owner',email:'',error:'',configured:!!CONFIG.apiKey&&!/^YOUR/.test(CONFIG.apiKey)};
let last={},ready=false,applying=false,timer=0,ctx=null,db,auth,F,AU,_idb;

const rnd=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');
const snap=()=>Object.fromEntries(A.keys().map(k=>[k,JSON.stringify(A.get(k))]));
const parse=o=>Object.fromEntries(Object.entries(o).map(([k,j])=>[k,JSON.parse(j)]));
const baseline=()=>{const c=snap();for(const k in c)if(!(k in last))last[k]=c[k]};
function applyRemote(js){
 applying=true;
 try{(A.apply(parse(js))||[]).forEach(k=>{last[k]=js[k]})}finally{applying=false}
}

/* ---- on-device storage (IndexedDB) ---- */
const idb=()=>_idb||(_idb=new Promise((ok,no)=>{const r=indexedDB.open('trip-planner',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)}));
const tx=async(mode,fn)=>{const d=await idb();return new Promise((ok,no)=>{const t=d.transaction('kv',mode),r=fn(t.objectStore('kv'));t.oncomplete=()=>ok(r&&r.result);t.onerror=()=>no(t.error)})};
const idbSet=(k,v)=>tx('readwrite',s=>s.put(v,k));
const idbAll=async()=>{const ks=await tx('readonly',s=>s.getAllKeys()),vs=await tx('readonly',s=>s.getAll());return Object.fromEntries(ks.map((k,i)=>[k,vs[i]]))};

/* ---- saving: only the pieces that changed ---- */
S.commit=()=>{if(!ready||applying||(S.mode==='cloud'&&S.role==='viewer'))return;clearTimeout(timer);timer=setTimeout(flush,600)};
async function flush(){
 const cur=snap(),prev=S.error;
 if(prev.startsWith('Too large'))S.error='';
 for(const [k,j] of Object.entries(cur)){
  if(last[k]===j)continue;
  if(j.length>900000){S.error='Too large to sync: '+k+'. Use a smaller photo.';continue}
  last[k]=j;
  if(S.mode==='cloud'&&ctx)F.setDoc(F.doc(db,'trips',ctx.tid,'data',k),{j,by:ctx.uid,t:F.serverTimestamp()}).catch(e=>{delete last[k];console.warn(e)});
  else try{await idbSet(k,j)}catch(e){delete last[k];console.warn(e)}
 }
 if(S.error!==prev)A.status();
}
S.rebase=()=>{last={};clearTimeout(timer);flush()};
S.mark=(k,j)=>{last[k]=j};
addEventListener('pagehide',()=>{clearTimeout(timer);if(ready)flush()});

/* ---- start-up ---- */
async function localInit(){
 S.mode='local';ctx=null;
 try{applyRemote(await idbAll())}catch(e){console.warn(e)}
 baseline();ready=true;
}
async function openTrip(u,tid){
 const m=await F.getDoc(F.doc(db,'trips',tid,'members',u.uid));   // throws if you are not a member
 if(!m.exists())throw new Error('not a member');
 ctx={tid,uid:u.uid};S.role=m.data().role;S.mode='cloud';S.email=u.email||'';
 F.setDoc(F.doc(db,'users',u.uid),{tripId:tid},{merge:true}).catch(()=>{});
 await new Promise(res=>{
  let first=true;
  const done=()=>{if(first){first=false;baseline();ready=true;res()}};
  F.onSnapshot(F.collection(db,'trips',tid,'data'),s=>{
   const js={};
   s.docChanges().forEach(c=>{
    if(c.type==='removed'||c.doc.metadata.hasPendingWrites)return;
    const j=c.doc.data().j;if(typeof j!=='string'||j===last[c.doc.id])return;
    js[c.doc.id]=j;
   });
   if(Object.keys(js).length)applyRemote(js);
   done();
  },e=>{console.warn(e);done()});
 });
}
async function cloudInit(join){
 const [{initializeApp},au,fs]=await Promise.all([import(FB+'firebase-app.js'),import(FB+'firebase-auth.js'),import(FB+'firebase-firestore.js')]);
 AU=au;F=fs;
 const app=initializeApp(CONFIG);auth=au.getAuth(app);
 db=fs.initializeFirestore(app,{localCache:fs.persistentLocalCache({tabManager:fs.persistentMultipleTabManager()})});
 try{await au.getRedirectResult(auth)}catch(e){console.warn(e)}
 let u=await new Promise(r=>{const off=au.onAuthStateChanged(auth,x=>{off();r(x)})});
 if(join){                                   // someone opened a share link
  const [,tid,token,role]=join;
  u=u||(await au.signInAnonymously(auth)).user;
  try{await fs.setDoc(fs.doc(db,'trips',tid,'members',u.uid),{token,role,name:u.displayName||'Guest',joinedAt:fs.serverTimestamp()})}catch(e){console.warn('join',e.code)}
  history.replaceState(null,'',location.pathname+location.search);
  return openTrip(u,tid);
 }
 if(!u)return localInit();
 const ud=await fs.getDoc(fs.doc(db,'users',u.uid));
 if(ud.exists()&&ud.data().tripId)return openTrip(u,ud.data().tripId);
 if(u.isAnonymous)return localInit();
 // first Google sign-in: create the trip from what is on this device
 try{applyRemote(await idbAll())}catch(e){}
 const tid=rnd(),cur=snap(),b1=fs.writeBatch(db);
 b1.set(fs.doc(db,'trips',tid),{owner:u.uid,name:A.get('trip').dest,createdAt:fs.serverTimestamp()});
 b1.set(fs.doc(db,'trips',tid,'members',u.uid),{role:'owner',name:u.displayName||'',joinedAt:fs.serverTimestamp()});
 b1.set(fs.doc(db,'users',u.uid),{tripId:tid},{merge:true});
 await b1.commit();
 const b2=fs.writeBatch(db);
 for(const [k,j] of Object.entries(cur)){b2.set(fs.doc(db,'trips',tid,'data',k),{j,by:u.uid,t:fs.serverTimestamp()});last[k]=j}
 await b2.commit();
 return openTrip(u,tid);
}
async function init(){
 const m=location.hash.match(/join=(\w+)\.(\w+)\.(editor|viewer)/);
 try{ if(S.configured)await cloudInit(m);else await localInit() }
 catch(e){
  console.error(e);
  S.error=m?'This link is invalid or has been revoked.':'Sync problem ('+(e.code||e.message)+').';
  S.mode='local';S.role='owner';ctx=null;
  if(!ready)try{await localInit()}catch(_){ready=true}
 }
 S.inited=true;A.status();
}

/* ---- sign-in and sharing (cloud only) ---- */
const need=()=>{if(!AU)throw new Error('Cloud sync is unavailable right now. Check your connection.')};
S.signIn=async()=>{need();const p=new AU.GoogleAuthProvider();
 try{await AU.signInWithPopup(auth,p)}
 catch(e){
  if(e.code==='auth/popup-closed-by-user'||e.code==='auth/cancelled-popup-request')return;
  if(/popup|not-supported/.test(e.code||'')){await AU.signInWithRedirect(auth,p);return}
  throw e}
 location.reload()};
S.signOut=async()=>{need();await AU.signOut(auth);location.reload()};
const lnk=(t,r)=>location.origin+location.pathname+'#join='+ctx.tid+'.'+t+'.'+r;
S.invite=async role=>{const t=rnd();await F.setDoc(F.doc(db,'trips',ctx.tid,'invites',t),{role,createdAt:F.serverTimestamp()});return lnk(t,role)};
S.invites=async()=>(await F.getDocs(F.collection(db,'trips',ctx.tid,'invites'))).docs.map(d=>({id:d.id,role:d.data().role,link:lnk(d.id,d.data().role)}));
S.revoke=id=>F.deleteDoc(F.doc(db,'trips',ctx.tid,'invites',id));
S.members=async()=>(await F.getDocs(F.collection(db,'trips',ctx.tid,'members'))).docs.map(d=>({uid:d.id,role:d.data().role,name:d.data().name}));
S.kick=uid=>F.deleteDoc(F.doc(db,'trips',ctx.tid,'members',uid));
S.leave=async()=>{await F.deleteDoc(F.doc(db,'trips',ctx.tid,'members',ctx.uid));await F.deleteDoc(F.doc(db,'users',ctx.uid)).catch(()=>{});location.reload()};

init();
