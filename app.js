// Narrow device + animated boot + menu + on-screen controls

let app, db;
let pc, localStream, micTrack, roomRef, roomId;
let isCaller = false, talking = false;

let peerId = Math.random().toString(36).slice(2,8);
let peersUnsub = null, heartbeatTimer = null;

let ui = { state:'off', menuIndex:0, menu:[
  { key:'walkie',   icon:'📻', label:'Walkie Talkie' },
  { key:'settings', icon:'⚙️', label:'Settings' }
]};
let volume = 1.0;                // 0..1
const STEP_VOL = 0.1;

const rtcConfig = { iceServers: [{ urls:["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302"] }] };
const $ = (id)=>document.getElementById(id);

function showScreen(id){ document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active')); $(id).classList.add('active'); }
function setMenu(i){ const m=ui.menu.length; ui.menuIndex=((i%m)+m)%m; $('#menuIcon').textContent=ui.menu[ui.menuIndex].icon; $('#menuLabel').textContent=ui.menu[ui.menuIndex].label; }

function updateHttp(){ const secure = location.protocol==='https:' || location.hostname==='localhost'; const el=$('#lcdHttp'); if(el) el.textContent = secure?'HTTPS':'HTTP'; }
function setMicState(ok){ const el=$('#lcdMic'); if(el) el.textContent = ok?'OK':'—'; }
function setVolume(v){ volume=Math.max(0,Math.min(1,v)); const a=$('#remoteAudio'); if(a) a.volume=volume; const d=$('#lcdVolume'); if(d) d.textContent=Math.round(volume*10); }
function setChannelText(v){ $('#lcdChannel').textContent = v||'—'; $('#lcdRoom').textContent = v||'—'; }

function bootType(el, text, delay=45){
  return new Promise(res=>{
    let i=0; el.textContent="";
    const cur=document.createElement('span'); cur.className='cursor'; cur.textContent='|'; el.appendChild(cur);
    const timer=setInterval(()=>{
      if(i<text.length){ cur.insertAdjacentText('beforebegin', text[i++]); }
      else{ clearInterval(timer); cur.remove(); res(); }
    }, delay);
  });
}

function powerOn(){
  if (ui.state!=='off') return;
  ui.state='boot';
  $('#powerBtn').classList.add('on');
  document.querySelector('.device').classList.remove('off');
  $('#status').textContent='Power on.';
  showScreen('screen-splash');
  // Animated splash
  (async ()=>{
    updateHttp(); setMicState(false); setVolume(volume);
    const l1 = $('#type1'), l2 = $('#type2');
    await bootType(l1, 'Walkie-Talkie', 55);
    await new Promise(r=>setTimeout(r, 220));
    await bootType(l2, 'By Praggie', 55);
    await new Promise(r=>setTimeout(r, 260));
    ui.state='menu'; showScreen('screen-menu'); setMenu(0);
  })();
}
function powerOff(){
  $('#powerBtn').classList.remove('on');
  document.querySelector('.device').classList.add('off');
  $('#status').textContent='Powered off.';
  ui.state='off';
  try{ if (micTrack) micTrack.stop(); }catch(e){}
  try{ if (pc){ pc.getSenders()?.forEach(s=>s.track && s.track.stop()); pc.close(); } }catch(e){}
  if (heartbeatTimer) clearInterval(heartbeatTimer), heartbeatTimer=null;
  if (peersUnsub) { try{ peersUnsub(); }catch(e){} peersUnsub=null; }
  $('#pttBtn').disabled = true;
  updateLCD({link:false});
  $('#lcdCount').textContent='0'; $('#lcdPeer').textContent='—'; setMicState(false);
}

window.addEventListener('DOMContentLoaded', async () => {
  // Power first (works offline)
  $('#powerBtn').addEventListener('click', ()=> (ui.state==='off'? powerOn(): powerOff()));

  // D-pad
  $('#padLeft').onclick  = ()=> onNav('left');
  $('#padRight').onclick = ()=> onNav('right');
  $('#padUp').onclick    = ()=> onNav('up');
  $('#padDown').onclick  = ()=> onNav('down');
  $('#padOk').onclick    = ()=> onNav('ok');
  // Keyboard arrows
  document.addEventListener('keydown', (e)=>{
    if (!['menu','dash','settings'].includes(ui.state)) return;
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Enter'].includes(e.key)) e.preventDefault();
    if (e.key==='ArrowLeft')  onNav('left');
    if (e.key==='ArrowRight') onNav('right');
    if (e.key==='ArrowUp')    onNav('up');
    if (e.key==='ArrowDown')  onNav('down');
    if (e.key==='Enter')      onNav('ok');
  });

  // Hidden buttons still used by logic
  $('#createBtn').onclick = ()=> start(true);
  $('#joinBtn').onclick   = ()=> start(false);

  // PTT
  const ptt=$('#pttBtn');
  ptt.addEventListener('mousedown', beginTalk);
  ptt.addEventListener('touchstart', beginTalk, {passive:true});
  window.addEventListener('mouseup', endTalk);
  window.addEventListener('touchend', endTalk, {passive:true});
  window.addEventListener('keydown', (e)=>{ if (e.code==='Space'){ e.preventDefault(); beginTalk(); }});
  window.addEventListener('keyup',   (e)=>{ if (e.code==='Space'){ e.preventDefault(); endTalk();   }});

  // Keypad digits → channel text
  [...document.querySelectorAll('[data-digit]')].forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const v = ($('#roomId').value||"") + btn.dataset.digit;
      $('#roomId').value = v.replace(/\D/g,'');
      setChannelText($('#roomId').value);
    });
  });
  $('#clear').addEventListener('click', ()=>{ $('#roomId').value=""; setChannelText(""); });
  $('#set').addEventListener('click',  ()=>{ $('#status').textContent = `Channel set to ${$('#roomId').value||"0"}. Use Create/Join to connect.`; });

  // Firebase
  try{ app=firebase.initializeApp(firebaseConfig); db=firebase.firestore(); }catch(e){ console.warn('Firebase init issue:',e); }
});

