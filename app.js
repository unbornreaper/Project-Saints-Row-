'use strict';
/* WBWHO Save Editor. Runs fully in the browser; files never leave the device. */

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (typeof n === 'number' && Number.isInteger(n)) ? n.toLocaleString('en-US') : String(n);
const hex = (n, w = 0) => n.toString(16).toUpperCase().padStart(w, '0');
const spot = o => `#${fmt(o)} <span class="tiny">(0x${hex(o)})</span>`;
const view = d => new DataView(d.buffer, d.byteOffset, d.byteLength);

const S = {
  name: null,        // file name (kept exactly when saving)
  raw: null,         // the file exactly as opened
  data: null,        // what we edit (unpacked if the file was packed)
  wrap: null,        // info about packing (compression)
  csInner: null,     // check code found inside the data
  csOuter: null,     // check code found on the outer file
  undo: [],
  isDemo: false,
  hits: [], findName: 'Money', findEmoji: '💰',
  cmpA: null, cmpB: null, diffs: [],
  hexOff: 0, sel: null, words: null, changed: new Set(),
};

/* ---------------- value types ---------------- */
const TYPES = {
  u8:  { size: 1, label: '1 box',  get: (v, o) => v.getUint8(o),        set: (v, o, x) => v.setUint8(o, x),        min: 0, max: 255, safe: 99 },
  u16: { size: 2, label: '2 boxes', get: (v, o) => v.getUint16(o, true), set: (v, o, x) => v.setUint16(o, x, true), min: 0, max: 65535, safe: 9999 },
  u32: { size: 4, label: '4 boxes', get: (v, o) => v.getUint32(o, true), set: (v, o, x) => v.setUint32(o, x, true), min: 0, max: 4294967295, safe: 999999999 },
  i32: { size: 4, label: '4 boxes (can be minus)', get: (v, o) => v.getInt32(o, true), set: (v, o, x) => v.setInt32(o, x, true), min: -2147483648, max: 2147483647, safe: 999999999 },
  u64: { size: 8, label: '8 boxes', get: (v, o) => Number(v.getBigUint64(o, true)), set: (v, o, x) => v.setBigUint64(o, BigInt(x), true), min: 0, max: Number.MAX_SAFE_INTEGER, safe: 999999999 },
  f32: { size: 4, label: 'decimal (4 boxes)', get: (v, o) => v.getFloat32(o, true), set: (v, o, x) => v.setFloat32(o, x, true), min: -3.4e38, max: 3.4e38, safe: 999999, float: true },
  f64: { size: 8, label: 'decimal (8 boxes)', get: (v, o) => v.getFloat64(o, true), set: (v, o, x) => v.setFloat64(o, x, true), min: -1e300, max: 1e300, safe: 999999, float: true },
};
function readVal(d, off, type) {
  const t = TYPES[type];
  if (!d || off < 0 || off + t.size > d.length) return null;
  return t.get(view(d), off);
}
function niceVal(x, type) {
  if (x === null) return '—';
  if (TYPES[type].float) return String(Math.round(x * 1000) / 1000);
  return fmt(x);
}

