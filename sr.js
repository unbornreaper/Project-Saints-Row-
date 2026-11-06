'use strict';
/* Saints Row (2022) save support for WBWHO.
   File layout (worked out from a real decrypted PS4 save):
   - "evas" magic, version, section count, then sections: [id][size][body].
   - Each body holds objects: [size][tag, last byte 01][name hash][12 zero bytes][name length][name], padded to 8.
   - After the name come 8-byte slots: [u32 value][u32 tag]. A slot whose tag ends in 01 is a nested object.
   Values are only changed in place, so sizes never move. */

const SR = {
  parse(d) {
    if (!d || d.length < 64 || d[0] !== 0x65 || d[1] !== 0x76 || d[2] !== 0x61 || d[3] !== 0x73) return null; // "evas"
    try {
      const v = new DataView(d.buffer, d.byteOffset, d.byteLength), U = o => v.getUint32(o, true);
      const objs = [];
      const hx = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += d[o + i].toString(16).padStart(2, '0'); return s; };
      const obj = (o, sec, depth) => {
        const size = U(o), end = o + size;
        if (size < 28 || end > d.length) throw new Error('bad object');
        const nl = U(o + 24); if (nl > 256) throw new Error('bad name');
        let name = ''; for (let i = 0; i < nl && d[o + 28 + i]; i++) name += String.fromCharCode(d[o + 28 + i]);
        let p = (o + 28 + nl + 7) & ~7; const fields = [];
        while (p < end) {
          const val = U(p);
          if (d[p + 7] === 1 && val >= 28 && p + val <= end) { obj(p, sec, depth + 1); p += val; }
          else { fields.push({ off: p, key: hx(p + 4, 4) }); p += 8; }
        }
        if (p !== end) throw new Error('overrun');
        objs.push({ o, sec, depth, name, tag: hx(o + 4, 4), fields });
      };
      const n = U(8); if (!n || n > 1000) return null;
      let o = 12;
      for (let s = 0; s < n; s++) {
        const size = U(o + 4), body = o + 8, dsz = U(body + 8);
        let p = (body + 16 + 7) & ~7; const end = body + 8 + dsz;
        if (body + size > d.length || end > body + size) throw new Error('bad section');
        while (p < end && U(p) > 0) { obj(p, s, 0); p += U(p); }
        o = body + size;
      }
      objs.sort((a, b) => a.o - b.o);
      return { objs, end: o };
    } catch (e) { console.warn('WBWHO: not a Saints Row save I understand:', e.message); return null; }
  },
  field(ob, key) { return ob.fields.find(f => f.key === key); },
  find(sr, sec, name) { return sr.objs.find(x => x.sec === sec && x.name === name); },
};

/* What WBWHO knows how to unlock. 'own' = how "owned" is stored. */
const SR_GROUPS = [
  { id: 'guns', emoji: '🔫', title: 'Guns & weapons', sec: 0, tag: '00500001', own: 's0' },
  { id: 'cars', emoji: '🚗', title: 'Cars, bikes, boats & more', sec: 0, tag: '00900001', own: 's0' },
  { id: 'wardrobe', emoji: '👕', title: 'Clothes, tattoos & looks', sec: 13, tag: '00000001', own: 's13' },
  { id: 'rewards', emoji: '🎁', title: 'Reward clothes', sec: 0, tag: '00400101', own: 's0' },
  { id: 'emotes', emoji: '💃', title: 'Emotes (dances & moves)', sec: 0, tag: '00d00101', own: 's0' },
  { id: 'music', emoji: '🎵', title: 'Music', sec: 0, tag: '00900101', own: 's0' },
  { id: 'decor', emoji: '🏠', title: 'HQ decorations', sec: 0, tag: '00600101', own: 's0' },
];
const SR_NUMBERS = [
  { emoji: '💰', title: 'Money', sec: 0, name: 'cash', key: '00000008', max: 999999999 },
  { emoji: '⭐', title: 'XP', sec: 0, name: 'xp', key: '00000008', max: 999999999 },
];