/* D-PAD behavior */
function onNav(dir){
  if (ui.state==='menu'){
    if (dir==='left')  setMenu(ui.menuIndex-1);
    if (dir==='right') setMenu(ui.menuIndex+1);
    if (dir==='ok'){
      const item = ui.menu[ui.menuIndex];
      if (item.key==='walkie'){ ui.state='dash'; showScreen('screen-dash'); $('#status').textContent='Walkie dashboard.'; }
      if (item.key==='settings'){ ui.state='settings'; showSettings(); }
    }
    return;
  }
  if (ui.state==='dash'){
    if (dir==='up')   setVolume(volume + STEP_VOL);
    if (dir==='down') setVolume(volume - STEP_VOL);
    if (dir==='left')  nudgeChannel(-1);
    if (dir==='right') nudgeChannel(+1);
    if (dir==='ok'){ /* reserved for future (e.g., PTT latch) */ }
    return;
  }
  if (ui.state==='settings'){
    if (dir==='left' || dir==='right'){ ui.state='menu'; showScreen('screen-menu'); setMenu(ui.menuIndex); $('#status').textContent=''; }
    if (dir==='ok'){ ui.state='menu'; showScreen('screen-menu'); }
  }
}

function nudgeChannel(delta){
  let s = ($('#roomId').value||"0").replace(/\D/g,'') || "0";
  try{ s = (BigInt(s) + BigInt(delta)); if (s<0n) s=0n; $('#roomId').value = s.toString(); }catch{}
  setChannelText($('#roomId').value);
}