/* ---------------- little helpers ---------------- */
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.innerHTML = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
function readFile(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(new Uint8Array(r.result));
    r.onerror = () => rej(r.error);
    r.readAsArrayBuffer(file);
  });
}
function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function parseNum(s) {
  s = String(s || '').trim().replace(/[,\s$]/g, '');
  if (!s) return NaN;
  if (/^-?0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
  return Number(s);
}

/* ---------------- check codes (CRC32) ---------------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(d, a, b) { let c = 0xFFFFFFFF; for (let i = a; i < b; i++) c = CRC_T[(c ^ d[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function detectChecksum(d) {
  if (!d || d.length < 16) return null;
  const v = view(d), n = d.length;
  const tail = crc32(d, 0, n - 4);
  if (tail === v.getUint32(n - 4, true)) return { where: 'end', le: true };
  if (tail === v.getUint32(n - 4, false)) return { where: 'end', le: false };
  const head = crc32(d, 4, n);
  if (head === v.getUint32(0, true)) return { where: 'start', le: true };
  if (head === v.getUint32(0, false)) return { where: 'start', le: false };
  return null;
}
function fixChecksum(d, cs) {
  if (!cs) return;
  const v = view(d), n = d.length;
  if (cs.where === 'end') v.setUint32(n - 4, crc32(d, 0, n - 4), cs.le);
  else v.setUint32(0, crc32(d, 4, n), cs.le);
}

/* ---------------- packed (compressed) files ---------------- */
async function streamBytes(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
async function tryUnpack(raw) {
  if (typeof DecompressionStream === 'undefined') return null;
  const tries = [];
  if (raw[0] === 0x1F && raw[1] === 0x8B) tries.push({ off: 0, fmt: 'gzip' });
  for (let o = 0; o < Math.min(512, raw.length - 2); o++) {
    if (raw[o] === 0x78 && [0x01, 0x5E, 0x9C, 0xDA].includes(raw[o + 1]) && ((raw[o] << 8) | raw[o + 1]) % 31 === 0) tries.push({ off: o, fmt: 'deflate' });
  }
  for (const t of tries.slice(0, 12)) {
    try {
      const inner = await streamBytes(raw.subarray(t.off), new DecompressionStream(t.fmt));
      if (inner.length < 32) continue;
      // Numbers in the header that hold the sizes, so we can update them later.
      const sizeFields = [];
      const pv = view(raw), packed = raw.length - t.off;
      for (let i = 0; i + 4 <= t.off; i += 4) {
        for (const le of [true, false]) {
          if (sizeFields.some(f => f.i === i)) break;
          const x = pv.getUint32(i, le);
          if (x === packed) sizeFields.push({ i, le, what: 'packed' });
          else if (x === inner.length) sizeFields.push({ i, le, what: 'unpacked' });
          else if (x === raw.length) sizeFields.push({ i, le, what: 'file' });
        }
      }
      return { inner, wrap: { ...t, prefix: raw.slice(0, t.off), sizeFields } };
    } catch (e) { /* not packed here */ }
  }
  return null;
}
async function repack(inner, wrap) {
  const packed = await streamBytes(inner, new CompressionStream(wrap.fmt));
  const out = new Uint8Array(wrap.prefix.length + packed.length);
  out.set(wrap.prefix, 0); out.set(packed, wrap.prefix.length);
  const v = view(out);
  for (const f of wrap.sizeFields) {
    const x = f.what === 'packed' ? packed.length : f.what === 'unpacked' ? inner.length : out.length;
    v.setUint32(f.i, x, f.le);
  }
  return out;
}

/* ---------------- "is it locked?" ---------------- */
function entropy(d) {
  const n = Math.min(d.length, 1 << 18); if (!n) return 0;
  const c = new Uint32Array(256); for (let i = 0; i < n; i++) c[d[i]]++;
  let e = 0; for (const k of c) if (k) { const p = k / n; e -= p * Math.log2(p); }
  return e;
}

/* ---------------- fake save (for testing) ---------------- */
const DEMO_MAGIC = 'WBWHO FAKE SAVE ';
const DEMO = {
  guns: ['Pistol', 'Shotgun', 'SMG', 'Assault Rifle', 'Sniper Rifle', 'Rocket Launcher', 'Golden Gun', 'Lasso Gun'],
  outfits: ['Street Hoodie', 'Boss Suit', 'Cowboy Fit', 'Space Suit', 'Hot Dog Costume', 'Ninja Gear', 'Gold Chains', 'Pink Tux', 'Biker Jacket', 'Dino Onesie'],
  cars: ['Lowrider', 'Muscle Car', 'Monster Truck', 'Hover Bike', 'Tank', 'Limo', 'Taco Truck', 'Jet'],
  missions: ['Welcome to Santo Ileso', 'The Heist', 'Getting the Band Together', 'Boss Moves', 'Hot Wheels', 'Party Time', 'Big Trouble', 'Rocket Man', 'Last Stand', 'Coming Home', 'Home Run', 'The End?'],
};
const DL = { money: 0x40, xp: 0x44, level: 0x48, health: 0x4C, ammo: 0x60, guns: 0x100, outfits: 0x400, cars: 0x700, missions: 0xA00 };
function makeDemo(second) {
  const d = new Uint8Array(0x4000), v = view(d), enc = new TextEncoder();
  d.set(enc.encode(DEMO_MAGIC), 0);
  v.setUint32(0x10, 1, true);
  d.set(enc.encode('Boss'), 0x20);
  const money = second ? 9000 : 12500;
  v.setUint32(DL.money, money, true);
  v.setUint32(DL.xp, 3400, true);
  v.setUint16(DL.level, 7, true);
  v.setFloat32(DL.health, 100, true);
  DEMO.guns.forEach((g, i) => v.setUint16(DL.ammo + i * 2, i < 3 ? 120 - i * 30 : 0, true));
  const list = (names, base, size, on) => names.forEach((nm, i) => {
    d.set(enc.encode(nm.toLowerCase().replace(/[^a-z0-9]+/g, '_')), base + i * size);
    d[base + i * size + size - 1] = on(i) ? 1 : 0;
  });
  list(DEMO.guns.map(g => 'weapon_' + g), DL.guns, 40, i => i < 3);
  list(DEMO.outfits.map(g => 'outfit_' + g), DL.outfits, 40, i => i < 2);
  list(DEMO.cars.map(g => 'vehicle_' + g), DL.cars, 40, i => i < 1);
  list(DEMO.missions.map(g => 'mission_' + g), DL.missions, 48, i => i < (second ? 4 : 3));
  // Some extra numbers so searching finds more than one spot (good practice!)
  v.setUint32(0x2000, 12500, true);            // "last price" — stays the same
  v.setUint32(0x2010, second ? 9000 : 4321, true);
  v.setUint32(0x3000, 3400, true);
  for (let i = 0x3100; i < 0x3F00; i++) d[i] = (i * 7) & 0x3F; // filler
  v.setUint32(d.length - 4, crc32(d, 0, d.length - 4), true); // check code at the end
  return d;
}
function demoRecipes() {
  const r = [
    { name: 'Money', emoji: '💰', kind: 'number', offset: DL.money, type: 'u32', group: 'Main stuff' },
    { name: 'XP / Respect', emoji: '⭐', kind: 'number', offset: DL.xp, type: 'u32', group: 'Main stuff' },
    { name: 'Level', emoji: '🏅', kind: 'number', offset: DL.level, type: 'u16', group: 'Main stuff', max: 50 },
    { name: 'Health', emoji: '❤️', kind: 'number', offset: DL.health, type: 'f32', group: 'Main stuff', max: 999 },
  ];
  DEMO.guns.forEach((g, i) => r.push({ name: g + ' ammo', emoji: '🎯', kind: 'number', offset: DL.ammo + i * 2, type: 'u16', group: 'Ammo', max: 999 }));
  DEMO.guns.forEach((g, i) => r.push({ name: g, emoji: '🔫', kind: 'switch', offset: DL.guns + i * 40 + 39, on: 1, off: 0, group: 'Guns' }));
  DEMO.outfits.forEach((g, i) => r.push({ name: g, emoji: '👕', kind: 'switch', offset: DL.outfits + i * 40 + 39, on: 1, off: 0, group: 'Outfits' }));
  DEMO.cars.forEach((g, i) => r.push({ name: g, emoji: '🚗', kind: 'switch', offset: DL.cars + i * 40 + 39, on: 1, off: 0, group: 'Cars' }));
  DEMO.missions.forEach((g, i) => r.push({ name: g, emoji: '🎬', kind: 'switch', offset: DL.missions + i * 48 + 47, on: 1, off: 0, group: 'Missions' }));
  return r.map((x, i) => ({ id: 'd' + i, ...x }));
}

/* ---------------- buttons the user saved ("cheat list") ---------------- */
const listKey = () => S.isDemo ? 'wbwho_list_demo' : 'wbwho_list';
function getList() {
  try {
    const raw = localStorage.getItem(listKey());
    if (raw) return JSON.parse(raw);
  } catch (e) { /* storage blocked */ }
  return S.isDemo ? demoRecipes() : [];
}
function setList(l) { try { localStorage.setItem(listKey(), JSON.stringify(l)); } catch (e) { toast('⚠️ Could not remember this button on this device.'); } }
function addRecipe(r) {
  const l = getList();
  r.id = 'r' + Date.now() + Math.floor(Math.random() * 1000);
  r.group = r.group || 'My buttons';
  l.push(r); setList(l); renderCards();
  toast(`⭐ Made a button for <b>${esc(r.name)}</b>! Find it on 🎮 Edit.`);
}

/* ---------------- opening files ---------------- */
async function openSave(bytes, name) {
  S.name = name; S.raw = bytes; S.undo = []; S.changed = new Set(); S.hits = []; S.words = null; S.sel = null; S.hexOff = 0;
  S.wrap = null; S.csOuter = null; S.csInner = null;
  const un = await tryUnpack(bytes);
  if (un) { S.data = un.inner; S.wrap = un.wrap; S.csOuter = detectChecksum(bytes); }
  else S.data = bytes.slice();
  S.csInner = detectChecksum(S.data);
  S.isDemo = new TextDecoder().decode(S.data.subarray(0, 16)) === DEMO_MAGIC;
  S.sr = typeof SR !== 'undefined' ? SR.parse(S.data) : null;
  if (typeof SRUI !== 'undefined') SRUI.build();
  report(); refreshTop(); renderCards(); renderHex();
  $('#findResult').innerHTML = ''; $('#wordResult').innerHTML = ''; $('#wordFilter').hidden = true;
}
function report() {
  const e = entropy(S.data), locked = e > 7.9;
  const lines = [];
  lines.push(`<p>📄 <b>${esc(S.name)}</b>, ${fmt(S.raw.length)} bytes</p>`);
  if (S.sr) lines.push(`<p>🎮 <b>Saints Row save found!</b> Money, XP, guns, cars, clothes and more are ready on <b>🎮 Edit</b>.</p>`);
  if (S.isDemo) lines.push('<p>🧪 This is a <b>fake save</b> made by WBWHO. Buttons are already made for you on 🎮 Edit!</p>');
  lines.push(`<p>Scrambled-ness:</p><div class="bar"><div style="width:${Math.min(100, e / 8 * 100)}%"></div></div>`);
  if (locked) {
    lines.push(`<div class="result bad"><b>🔒 This save looks LOCKED.</b><br>It's still scrambled by the PlayStation, so WBWHO can't read it yet. You need to unlock (decrypt) it first with Save Wizard or Apollo. Tap <b>❓ Help</b> to see how.</div>`);
  } else {
    lines.push('<div class="result good"><b>✅ Looks unlocked.</b> WBWHO can read it!</div>');
  }
  if (S.wrap) lines.push(`<p>📦 This file was <b>packed</b> (squished to be smaller). WBWHO unpacked it for you (${fmt(S.data.length)} bytes inside) and will pack it again when you save.</p>`);
  if (S.csInner || S.csOuter) lines.push('<p>🧮 Found a <b>check code</b>. WBWHO will fix it for you when you save.</p>');
  $('#fileReport').innerHTML = lines.join('');
  $('#loadedBox').hidden = false;
}
function refreshTop() {
  const dirty = S.undo.length > 0;
  $('#fileinfo').innerHTML = S.name ? `${esc(S.name)} ${dirty ? '<span class="dirty">• changed</span>' : ''}` : 'No save open';
  $('#btnUndo').disabled = !dirty;
  $('#btnSave').disabled = !S.data;
}

/* ---------------- changing bytes ---------------- */
function writeBytes(off, bytes, quiet) {
  if (off < 0 || off + bytes.length > S.data.length) { toast('⚠️ That spot is outside this file.'); return false; }
  S.undo.push({ off, old: S.data.slice(off, off + bytes.length) });
  S.data.set(bytes, off);
  for (let i = 0; i < bytes.length; i++) S.changed.add(off + i);
  if (!quiet) afterChange();
  return true;
}
function writeVal(off, type, x, quiet) {
  const t = TYPES[type];
  if (!Number.isFinite(x)) { toast('⚠️ Please type a number.'); return false; }
  if (!t.float) x = Math.round(x);
  if (x < t.min || x > t.max) { toast(`⚠️ That number is too ${x < t.min ? 'small' : 'big'}. Use ${fmt(t.min)} to ${fmt(t.max)}.`); return false; }
  const tmp = new Uint8Array(t.size); t.set(view(tmp), 0, x);
  return writeBytes(off, tmp, quiet);
}
function afterChange() { refreshTop(); renderCards(); renderHex(); }
function undo() {
  const u = S.undo.pop(); if (!u) return;
  S.data.set(u.old, u.off); afterChange(); toast('↩️ Undone!');
}
async function saveOut() {
  if (!S.data) return;
  try {
    const inner = S.data.slice();
    fixChecksum(inner, S.csInner);
    let out = S.wrap ? await repack(inner, S.wrap) : inner;
    fixChecksum(out, S.csOuter);
    download(out, S.name);
    toast('💾 Saved! Keep the <b>same file name</b> when you put it back.', 4000);
  } catch (e) { toast('⚠️ Saving failed: ' + esc(e.message)); }
}

/* ---------------- EDIT page ---------------- */
function renderCards() {
  const has = !!S.data;
  $('#editEmpty').hidden = has; $('#editArea').hidden = !has;
  if (!has) return;
  const list = getList();
  $('#editHintReal').hidden = list.length > 0 || !!S.sr;
  if (typeof SRUI !== 'undefined') SRUI.refresh();
  const locked = entropy(S.data) > 7.9;
  $('#editStatus').innerHTML = locked
    ? `<div class="result bad" style="margin-bottom:14px"><b>🔒 ${esc(S.name)} still looks LOCKED.</b> WBWHO can't read a locked save. Unlock (decrypt) it first, and make sure you picked the <b>unlocked</b> file. Tap ❓ Help to see how.</div>`
    : `<div class="result good" style="margin-bottom:14px">✅ <b>${esc(S.name)}</b> is open (${fmt(S.data.length)} bytes).</div>`;
  const groups = {};
  list.forEach(r => (groups[r.group || 'My buttons'] ||= []).push(r));
  let html = '';
  for (const [g, items] of Object.entries(groups)) {
    const sw = items.filter(r => r.kind === 'switch');
    const nums = items.filter(r => r.kind === 'number');
    html += `<div class="group"><div class="grouphead"><h2>${esc(g)}</h2>`;
    if (sw.length > 1) html += `<button class="small go" data-act="allon" data-g="${esc(g)}">✅ All ON</button><button class="small" data-act="alloff" data-g="${esc(g)}">All OFF</button>`;
    if (nums.length > 1) html += `<button class="small go" data-act="allmax" data-g="${esc(g)}">🚀 Max all</button>`;
    html += '</div>';
    for (const r of items) html += cardHTML(r);
    html += '</div>';
  }
  $('#cards').innerHTML = html;
}
function cardHTML(r) {
  const tail = `<div class="where">Spot ${spot(r.offset)}${r.scale > 1 ? ` · stored ×${r.scale}` : ''}</div>`;
  const del = `<button class="x" data-act="del" data-id="${r.id}" title="Remove button">🗑️</button>`;
  if (r.kind === 'switch') {
    const v = readVal(S.data, r.offset, 'u8');
    const on = v === r.on;
    return `<div class="ecard switch"><div class="head"><span class="emo">${esc(r.emoji || '🔘')}</span><span class="name">${esc(r.name)}</span>
      <button class="toggle ${on ? 'on' : 'off'}" data-act="toggle" data-id="${r.id}" ${v === null ? 'disabled' : ''}>${v === null ? 'Not here' : on ? 'ON ✅' : 'OFF'}</button>${del}</div>${tail}</div>`;
  }
  const raw = readVal(S.data, r.offset, r.type);
  const shown = raw === null ? null : raw / (r.scale || 1);
  return `<div class="ecard"><div class="head"><span class="emo">${esc(r.emoji || '🔢')}</span><span class="name">${esc(r.name)}</span>${del}</div>
    <div class="now">${raw === null ? "⚠️ This spot isn't in this file" : niceVal(shown, r.type)}</div>
    <div class="ctrl"><input type="text" inputmode="decimal" id="in_${r.id}" placeholder="New number">
    <button class="go" data-act="set" data-id="${r.id}">Set</button>
    <button data-act="max" data-id="${r.id}">🚀 Max</button></div>${tail}</div>`;
}
function safeMax(r) { return r.max ?? Math.floor(TYPES[r.type].safe / (r.scale || 1)); }
function setRecipe(r, x, quiet) {
  if (r.kind === 'switch') return writeBytes(r.offset, new Uint8Array([x ? r.on : r.off]), quiet);
  return writeVal(r.offset, r.type, x * (r.scale || 1), quiet);
}
$('#cards').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const list = getList(), act = b.dataset.act;
  const r = list.find(x => x.id === b.dataset.id);
  if (act === 'del') {
    if (!confirm(`Remove the "${r.name}" button? (This does not change your save.)`)) return;
    setList(list.filter(x => x !== r)); renderCards(); return;
  }
  if (act === 'toggle') { setRecipe(r, readVal(S.data, r.offset, 'u8') !== r.on); return; }
  if (act === 'set') {
    const x = parseNum($('#in_' + r.id).value);
    if (setRecipe(r, x)) toast(`${esc(r.emoji || '')} ${esc(r.name)} is now <b>${niceVal(x, r.type)}</b>`);
    return;
  }
  if (act === 'max') { if (setRecipe(r, safeMax(r))) toast(`🚀 ${esc(r.name)} maxed!`); return; }
  const g = list.filter(x => (x.group || 'My buttons') === b.dataset.g && S.data && x.offset < S.data.length);
  if (act === 'allon' || act === 'alloff') { g.filter(x => x.kind === 'switch').forEach(x => setRecipe(x, act === 'allon', true)); afterChange(); toast(act === 'allon' ? '✅ All turned ON!' : 'All turned OFF'); }
  if (act === 'allmax') { g.filter(x => x.kind === 'number').forEach(x => setRecipe(x, safeMax(x), true)); afterChange(); toast('🚀 All maxed!'); }
});