const SRUI = {
  open: new Set(), filter: {},
  items(g) {
    if (!S.sr) return [];
    g._items ||= S.sr.objs.filter(x => x.sec === g.sec && x.tag === g.tag && x.name &&
      (g.own === 's13' ? SR.field(x, '00100002') : SR.field(x, '00100008') && SR.field(x, '00200002')));
    return g._items;
  },
  owned(g, x) {
    const u = o => readVal(S.data, o, 'u32');
    return g.own === 's13' ? u(SR.field(x, '00100002').off) === 1 : u(SR.field(x, '00200002').off) === 1;
  },
  setOwned(g, x, on) {
    const w = (f, val) => writeVal(f.off, 'u32', val, true);
    if (g.own === 's13') return w(SR.field(x, '00100002'), on ? 1 : 0);
    const f1 = SR.field(x, '00100008'), f2 = SR.field(x, '00200002');
    const cur = readVal(S.data, f1.off, 'u32');
    w(f1, on ? Math.max(1, cur) : 0); w(f2, on ? 1 : 0);
  },
  nice(n) {
    const s = n.replace(/^(ws_|clo_|veh_|crib-placeable-|dlc_|full state |full action |partial state |partial action )/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  },
  build() {
    const box = $('#srPanel');
    S.srGroups = SR_GROUPS.map(g => ({ ...g }));
    if (!S.sr) { box.hidden = true; box.innerHTML = ''; return; }
    let h = `<div class="result good" style="margin-bottom:14px">🎮 <b>Saints Row save found!</b> WBWHO read <b>${fmt(S.sr.objs.length)}</b> things in it. Change them below.</div>`;
    h += '<div class="group"><div class="grouphead"><h2>Main stuff</h2></div>';
    SR_NUMBERS.forEach((n, i) => {
      const ob = SR.find(S.sr, n.sec, n.name), f = ob && SR.field(ob, n.key);
      if (!f) return;
      h += `<div class="ecard"><div class="head"><span class="emo">${n.emoji}</span><span class="name">${n.title}</span></div>
        <div class="now" id="srnum${i}"></div>
        <div class="ctrl"><input type="text" inputmode="numeric" id="srin${i}" placeholder="New number">
        <button class="go" data-srset="${i}">Set</button><button data-srmax="${i}">🚀 Max</button></div></div>`;
    });
    h += '</div><div class="group"><div class="grouphead"><h2>Unlock stuff</h2></div>';
    h += '<p class="tiny">Tip: unlock one group, test it in the game, then do more. Your backup can undo anything.</p>';
    S.srGroups.forEach(g => {
      if (!this.items(g).length) return;
      h += `<div class="ecard"><div class="head"><span class="emo">${g.emoji}</span><span class="name">${g.title}<br><span class="tiny" id="srcount_${g.id}"></span></span></div>
        <div class="ctrl" style="margin-top:8px"><button class="go" data-srall="${g.id}">🔓 Unlock all</button><button data-srlist="${g.id}">📋 Pick one by one</button></div>
        <div id="srlist_${g.id}" hidden><input type="text" placeholder="Search…" data-srfilter="${g.id}" style="margin-top:10px"><div class="hitlist" id="sritems_${g.id}"></div></div></div>`;
    });
    h += `</div><div class="group"><div class="grouphead"><h2>🧰 Everything else</h2></div>
      <div class="ecard"><p>Search <b>any</b> setting in your save by its name, like <i>stat_</i>, <i>notoriety</i>, or <i>wingsuit</i>, and change its numbers directly.</p>
      <p class="tiny">This is for experts. If you're not sure what a number does, leave it alone.</p>
      <input type="text" id="srAny" placeholder="Search every setting…"><div class="hitlist" id="srAnyList"></div></div>
      <div class="ecard"><p>🎬 <b>Missions:</b> the game doesn't put mission names in the save, so WBWHO can't list them by name. Use <b>🆚 Compare</b>: save before and after a mission, and WBWHO shows what changed.</p></div></div>`;
    box.innerHTML = h; box.hidden = false;
    this.refresh();
  },
  refresh() {
    if (!S.sr || $('#srPanel').hidden) return;
    SR_NUMBERS.forEach((n, i) => {
      const el = $('#srnum' + i); if (!el) return;
      const f = SR.field(SR.find(S.sr, n.sec, n.name), n.key);
      el.textContent = fmt(readVal(S.data, f.off, 'u32'));
    });
    S.srGroups.forEach(g => {
      const el = $('#srcount_' + g.id); if (!el) return;
      const it = this.items(g), own = it.filter(x => this.owned(g, x)).length;
      el.textContent = `${fmt(own)} of ${fmt(it.length)} unlocked`;
      if (this.open.has(g.id)) this.renderList(g);
    });
    if ($('#srAny') && $('#srAny').value.trim()) this.renderAny();
  },
  renderList(g) {
    const q = (this.filter[g.id] || '').toLowerCase();
    const it = this.items(g).filter(x => !q || x.name.toLowerCase().includes(q) || this.nice(x.name).toLowerCase().includes(q));
    const shown = it.slice(0, 200);
    $('#sritems_' + g.id).innerHTML = shown.map(x => {
      const on = this.owned(g, x);
      return `<div class="hit"><div class="info">${esc(this.nice(x.name))}<br><span class="tiny">${esc(x.name)}</span></div>
        <button class="toggle ${on ? 'on' : 'off'}" data-srtog="${g.id}" data-o="${x.o}">${on ? 'ON ✅' : 'OFF'}</button></div>`;
    }).join('') + (it.length > shown.length ? `<p class="tiny">Showing 200 of ${fmt(it.length)}. Type in the search box to find more.</p>` : '');
  },
  renderAny() {
    const q = $('#srAny').value.trim().toLowerCase(), list = $('#srAnyList');
    if (q.length < 2) { list.innerHTML = ''; return; }
    const hits = S.sr.objs.filter(x => x.name.toLowerCase().includes(q) && x.fields.length).slice(0, 40);
    list.innerHTML = hits.length ? hits.map(x => `<div class="hit" style="flex-direction:column;align-items:stretch"><div><b>${esc(x.name)}</b> <span class="tiny">part ${x.sec} · spot #${fmt(x.o)}</span></div>
      ${x.fields.map((f, i) => `<div class="row"><span class="tiny" style="min-width:64px">value ${i + 1}</span>
        <input type="text" inputmode="numeric" value="${readVal(S.data, f.off, 'u32')}" data-anyoff="${f.off}" style="padding:8px">
        <button class="small go" data-anyset="${f.off}">Set</button></div>`).join('')}</div>`).join('')
      : '<p class="tiny">Nothing found with that name.</p>';
  },
};

/* clicks and typing inside the Saints Row panel */
document.addEventListener('DOMContentLoaded', () => {
  const panel = $('#srPanel'); if (!panel) return;
  panel.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const grp = id => S.srGroups.find(g => g.id === id);
    if (b.dataset.srset !== undefined || b.dataset.srmax !== undefined) {
      const i = +(b.dataset.srset ?? b.dataset.srmax), n = SR_NUMBERS[i];
      const f = SR.field(SR.find(S.sr, n.sec, n.name), n.key);
      const x = b.dataset.srmax !== undefined ? n.max : parseNum($('#srin' + i).value);
      if (!Number.isFinite(x) || x < 0 || x > n.max) return toast(`⚠️ Type a number from 0 to ${fmt(n.max)}.`);
      if (writeVal(f.off, 'u32', x)) toast(`${n.emoji} ${n.title} is now <b>${fmt(Math.round(x))}</b>! Tap 💾 Save when done.`);
    } else if (b.dataset.srall) {
      const g = grp(b.dataset.srall);
      if (!confirm(`Unlock ALL ${g.title}? (You can undo this.)`)) return;
      let n = 0; SRUI.items(g).forEach(x => { if (!SRUI.owned(g, x)) { SRUI.setOwned(g, x, true); n++; } });
      afterChange(); toast(`🔓 Unlocked ${fmt(n)} ${esc(g.title.toLowerCase())}!`);
    } else if (b.dataset.srlist) {
      const g = grp(b.dataset.srlist), el = $('#srlist_' + g.id);
      el.hidden = !el.hidden;
      if (el.hidden) SRUI.open.delete(g.id); else { SRUI.open.add(g.id); SRUI.renderList(g); }
      b.textContent = el.hidden ? '📋 Pick one by one' : '🔼 Hide list';
    } else if (b.dataset.srtog) {
      const g = grp(b.dataset.srtog), x = SRUI.items(g).find(y => y.o === +b.dataset.o);
      SRUI.setOwned(g, x, !SRUI.owned(g, x)); afterChange();
    } else if (b.dataset.anyset) {
      const off = +b.dataset.anyset, x = parseNum(panel.querySelector(`input[data-anyoff="${off}"]`).value);
      if (writeVal(off, 'u32', x)) toast('✏️ Changed!');
    }
  });
  panel.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.srfilter) { SRUI.filter[t.dataset.srfilter] = t.value; SRUI.renderList(S.srGroups.find(g => g.id === t.dataset.srfilter)); }
    if (t.id === 'srAny') SRUI.renderAny();
  });
});