/* Core connect */
async function start(create){
  if (ui.state==='off'){ $('#status').textContent='Turn on power first.'; return; }
  if (!db){ $('#status').textContent='Waiting for Firebase… check internet/config.'; return; }

  try{
    $('#status').textContent="Status: Requesting microphone...";
    localStream = await navigator.mediaDevices.getUserMedia({
      audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1 },
      video:false
    });
    setMicState(true);
    micTrack = localStream.getAudioTracks()[0];

    pc = new RTCPeerConnection(rtcConfig);
    micTrack.enabled = false; pc.addTrack(micTrack, localStream);

    const remoteAudio = $('#remoteAudio');
    if (remoteAudio) remoteAudio.volume = volume;
    pc.addEventListener('track', (ev)=>{ remoteAudio.srcObject = ev.streams[0]; });

    if (create){
      roomId = ($('#roomId').value || '').replace(/\D/g,'') || String(Math.floor(1000 + Math.random()*9000));
      roomRef = db.collection('rooms').doc(roomId);
      await roomRef.set({ created: firebase.firestore.FieldValue.serverTimestamp(), who: ($('#displayName').value||"Caller") });

      const callerCands = roomRef.collection('callerCandidates');
      pc.addEventListener('icecandidate', (e)=>{ if(e.candidate) callerCands.add(e.candidate.toJSON()); });

      const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:false });
      await pc.setLocalDescription(offer);
      await roomRef.update({ offer:{ type:offer.type, sdp:offer.sdp } });

      roomRef.onSnapshot(async (snap)=>{
        const data = snap.data();
        if (!pc.currentRemoteDescription && data?.answer){
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          $('#status').textContent = `Connected. Room ${roomId}`;
          $('#pttBtn').disabled = false;
          updateLCD({link:true, room: roomId});
          startPresence();
        }
      });

      roomRef.collection('calleeCandidates').onSnapshot((q)=>{
        q.docChanges().forEach((chg)=>{ if (chg.type==='added') pc.addIceCandidate(new RTCIceCandidate(chg.doc.data())); });
      });

      isCaller = true;
      $('#status').textContent = `Room created: ${roomId}. Waiting for partner…`;
      setChannelText(roomId);
      ui.state='dash'; showScreen('screen-dash');

    } else {
      roomId = ($('#roomId').value || '').replace(/\D/g,'');
      if (!roomId){ err("Enter the room code to join."); return; }

      roomRef = db.collection('rooms').doc(roomId);
      const roomSnap = await roomRef.get();
      if (!roomSnap.exists){ err("Room not found. Ask your friend to Create first."); return; }

      const calleeCands = roomRef.collection('calleeCandidates');
      pc.addEventListener('icecandidate', (e)=>{ if(e.candidate) calleeCands.add(e.candidate.toJSON()); });

      const data = roomSnap.data();
      if (!data?.offer){ err("Room has no offer yet. Wait a moment and try again."); return; }
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await roomRef.update({ answer:{ type:answer.type, sdp:answer.sdp }, joiner: ($('#displayName').value||"Joiner") });

      roomRef.collection('callerCandidates').onSnapshot((q)=>{
        q.docChanges().forEach((chg)=>{ if (chg.type==='added') pc.addIceCandidate(new RTCIceCandidate(chg.doc.data())); });
      });

      $('#status').textContent = `Connected. Room ${roomId}`;
      $('#pttBtn').disabled = false;
      updateLCD({link:true, room: roomId});
      startPresence();
      isCaller = false;
      ui.state='dash'; showScreen('screen-dash');
    }
  }catch(e){ err(e.message||String(e)); }
}

/* Presence (peers / names) */
function startPresence(){
  if (!roomRef) return;
  const name = ($('#displayName').value || (isCaller ? "Caller" : "Joiner"));
  const myRef = roomRef.collection('peers').doc(peerId);

  myRef.set({ name, lastSeen: firebase.firestore.FieldValue.serverTimestamp() }, { merge:true });

  heartbeatTimer && clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(()=>{ myRef.update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{}); }, 15000);

  peersUnsub && peersUnsub();
  peersUnsub = roomRef.collection('peers').onSnapshot(snap=>{
    const now = Date.now(); const peers=[];
    snap.forEach(doc=>{
      const d=doc.data()||{}; const alive = d.lastSeen?.toDate ? (now - d.lastSeen.toDate().getTime() < 45000) : true;
      if (alive) peers.push({ id:doc.id, name:d.name||"User" });
    });
    const you = peers.find(p=>p.id===peerId);
    const others = peers.filter(p=>p.id!==peerId);
    $('#lcdCount').textContent = String(peers.length);
    $('#lcdYou').textContent   = you ? you.name : "—";
    $('#lcdPeer').textContent  = others[0]?.name || (peers.length>1 ? "Peer" : "—");
  });

  window.addEventListener('beforeunload', ()=>{ try{ roomRef.collection('peers').doc(peerId).delete(); }catch(e){} }, {once:true});
}

/* LCD helpers */
function updateLCD({link, room}){
  if (typeof link==='boolean'){ $('#linkDot').classList.toggle('off', !link); }
  if (room != null){ setChannelText(String(room).replace(/\D/g,'')); }
}

/* PTT */
function beginTalk(){ if (ui.state==='off') return; if (!pc||!micTrack) return; if (talking) return;
  talking=true; micTrack.enabled=true; $('#pttBtn').classList.add('talking'); $('#pttBtn').textContent="TRANSMITTING… (hold)"; }
function endTalk(){ if (ui.state==='off') return; if (!pc||!micTrack) return; if (!talking) return;
  talking=false; micTrack.enabled=false; $('#pttBtn').classList.remove('talking'); $('#pttBtn').textContent="HOLD TO TALK"; }

/* Errors */
function err(msg){ $('#errors').textContent = msg; console.error(msg); $('#pttBtn').disabled = true; }