/* first-time setup list on the Edit page */
const SETUP = [
  { name: 'Money', emoji: '💰', tip: 'Look at your cash in the game first' },
  { name: 'Respect / XP', emoji: '⭐', tip: 'The XP or respect number' },
  { name: 'Level', emoji: '🏅', tip: 'Your player level' },
  { name: 'Ammo', emoji: '🎯', tip: 'Bullets for the gun you are holding' },
  { name: 'Skill points', emoji: '💎', tip: 'If the game shows any' },
];
function renderSetup() {
  $('#setupList').innerHTML = SETUP.map((x, i) => `<button data-setup="${i}"><span>${x.emoji}</span><span>Find my <b>${esc(x.name)}</b><span class="tiny">${esc(x.tip)}</span></span></button>`).join('') +
    `<button data-setup="unlock"><span>🔫</span><span>Guns, cars, outfits &amp; missions<span class="tiny">Uses two saves: one before and one after you unlock something</span></span></button>`;
}
$('#setupList').addEventListener('click', e => {
  const b = e.target.closest('button[data-setup]'); if (!b) return;
  if (b.dataset.setup === 'unlock') { showTab('compare'); return; }
  const x = SETUP[+b.dataset.setup];
  $('#findName').value = x.name; S.findEmoji = x.emoji; renderEmojis();
  $('#findValue').value = ''; $('#findResult').innerHTML = '';
  showTab('find');
  const v = $('#findValue'); v.closest('.card').classList.remove('flash'); void v.offsetWidth; v.closest('.card').classList.add('flash');
  v.focus();
  toast(`Type your ${esc(x.name)} from the game, then tap <b>🔎 Find it!</b>`, 4000);
});

