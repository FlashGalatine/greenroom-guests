// Differential fuzz cases for the strict JSON-object validator in the push actions
// (adapted from the audit's recheck of GRN-07). The oracle is Node's JSON.parse plus "a plain
// object at the top level" plus "no duplicate keys" plus the validator's own depth cap (32), all in tools/json-check.mjs.
//   A = the action must accept and cache it      R = it must reject it, caching nothing
// Seeded, so every run uses the same cases.

import { objectError } from '../json-check.mjs';

const BS = String.fromCharCode(92); // one backslash

export function fuzzRows(seedStart = 12345) {
  let seed = seedStart;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const NASTY = ['', BS, BS + BS, '"', BS + '"', '}', ']', '{', '[', '},"type":"x"', '\n', '\r\n', '\t', '\u0000', '\u001f', '\u007f',
    ' ', ' ', '😀', '\ud800', '\udfff', 'é', '日本', '</script>', BS + 'u0041', 'TyrannyTimeTV', ' ', '"}', BS + '"}', 'a' + BS, '﻿'];
  const str = () => { let s = ''; const n = Math.floor(rnd() * 4); for (let i = 0; i < n; i++) s += pick(NASTY); return s; };
  const num = () => pick([0, -0, 1, -1, 3.14, 1e21, 1e-7, -2.5e-300, 9007199254740993, 123456789012, 0.1]);
  const val = (d) => {
    const r = rnd();
    if (d > 4 || r < 0.35) return pick([str, num, () => true, () => false, () => null])();
    if (r < 0.65) { const a = []; const n = Math.floor(rnd() * 4); for (let i = 0; i < n; i++) a.push(val(d + 1)); return a; }
    return obj(d + 1);
  };
  const obj = (d) => { const o = {}; const n = Math.floor(rnd() * 5); for (let i = 0; i < n; i++) o[str() + i] = val(d); return o; };

  const VDO = { enabled: true, room: 'myroom', password: 'p"w' + BS + 'd', viewFlags: '&solo&hidescreenshare&rounded=0&tallyoff&fadein&codec=h264&cleanish',
    slots: [1, 2, 3, 4].map((n) => ({ slot: n, label: 'G' + n, streamID: 'abc' + n, mirror: n % 2 === 0, mode: 'webcam', discordUserId: '' })),
    invite: { passwordMode: 'hash', label: '', push: '', stereo: false, extraFlags: '&x=1' },
    directory: [{ vdoLabel: 'John-T', discordUserId: '', displayName: 'John "the" Tyrant 😀', auto: false, socials: [{ platform: 'twitch', handle: 'TyrannyTimeTV' }] }],
    directoryAutoAdd: true, directoryIgnored: [] };
  const DISC = { channelId: '222', connected: true, hostInChannel: true, users: { '111': { name: 'Ashe', avatarUrl: 'https://cdn.discordapp.com/x.png', speaking: true } },
    settings: { exitOnSbClose: true }, rpc: { enabled: false, hasToken: false, error: null }, favorites: [{ id: 'fav1', name: 'Main Hang', serverId: '111', channelId: '222' }], current: { serverId: '111', channelId: '222' } };

  // The oracle is the JS reference: JSON.parse + one top-level object + no repeated key + depth <= 32.
  const oracle = (s) => (objectError(s) === null ? 'A' : 'R');
  const rows = [];
  // The actions Trim the payload before validating, so the oracle sees the trimmed text.
  const add = (s, kind) => rows.push({ s, kind, exp: oracle(s.trim()) });
  add(JSON.stringify(VDO), 'canon');
  add(JSON.stringify(DISC), 'canon');
  for (let i = 0; i < 6000; i++) add(JSON.stringify(obj(0)), 'stringify');
  const MUT = ['}', ']', '{', '[', '"', BS, ',', ':', ' ', '0', '-', '.', 'e', 'x', '\n', '\u0001', 'tru', 'null'];
  for (let i = 0; i < 20000; i++) {
    let s = rows[2 + Math.floor(rnd() * 6000)].s;
    const op = Math.floor(rnd() * 4), p = Math.floor(rnd() * (s.length + 1));
    if (op === 0) s = s.slice(0, p) + pick(MUT) + s.slice(p);
    else if (op === 1) s = s.slice(0, p) + s.slice(p + 1);
    else if (op === 2) s = s.slice(0, p) + pick(MUT) + s.slice(p + 1);
    else s = s + pick([',"type":"x"}', ',"type":"x","pad":{}', '}', ' ', '{}', '\n']);
    add(s, 'mutant');
  }
  const HAND = ['{"a":}', '{"a":1,}', '{"a":[1,]}', '{"a":1}{"b":2}', '{"a":01}', '{"a":1.}', '{"a":.5}', '{"a":1e}', '{"a":"' + BS + 'x"}', '{"a":"' + BS + 'u12G4"}',
    '{"a":tru}', '{"a":nul}', '{"a":[}', '{"a":{]}', '{a:1}', "{'a':1}", '{"a":1 /*c*/}', '{"a":NaN}', '{"a":-}', '{"a":"x\ny"}',
    '{"a":1,"a":2}', '{}', '{ }', ' {"a":1} ', '{"a":' + '['.repeat(35) + ']'.repeat(35) + '}', '{"a":' + '['.repeat(20) + ']'.repeat(20) + '}',
    // the depth boundary: 32 containers deep (the top-level object is 1) is accepted, 33 is refused
    '{"a":' + '['.repeat(31) + ']'.repeat(31) + '}', '{"a":' + '['.repeat(32) + ']'.repeat(32) + '}',
    // a key repeated through an escape is still a repeat
    '{"a":1,"' + BS + 'u0061":2}', '{"ab":1,"a' + BS + 'u0062":2}', '{"a":{"b":1},"c":{"b":2}}',
    '{"enabled":true,"room":"evil"},"type":"x"}', '{"enabled":true,"room":"evil"},"type":"x","pad":{}', '{not json}'];
  for (const s of HAND) add(s, 'hand');
  return rows;
}