/* ---------------- FIND: numbers ---------------- */
const EMOJIS = ['💰', '⭐', '🏅', '❤️', '🎯', '🔫', '🚗', '👕', '🎬', '💎', '🧨', '🔢'];
function renderEmojis() {
  $('#emojiPick').innerHTML = EMOJIS.map(e => `<button class="${e === S.findEmoji ? 'on' : ''}" data-e="${e}">${e}</button>`).join('');
}
$('#emojiPick').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.findEmoji = b.dataset.e; renderEmojis(); } });

function near(a, b, isFloat) { return isFloat ? Math.abs(a - b) <= Math.max(0.01, Math.abs(b) * 1e-5) : a === b; }
function searchNumber(d, target, opt) {
  const v = view(d), n = d.length, hits = new Map(), LIMIT = 20000;
  const add = (o, type, scale) => { if (!hits.has(o) && hits.size < LIMIT) hits.set(o, { offset: o, type, scale }); };
  const scales = opt.scaled ? [1, 10, 100, 1000] : [1];
  for (const sc of scales) {
    const t = target * sc;
    if (Number.isInteger(t)) {
      if (t >= 0 && t <= 0xFFFFFFFF) for (let o = 0; o + 4 <= n; o++) if (v.getUint32(o, true) === t) add(o, t > 0x7FFFFFFF ? 'u32' : 'i32', sc);
      if (t < 0 && t >= -2147483648) for (let o = 0; o + 4 <= n; o++) if (v.getInt32(o, true) === t) add(o, 'i32', sc);
      if (t > 0xFFFFFFFF && t <= Number.MAX_SAFE_INTEGER) {
        const lo = t % 0x100000000, hi = Math.floor(t / 0x100000000);
        for (let o = 0; o + 8 <= n; o++) if (v.getUint32(o, true) === lo && v.getUint32(o + 4, true) === hi) add(o, 'u64', sc);
      }
      if (t >= 0 && t <= 0xFFFF) for (let o = 0; o + 2 <= n; o++) if (v.getUint16(o, true) === t) add(o, 'u16', sc);
      if (opt.tiny && t >= 0 && t <= 0xFF) for (let o = 0; o < n; o++) if (d[o] === t) add(o, 'u8', sc);
    }
    if (opt.decimal) {
      for (let o = 0; o + 4 <= n; o++) if (near(v.getFloat32(o, true), t, true)) add(o, 'f32', sc);
      for (let o = 0; o + 8 <= n; o++) if (near(v.getFloat64(o, true), t, true)) add(o, 'f64', sc);
    }
  }
  return [...hits.values()];
}
function findOpts() { return { decimal: $('#optDecimal').checked, scaled: $('#optScaled').checked, tiny: $('#optTiny').checked }; }
function doFind() {
  if (!S.data) return toast('📂 Open a save first (🏠 Start).');
  const x = parseNum($('#findValue').value);
  if (!Number.isFinite(x)) return toast('⚠️ Type the number you see in the game.');
  S.findName = $('#findName').value.trim() || 'Thing';
  S.hits = searchNumber(S.data, x, findOpts());
  S.lastFind = x;
  renderHits();
}
function renderHits(narrowed) {
  const h = S.hits, box = $('#findResult');
  if (!h.length) {
    box.innerHTML = `<div class="result bad"><b>😕 Couldn't find it.</b><ul>
      <li>Check you typed the number exactly like the game shows it.</li>
      <li>Make sure this is the <b>newest</b> save, made right after you looked at the number.</li>
      <li>Open <b>More options</b> and tick both boxes, then try again.</li>
      ${narrowed ? '<li>The number may have moved. Start again with <b>Find it!</b></li>' : ''}</ul></div>`;
    return;
  }
  let html = '';
  if (h.length === 1) {
    html += `<div class="result good"><b>🎉 Found it!</b> Your ${esc(S.findName)} is at spot ${spot(h[0].offset)}.
      <button class="bigbtn" data-hit="0">⭐ Make a "${esc(S.findName)}" button</button></div>`;
  } else {
    html += `<div class="result"><b>Found ${fmt(h.length)}${h.length >= 20000 ? '+' : ''} spots</b> with that number.${narrowed ? ' Getting closer! 👍' : ''}
      <p><b>Let's narrow it down:</b></p>
      <ol class="steps"><li>In the game, make the number <b>change</b> (spend or earn some).</li>
      <li>Save the game and unlock that new save.</li>
      <li>Tap below, pick the new save, and type the new number.</li></ol>
      <input type="text" inputmode="decimal" id="newerValue" placeholder="New number in the game">
      <button class="bigbtn alt" id="btnNewer">📂 Load my newer save & narrow down</button>
      <p class="tiny">No newer save? You can also try one spot below. Tap "Try it", save, and check in the game.</p></div>`;
  }
  const shown = h.slice(0, 60);
  html += '<div class="hitlist">' + shown.map((x, i) => `<div class="hit"><div class="info">Spot ${spot(x.offset)} · ${TYPES[x.type].label}${x.scale > 1 ? ` · ×${x.scale}` : ''}<br>
      now: <b>${niceVal(readVal(S.data, x.offset, x.type) / x.scale, x.type)}</b></div>
      <button class="small" data-look="${x.offset}">👀 Look</button>
      <button class="small go" data-hit="${i}">⭐ Use this</button></div>`).join('') + '</div>';
  if (h.length > shown.length) html += `<p class="tiny">Showing the first 60 of ${fmt(h.length)}.</p>`;
  if (h.length > 1 && h.length <= 12) html += `<button class="bigbtn danger" id="btnSetAll">🧨 Change ALL ${h.length} spots (risky)</button>`;
  box.innerHTML = html;
}
$('#btnFind').addEventListener('click', doFind);
$('#findValue').addEventListener('keydown', e => { if (e.key === 'Enter') doFind(); });
$('#findResult').addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.hit !== undefined) {
    const h = S.hits[+t.dataset.hit];
    addRecipe({ name: S.findName, emoji: S.findEmoji, kind: 'number', offset: h.offset, type: h.type, scale: h.scale });
  } else if (t.dataset.look !== undefined) {
    gotoHex(+t.dataset.look);
  } else if (t.id === 'btnNewer') {
    const x = parseNum($('#newerValue').value);
    if (!Number.isFinite(x)) return toast('⚠️ First type the new number from the game.');
    S.pendingNewer = x; $('#pickNewer').value = ''; $('#pickNewer').click();
  } else if (t.id === 'btnSetAll') {
    const x = parseNum(prompt(`What number should ALL ${S.hits.length} spots become?`, ''));
    if (!Number.isFinite(x)) return;
    S.hits.forEach(h => writeVal(h.offset, h.type, x * h.scale, true)); afterChange(); renderHits();
    toast('🧨 Changed them all. Save and test it in the game!');
  }
});
$('#pickNewer').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  if (S.undo.length && !confirm('Your newer save will replace the one that is open now. Changes you haven\'t saved will be lost. OK?')) return;
  const keep = S.hits, name = S.findName, x = S.pendingNewer;
  await openSave(await readFile(f), f.name);
  S.findName = name;
  S.hits = keep.filter(h => { const r = readVal(S.data, h.offset, h.type); return r !== null && near(r / h.scale, x, TYPES[h.type].float); });
  S.lastFind = x; $('#findValue').value = x;
  renderHits(true);
});

/* ---------------- FIND: words ---------------- */
function findWords(d, q) {
  q = q.toLowerCase(); const out = [], n = d.length, ql = q.length;
  if (!ql) return out;
  const low = c => (c >= 65 && c <= 90 ? c + 32 : c);
  const qc = [...q].map(c => c.charCodeAt(0));
  for (let o = 0; o + ql <= n && out.length < 500; o++) {
    let ok = true; for (let i = 0; i < ql; i++) if (low(d[o + i]) !== qc[i]) { ok = false; break; }
    if (ok) { out.push({ offset: o, wide: false }); continue; }
    if (o + ql * 2 <= n) { ok = true; for (let i = 0; i < ql; i++) if (low(d[o + i * 2]) !== qc[i] || d[o + i * 2 + 1] !== 0) { ok = false; break; } if (ok) out.push({ offset: o, wide: true }); }
  }
  return out;
}
function textAround(d, o, wide) {
  const step = wide ? 2 : 1; let a = o, b = o;
  const pr = i => d[i] >= 32 && d[i] < 127 && (!wide || d[i + 1] === 0);
  while (a - step >= 0 && pr(a - step) && o - a < 60 * step) a -= step;
  while (b < d.length && pr(b) && b - o < 80 * step) b += step;
  let s = ''; for (let i = a; i < b; i += step) s += String.fromCharCode(d[i]);
  return { start: a, text: s };
}
function allWords(d) {
  const out = []; let s = '', st = 0;
  for (let i = 0; i <= d.length && out.length < 8000; i++) {
    const c = d[i];
    if (i < d.length && c >= 32 && c < 127) { if (!s) st = i; s += String.fromCharCode(c); }
    else { if (s.length >= 4) out.push({ offset: st, text: s }); s = ''; }
  }
  return out;
}
function wordRow(w) {
  return `<div class="hit"><div class="info"><code>${esc(w.text)}</code><br><span class="tiny">Spot ${spot(w.offset)}</span></div>
    <button class="small" data-look="${w.offset}">👀 Look</button></div>`;
}
$('#btnWord').addEventListener('click', () => {
  if (!S.data) return toast('📂 Open a save first (🏠 Start).');
  const q = $('#wordQuery').value.trim(); if (!q) return toast('Type a word to search.');
  const hits = findWords(S.data, q); $('#wordFilter').hidden = true;
  if (!hits.length) { $('#wordResult').innerHTML = '<div class="result bad">😕 Not found. Try a shorter word, like <i>gun</i> instead of <i>golden gun</i>.</div>'; return; }
  const rows = hits.map(h => { const t = textAround(S.data, h.offset, h.wide); return { offset: t.start, text: t.text }; });
  $('#wordResult').innerHTML = `<div class="result good">Found <b>${hits.length}${hits.length >= 500 ? '+' : ''}</b>. Tap 👀 Look to see the boxes around it. On/off switches are often right after the name.</div><div class="hitlist">${rows.map(wordRow).join('')}</div>`;
});
function renderWordList() {
  const f = $('#wordFilter').value.trim().toLowerCase();
  const list = S.words.filter(w => !f || w.text.toLowerCase().includes(f));
  $('#wordResult').innerHTML = `<p class="tiny">${fmt(list.length)} words${list.length > 400 ? ' (showing 400, type in the filter to find more)' : ''}</p><div class="hitlist">${list.slice(0, 400).map(wordRow).join('')}</div>`;
}
$('#btnAllWords').addEventListener('click', () => {
  if (!S.data) return toast('📂 Open a save first (🏠 Start).');
  S.words = allWords(S.data); $('#wordFilter').hidden = false; renderWordList();
});
$('#wordFilter').addEventListener('input', renderWordList);
$('#wordResult').addEventListener('click', e => { const b = e.target.closest('[data-look]'); if (b) gotoHex(+b.dataset.look); });

/* ---------------- COMPARE ---------------- */
async function pickCmp(which, f) {
  if (!f) return;
  let b = await readFile(f);
  const un = await tryUnpack(b); if (un) b = un.inner;
  S[which] = { name: f.name, data: b };
  $(which === 'cmpA' ? '#nameA' : '#nameB').textContent = `✅ ${f.name} (${fmt(b.length)} bytes)`;
  $('#btnCompare').disabled = !(S.cmpA && S.cmpB);
}
$('#pickA').addEventListener('change', e => pickCmp('cmpA', e.target.files[0]));
$('#pickB').addEventListener('change', e => pickCmp('cmpB', e.target.files[0]));
function diff(a, b) {
  const n = Math.min(a.length, b.length), out = [];
  for (let i = 0; i < n && out.length < 5000; i++) {
    if (a[i] !== b[i]) {
      let j = i; while (j < n && (a[j] !== b[j] || (j + 1 < n && a[j + 1] !== b[j + 1]) || (j + 2 < n && a[j + 2] !== b[j + 2])) && j - i < 64) j++;
      out.push({ offset: i, len: j - i }); i = j;
    }
  }
  return out;
}
const hexBytes = (d, o, l) => [...d.subarray(o, o + Math.min(l, 16))].map(x => hex(x, 2)).join(' ') + (l > 16 ? ' …' : '');
function diffNumber(d, x) {
  if (x.len === 1) return `${d[x.offset]}`;
  if (x.len <= 2) return fmt(readVal(d, x.offset, 'u16') ?? 0);
  if (x.len <= 4) return fmt(readVal(d, x.offset, 'u32') ?? 0);
  return '';
}
$('#btnCompare').addEventListener('click', () => {
  const A = S.cmpA.data, B = S.cmpB.data;
  S.diffs = diff(A, B);
  let html = '';
  if (A.length !== B.length) html += `<div class="result">⚠️ The two saves are different sizes. That's OK, but things may have moved around, so copying changes is riskier.</div>`;
  if (!S.diffs.length) { $('#diffResult').innerHTML = html + '<div class="result">🤷 They are exactly the same. Make sure you saved the game after doing something.</div>'; return; }
  const locked = entropy(B) > 7.9;
  html += `<div class="card"><h2>${fmt(S.diffs.length)}${S.diffs.length >= 5000 ? '+' : ''} spots changed</h2>`;
  if (locked) html += '<div class="result bad">🔒 These saves look locked, so almost everything changed. Unlock them first.</div>';
  html += `<p class="tiny">Fewer changes is easier. Things like play time always change, so don't worry about those.</p>
    <button class="bigbtn" id="btnCopyAll" ${S.data ? '' : 'disabled'}>📋 Copy ALL changes into my open save</button>
    ${S.data ? '' : '<p class="tiny">Open a save on 🏠 Start to copy changes into it.</p>'}</div>`;
  html += '<div class="hitlist">' + S.diffs.slice(0, 300).map((x, i) => `<div class="hit"><div class="info">Spot ${spot(x.offset)} · ${x.len} box${x.len > 1 ? 'es' : ''}<br>
    before: <code>${hexBytes(A, x.offset, x.len)}</code> ${x.len <= 4 ? `(${diffNumber(A, x)})` : ''}<br>
    after: <code>${hexBytes(B, x.offset, x.len)}</code> ${x.len <= 4 ? `(${diffNumber(B, x)})` : ''}</div>
    <button class="small" data-look="${x.offset}">👀</button>
    <button class="small go" data-copy="${i}" ${S.data ? '' : 'disabled'}>📋 Copy</button>
    ${x.len === 1 ? `<button class="small" data-mk="${i}">⭐ Button</button>` : ''}</div>`).join('') + '</div>';
  if (S.diffs.length > 300) html += '<p class="tiny">Showing the first 300.</p>';
  $('#diffResult').innerHTML = html;
});
$('#diffResult').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const B = S.cmpB.data;
  if (b.id === 'btnCopyAll') {
    let n = 0; S.diffs.forEach(x => { if (x.offset + x.len <= S.data.length && writeBytes(x.offset, B.slice(x.offset, x.offset + x.len), true)) n++; });
    afterChange(); toast(`📋 Copied ${n} changes. Tap 💾 Save when ready.`);
  } else if (b.dataset.copy !== undefined) {
    const x = S.diffs[+b.dataset.copy];
    if (writeBytes(x.offset, B.slice(x.offset, x.offset + x.len))) toast('📋 Copied!');
  } else if (b.dataset.mk !== undefined) {
    const x = S.diffs[+b.dataset.mk];
    const name = prompt('What did you unlock? (example: Golden Gun, Mission 3)', ''); if (!name) return;
    addRecipe({ name, emoji: '🔓', kind: 'switch', offset: x.offset, on: B[x.offset], off: S.cmpA.data[x.offset] });
  } else if (b.dataset.look !== undefined) gotoHex(+b.dataset.look);
});

/* ---------------- INSIDE (hex) ---------------- */
const ROWS = 48;
const perRow = () => (window.innerWidth < 560 ? 8 : 16);
function renderHex() {
  const box = $('#hexView');
  if (!S.data) { box.innerHTML = '<p>Open a save first.</p>'; $('#hexPos').textContent = ''; return; }
  const pr = perRow(), page = pr * ROWS, d = S.data;
  S.hexOff = Math.max(0, Math.min(S.hexOff - (S.hexOff % pr), Math.max(0, d.length - 1 - ((d.length - 1) % pr))));
  let html = '';
  for (let r = 0; r < ROWS; r++) {
    const o = S.hexOff + r * pr; if (o >= d.length) break;
    let bytes = '', asc = '';
    for (let i = 0; i < pr; i++) {
      const p = o + i;
      if (p >= d.length) { bytes += '<span class="hb"> </span>'; continue; }
      const b = d[p];
      bytes += `<span class="hb${b === 0 ? ' z' : ''}${p === S.sel ? ' sel' : ''}${S.changed.has(p) ? ' chg' : ''}" data-o="${p}">${hex(b, 2)}</span>`;
      asc += b >= 32 && b < 127 ? esc(String.fromCharCode(b)) : '·';
    }
    html += `<div class="hrow"><span class="hoff">${hex(o, 6)}</span><span>${bytes}</span><span class="hasc">${asc}</span></div>`;
  }
  box.innerHTML = html;
  $('#hexPos').textContent = `Spots ${fmt(S.hexOff)}–${fmt(Math.min(d.length, S.hexOff + page) - 1)} of ${fmt(d.length)}`;
  renderInspector();
}
function gotoHex(o) {
  if (!S.data) return;
  S.sel = o; S.hexOff = Math.max(0, o - perRow() * 4);
  showTab('hex'); renderHex();
}
function renderInspector() {
  const box = $('#inspector');
  if (S.sel === null || !S.data || S.sel >= S.data.length) { box.hidden = true; return; }
  const o = S.sel;
  const rows = Object.entries(TYPES).filter(([k]) => o + TYPES[k].size <= S.data.length).map(([k, t]) =>
    `<tr><td>${t.label}</td><td><input type="text" inputmode="decimal" data-t="${k}" value="${esc(niceVal(readVal(S.data, o, k), k))}"></td>
     <td><button class="small go" data-set="${k}">Set</button></td><td><button class="small" data-mk="${k}" title="Make a button">⭐</button></td></tr>`).join('');
  box.innerHTML = `<h2>Spot ${spot(o)}</h2><p class="tiny">The same boxes can mean different numbers. Pick the one that makes sense (like your money), then tap ⭐ to make a button.</p>
    <div class="insp"><table>${rows}</table></div>
    <button class="bigbtn alt2" id="mkSwitch">🔘 Make an ON/OFF switch from this box</button>`;
  box.hidden = false;
}
$('#hexView').addEventListener('click', e => { const b = e.target.closest('[data-o]'); if (b) { S.sel = +b.dataset.o; renderHex(); $('#inspector').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } });
$('#inspector').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const o = S.sel;
  if (b.dataset.set) {
    const x = parseNum($(`#inspector input[data-t="${b.dataset.set}"]`).value);
    if (writeVal(o, b.dataset.set, x)) toast('✏️ Changed!');
  } else if (b.dataset.mk) {
    const name = prompt('What is this? (example: Money)', ''); if (!name) return;
    addRecipe({ name, emoji: '🔢', kind: 'number', offset: o, type: b.dataset.mk, scale: 1 });
  } else if (b.id === 'mkSwitch') {
    const name = prompt('What does this switch unlock? (example: Golden Gun)', ''); if (!name) return;
    const cur = S.data[o];
    addRecipe({ name, emoji: '🔘', kind: 'switch', offset: o, on: cur === 0 ? 1 : cur, off: 0 });
  }
});
$('#hexPrev').addEventListener('click', () => { S.hexOff = Math.max(0, S.hexOff - perRow() * ROWS); renderHex(); });
$('#hexNext').addEventListener('click', () => { if (S.data && S.hexOff + perRow() * ROWS < S.data.length) { S.hexOff += perRow() * ROWS; renderHex(); } });
$('#btnHexGo').addEventListener('click', () => {
  const o = parseNum($('#hexGo').value);
  if (!Number.isInteger(o) || !S.data || o < 0 || o >= S.data.length) return toast('⚠️ That spot is not in this file.');
  gotoHex(o);
});
window.addEventListener('resize', () => { clearTimeout(renderHex.t); renderHex.t = setTimeout(renderHex, 200); });

/* ---------------- tabs & top buttons ---------------- */
function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => (t.hidden = t.id !== 'tab-' + name));
  document.querySelectorAll('.bottom button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  window.scrollTo(0, 0);
}
document.querySelector('.bottom').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
$('#btnUndo').addEventListener('click', undo);
$('#btnSave').addEventListener('click', saveOut);
$('#btnBackup').addEventListener('click', () => { download(S.raw, 'BACKUP-' + S.name); toast('🛟 Backup downloaded. Keep it safe!'); });
$('#pickMain').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  if (S.undo.length && !confirm('You have changes you haven\'t saved. Open a new file anyway?')) return;
  await openSave(await readFile(f), f.name); e.target.value = '';
  toast('📂 Opened!');
});
async function openDemo(second) {
  if (S.undo.length && !confirm('You have changes you haven\'t saved. Open the fake save anyway?')) return;
  const d = makeDemo(second);
  await openSave(d, second ? 'fake-save-2.dat' : 'fake-save.dat');
  toast('🧪 Fake save ready! Try 🎮 Edit or 🔎 Find.');
}
$('#btnDemo1').addEventListener('click', () => openDemo(false));
$('#btnDemo2').addEventListener('click', () => openDemo(true));
$('#btnExportList').addEventListener('click', () => {
  const json = JSON.stringify({ app: 'WBWHO', version: 1, buttons: getList() }, null, 2);
  download(new TextEncoder().encode(json), S.isDemo ? 'wbwho-cheats-fake.json' : 'wbwho-cheats.json');
});
$('#pickList').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(new TextDecoder().decode(await readFile(f)));
    const items = (j.buttons || []).filter(r => Number.isInteger(r.offset) && (r.kind === 'switch' || TYPES[r.type]));
    if (!items.length) throw new Error('no buttons');
    const l = getList(); items.forEach((r, i) => l.push({ ...r, id: 'i' + Date.now() + i })); setList(l); renderCards();
    toast(`📥 Loaded ${items.length} buttons!`);
  } catch (err) { toast("⚠️ That doesn't look like a WBWHO cheat list."); }
  e.target.value = '';
});
window.addEventListener('beforeunload', e => { if (S.undo.length) { e.preventDefault(); e.returnValue = ''; } });

renderEmojis(); renderSetup(); renderCards(); renderHex();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

// for testing
window.WBWHO = { S, makeDemo, crc32, detectChecksum, searchNumber, openSave };
