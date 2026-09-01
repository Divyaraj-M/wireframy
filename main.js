'use strict';

/*
 * Wireframy — lo-fi wireframing inside Obsidian.
 *
 * Design premise: Canvas already gives you the *structural* half of a
 * dedicated wireframing tool (an infinite surface, groups that behave like
 * screen frames, edges that behave like flow arrows, snapping, pan/zoom, image
 * export). What it lacks is a widget palette. So instead of bolting a vector
 * editor onto Canvas, this plugin renders UI widgets from a text DSL inside a
 * ```wf code block. A Canvas text node holding one such block *is* a wireframe.
 *
 * That choice buys three things for free:
 *   - widgets are diffable text, so wireframes live in git next to the PRD
 *   - a note containing a wf block, embedded as a Canvas file node, is a
 *     reusable master: edit once, every instance updates
 *   - no build step; this file is plain CommonJS, drop it in and enable it
 */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, ItemView, TextFileView, FuzzySuggestModal, Notice, Modal, normalizePath } = obsidian;

const VIEW_PALETTE = 'wireframy-palette';

/* A tooltip that says "Cmd/Ctrl+D" makes the reader do the platform lookup.
 * Name the key their own keyboard is labelled with. Platform is guarded because
 * older Obsidian builds and the test shim may not expose it. */
const IS_MAC = (function () {
  try { return !!(obsidian.Platform && obsidian.Platform.isMacOS); } catch (e) { return false; }
})();
function modLabel(key, alt) {
  if (IS_MAC) return '⌘' + (alt ? '⌥' : '') + key;
  return 'Ctrl+' + (alt ? 'Alt+' : '') + key;
}
const DELETE_KEY_LABEL = IS_MAC ? '⌫' : 'Del';

const SCREEN_PRESETS = [
  { id: 'desktop', label: 'Desktop', width: 1440, height: 900 },
  { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
  { id: 'tablet', label: 'Tablet', width: 820, height: 1180 },
  { id: 'mobile', label: 'Mobile', width: 390, height: 844 },
  { id: 'modal', label: 'Modal', width: 560, height: 420 }
];

const DEFAULT_SETTINGS = {
  skin: 'sketch',
  mastersFolder: 'Wireframes/Masters',
  defaultScreen: 'desktop',
  nodePadding: 24,
  showFrameLabels: true
};

/* ------------------------------------------------------------------ *
 * Parser
 *
 * Indentation-based. Every non-blank line is either
 *     widget: inline value
 * or a bare line, which becomes a data row of its parent widget
 * (table rows, list items, key/value pairs). Children are nested by
 * indentation, so containers compose:
 *
 *     window: app.example.com
 *       row:
 *         sidebar: Home | Projects*
 *         col:
 *           h1: Projects
 * ------------------------------------------------------------------ */

function parseWf(src) {
  const lines = String(src || '').replace(/\t/g, '  ').split('\n');
  const root = { type: '_root', value: '', children: [], line: 0 };
  const stack = [{ indent: -1, node: root }];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    if (/^\s*(\/\/|#\s)/.test(raw)) continue; // comments

    const indent = raw.match(/^ */)[0].length;
    const text = raw.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    const m = text.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
    let node;
    if (m && WIDGETS[m[1].toLowerCase()]) {
      node = { type: m[1].toLowerCase(), value: m[2].trim(), children: [], line: i };
    } else {
      node = { type: '_row', value: text, children: [], line: i, indent: indent };
    }
    parent.children.push(node);
    stack.push({ indent: indent, node: node });
  }
  return root;
}

/* ------------------------------------------------------------------ *
 * Value helpers — these are where the text conventions live
 * ------------------------------------------------------------------ */

// "Save changes (primary, w:200)" -> { text, mods:['primary'], style:{width:'200px'} }
function splitMods(value) {
  const out = { text: String(value || '').trim(), mods: [], style: {} };
  const m = out.text.match(/\(([^()]*)\)\s*$/);
  if (!m) return out;
  const inner = m[1].trim();
  // only treat as a modifier list if it looks like one (no spaces-only prose)
  if (!inner || /[.?!]$/.test(inner)) return out;
  const parts = inner.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const known = /^(primary|secondary|danger|ghost|disabled|active|selected|error|success|warning|muted|right|center|left|grow|fill|bold|small|large|round|flat|dashed|top|middle|bottom|stretch|nowrap)$/i;
  const sized = /^(w|h|minw|minh|flex)\s*[:=]\s*(\d+)$/i;
  let recognised = 0;
  for (const p of parts) {
    if (known.test(p)) { out.mods.push(p.toLowerCase()); recognised++; continue; }
    const s = p.match(sized);
    if (s) {
      const n = Number(s[2]);
      const key = s[1].toLowerCase();
      if (key === 'w') out.style.width = n + 'px';
      else if (key === 'h') out.style.height = n + 'px';
      else if (key === 'minw') out.style.minWidth = n + 'px';
      else if (key === 'minh') out.style.minHeight = n + 'px';
      else if (key === 'flex') out.style.flex = String(n);
      recognised++;
    }
  }
  if (recognised === parts.length && recognised > 0) out.text = out.text.slice(0, m.index).trim();
  return out;
}

// "Home | Projects* | People" -> [{text:'Home'},{text:'Projects',active:true},...]
// A trailing "-" marks the item disabled, e.g. "Archive-"
function splitItems(value) {
  return String(value || '').split('|').map(function (chunk) {
    let t = chunk.trim();
    let active = false, disabled = false, icon = null;

    // An "Label:icon-name" suffix only counts when it names a real icon, so
    // ordinary text containing a colon ("Due: today") is left alone.
    const ic = t.match(/^(.*\S)\s*:\s*([a-zA-Z][\w-]*)$/);
    if (ic && resolveIconName(ic[2])) { t = ic[1].trim(); icon = ic[2]; }

    if (t.endsWith('*')) { active = true; t = t.slice(0, -1).trim(); }
    if (t.endsWith('-') && t.length > 1) { disabled = true; t = t.slice(0, -1).trim(); }
    return { text: t, active: active, disabled: disabled, icon: icon };
  }).filter(function (i) { return i.text.length > 0; });
}

// data rows of a widget: the bare (non-widget) lines nested under it
function dataRows(node) {
  return node.children.filter(function (c) { return c.type === '_row'; }).map(function (c) { return c.value; });
}

// Rows indented under a row become that row's children, so the tree structure
// the author typed is already in the parse tree — walk it rather than trying to
// re-derive depth from column numbers.
function flatRows(node, depth, out) {
  out = out || [];
  depth = depth || 0;
  for (const c of node.children) {
    if (c.type !== '_row') continue;
    const kids = c.children.filter(function (k) { return k.type === '_row'; });
    out.push({ value: c.value, depth: depth, hasKids: kids.length > 0 });
    if (kids.length) flatRows(c, depth + 1, out);
  }
  return out;
}

function hasWidgetChildren(node) {
  return node.children.some(function (c) { return c.type !== '_row'; });
}

// "[x] Remember me" -> {checked:true, text:'Remember me'}
function checkState(t) {
  const m = String(t || '').match(/^[\[(]\s*([xXoO*✓]?)\s*[\])]\s*(.*)$/);
  if (!m) return { checked: false, text: String(t || '').trim(), explicit: false };
  return { checked: m[1] !== '', text: m[2].trim(), explicit: true };
}

// "320x180" -> {w:320,h:180}
function parseDims(t) {
  const m = String(t || '').match(/(\d+)\s*[x×]\s*(\d+)/);
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.';

function loremWords(n) {
  const words = LOREM.replace(/[.,]/g, '').split(/\s+/);
  const out = [];
  for (let i = 0; i < n; i++) out.push(words[i % words.length]);
  return out.join(' ');
}

function applyStyle(el, style) {
  for (const k in style) { if (Object.prototype.hasOwnProperty.call(style, k)) el.style[k] = style[k]; }
}

function applyMods(el, mods) {
  for (const m of mods) el.addClass('wf-m-' + m);
}

/* ------------------------------------------------------------------ *
 * Icon library
 *
 * Icons are declared as short geometry specs rather than raw path data:
 *   c cx cy r        circle
 *   r x y w h [rx]   rect
 *   l x1 y1 x2 y2    line
 *   p x,y x,y ...    polyline (open)
 *   g x,y x,y ...    polygon (closed)
 *   t cx cy          dot (filled, r=1.35)
 *   d <path data>    raw path, for the few shapes that need curves
 *
 * All on a 24x24 grid, stroked in currentColor. Geometry specs are far
 * easier to keep correct than hand-written beziers, and the flat
 * geometric result is the right register for a wireframe anyway.
 * ------------------------------------------------------------------ */

const ICON_SPECS = {
  /* --- core UI --- */
  'search':        'c 10.5 10.5 6.5; l 15.2 15.2 21 21',
  'close':         'l 5 5 19 19; l 19 5 5 19',
  'check':         'p 4,12.5 9,17.5 20,6.5',
  'plus':          'l 12 4 12 20; l 4 12 20 12',
  'minus':         'l 4 12 20 12',
  'menu':          'l 3 6 21 6; l 3 12 21 12; l 3 18 21 18',
  'more-h':        't 5.5 12; t 12 12; t 18.5 12',
  'more-v':        't 12 5.5; t 12 12; t 12 18.5',
  'home':          'p 3,11.5 12,3 21,11.5; p 5.5,10 5.5,21 18.5,21 18.5,10; r 10 15 4 6',
  'settings':      'l 3 6.5 21 6.5; l 3 12 21 12; l 3 17.5 21 17.5; c 8.5 6.5 2.2; c 15 12 2.2; c 10 17.5 2.2',
  'filter':        'p 3,5 21,5 14,13 14,20 10,20 10,13',
  'sort':          'l 6 4 6 20; p 3,17 6,20 9,17; l 18 20 18 4; p 15,7 18,4 21,7',
  'refresh':       'd M20 12a8 8 0 1 1-2.4-5.7; p 21,3 21,8 16,8',
  'grid':          'r 3.5 3.5 7 7 1; r 13.5 3.5 7 7 1; r 3.5 13.5 7 7 1; r 13.5 13.5 7 7 1',
  'list':          'l 8 6 21 6; l 8 12 21 12; l 8 18 21 18; t 4 6; t 4 12; t 4 18',
  'columns':       'r 3.5 4 17 16 1; l 12 4 12 20',
  'layout':        'r 3.5 4 17 16 1; l 3.5 9 20.5 9; l 10 9 10 20',
  'maximize':      'p 9,3.5 3.5,3.5 3.5,9; p 15,3.5 20.5,3.5 20.5,9; p 20.5,15 20.5,20.5 15,20.5; p 9,20.5 3.5,20.5 3.5,15',
  'minimize':      'p 4,10 9.5,10 9.5,4.5; p 20,10 14.5,10 14.5,4.5; p 20,14 14.5,14 14.5,19.5; p 4,14 9.5,14 9.5,19.5',
  'external':      'p 14,4 20,4 20,10; l 20 4 11 13; p 17,14 17,20 4,20 4,7 10,7',
  'link':          'd M9.5 14.5 14.5 9.5; d M11 7 13.5 4.5a4.2 4.2 0 0 1 6 6L17 13; d M13 17l-2.5 2.5a4.2 4.2 0 0 1-6-6L7 11',
  'eye':           'd M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z; c 12 12 3',
  'eye-off':       'd M4 8.5C2.9 9.8 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.4 0 2.6-.3 3.7-.8; d M9.5 5.9c.8-.3 1.6-.4 2.5-.4 6 0 9.5 6.5 9.5 6.5s-.9 1.7-2.5 3.3; l 3 3 21 21',
  'lock':          'r 4.5 11 15 10 1.5; d M8 11V8a4 4 0 0 1 8 0v3',
  'unlock':        'r 4.5 11 15 10 1.5; d M8 11V8a4 4 0 0 1 7.5-2',
  'key':           'c 7.5 16.5 4; l 10.3 13.7 20 4; l 16 8 18.5 10.5; l 13.5 10.5 16 13',
  'power':         'd M6.5 7.5a8 8 0 1 0 11 0; l 12 2.5 12 12',
  'log-out':       'p 15,4 20,4 20,20 15,20; l 3 12 15 12; p 11,8 15,12 11,16',
  'log-in':        'p 9,4 4,4 4,20 9,20; l 21 12 9 12; p 17,8 21,12 17,16',
  'plug':          'l 12 14 12 21; d M7 6v4a5 5 0 0 0 10 0V6; l 9 2.5 9 6; l 15 2.5 15 6',

  /* --- arrows --- */
  'arrow-left':    'l 21 12 3 12; p 9,6 3,12 9,18',
  'arrow-right':   'l 3 12 21 12; p 15,6 21,12 15,18',
  'swap':          'l 4 9 20 9; p 16,5 20,9 16,13; l 20 15 4 15; p 8,11 4,15 8,19',
  'arrow-up':      'l 12 21 12 3; p 6,9 12,3 18,9',
  'arrow-down':    'l 12 3 12 21; p 6,15 12,21 18,15',
  'chevron-left':  'p 15,4 7,12 15,20',
  'chevron-right': 'p 9,4 17,12 9,20',
  'chevron-up':    'p 4,15 12,7 20,15',
  'chevron-down':  'p 4,9 12,17 20,9',
  'chevrons-right':'p 5,5 12,12 5,19; p 13,5 20,12 13,19',
  'corner-turn':   'p 15,6 20,11 15,16; d M20 11H8a4 4 0 0 0-4 4v4',
  'move':          'l 12 3 12 21; l 3 12 21 12; p 9,6 12,3 15,6; p 9,18 12,21 15,18; p 6,9 3,12 6,15; p 18,9 21,12 18,15',
  'undo':          'p 8,7 3,12 8,17; d M3 12h11a6 6 0 0 1 0 12h-3',
  'redo':          'p 16,7 21,12 16,17; d M21 12H10a6 6 0 0 0 0 12h3',
  'share':         'c 18 5.5 3; c 6 12 3; c 18 18.5 3; l 8.6 10.6 15.4 7; l 8.6 13.4 15.4 17',
  'upload':        'p 6,9 12,3 18,9; l 12 3 12 15; d M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  'download':      'p 6,11 12,17 18,11; l 12 3 12 17; d M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  'upload-cloud':  'd M6.5 17a4.5 4.5 0 0 1 .6-9 6 6 0 0 1 11.3 2.1A4 4 0 0 1 18 18; p 9,13 12,10 15,13; l 12 10 12 20',
  'expand':        'p 4,10 4,4 10,4; p 20,10 20,4 14,4; p 20,14 20,20 14,20; p 4,14 4,20 10,20',

  /* --- people --- */
  'user':          'c 12 8 4; p 4,21 5.2,17 9,15 15,15 18.8,17 20,21',
  'users':         'c 9 8 3.6; p 2,21 3,17.4 6.3,15.6 11.7,15.6 15,17.4 16,21; d M16 5.2a3.6 3.6 0 0 1 0 7; d M18 15.9c2 .5 3.4 1.6 3.7 2.6L22 21',
  'user-plus':     'c 10 8 4; p 2,21 3.2,17 7,15 13,15 15.5,16.3; l 18 14 18 22; l 14 18 22 18',
  'contact':       'r 3.5 4.5 17 15 1.5; c 12 11 2.6; p 8,17 9,14.8 15,14.8 16,17',

  /* --- communication --- */
  'mail':          'r 2.5 5 19 14 1; p 2.5,6.2 12,13 21.5,6.2',
  'mail-open':     'p 2.5,10 12,3.5 21.5,10 21.5,19 2.5,19 2.5,10; p 2.5,10 12,16.5 21.5,10',
  'send':          'g 3,11 21,3 13,21 11,13; l 11 13 21 3',
  'message':       'p 3.5,4.5 20.5,4.5 20.5,16.5 9,16.5 4.5,21 4.5,16.5 3.5,16.5',
  'bell':          'p 7,17 7,10.8 12,6 17,10.8 17,17; l 4.5 17 19.5 17; c 12 19.8 1.6; l 12 3.5 12 6',
  'bell-off':      'p 7,17 7,10.8 9,8.8; l 4.5 17 19.5 17; d M11 5.6A5 5 0 0 1 17 10.8V17; l 3 3 21 21',
  'phone':         'd M6 3h3l2 5-2.2 1.6a11 11 0 0 0 5.6 5.6L16 13l5 2v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4 5.2 2 2 0 0 1 6 3z',
  'megaphone':     'p 3,10 3,15 8,15 18,20 18,5 8,10 3,10; l 8 15 8 10; d M18 9a3.5 3.5 0 0 1 0 7',
  'at-sign':       'c 12 12 4; d M16 8v5a3 3 0 0 0 5.5 1.6A10 10 0 1 0 17 20.5',

  /* --- files --- */
  'file':          'p 6,3 14,3 19,8 19,21 6,21; p 14,3 14,8 19,8',
  'file-text':     'p 6,3 14,3 19,8 19,21 6,21; p 14,3 14,8 19,8; l 9 12 16 12; l 9 15.5 16 15.5; l 9 19 13 19',
  'file-plus':     'p 6,3 14,3 19,8 19,21 6,21; p 14,3 14,8 19,8; l 12.5 12 12.5 18; l 9.5 15 15.5 15',
  'folder':        'g 3,6 9,6 11,9 21,9 21,20 3,20',
  'folder-open':   'p 3,6 9,6 11,9 19,9 19,12; p 3,6 3,20 18,20 22,12 6,12',
  'copy':          'r 8.5 8.5 12 12 1.5; p 15.5,5.5 4,5.5 4,17',
  'clipboard':     'p 8,4.5 5.5,4.5 5.5,21 18.5,21 18.5,4.5 16,4.5; r 8.5 2.5 7 4 1',
  'save':          'p 4,4 17,4 20,7 20,20 4,20 4,4; p 8,4 8,10 15,10 15,4; r 8 15 8 5',
  'printer':       'p 7,8 7,3.5 17,3.5 17,8; r 3.5 8 17 8 1; p 7,14 7,20.5 17,20.5 17,14',
  'paperclip':     'd M17 8.5 9.4 16a3.2 3.2 0 0 0 4.5 4.5l7-7a5.5 5.5 0 0 0-7.8-7.8L5.5 13.4a7.8 7.8 0 0 0 0 0',
  'archive':       'r 3 4 18 5 1; p 5,9 5,21 19,21 19,9; l 10 14 14 14',
  'trash':         'l 3.5 6.5 20.5 6.5; p 6,6.5 7,21 17,21 18,6.5; p 9,6.5 9,3.5 15,3.5 15,6.5; l 10.5 10.5 10.5 17.5; l 13.5 10.5 13.5 17.5',
  'image':         'r 3 4.5 18 15 1.5; c 8.5 10 2; p 3,17 9,12 13,15.5 16,13 21,17.5',
  'film':          'r 3 4.5 18 15 1.5; l 7 4.5 7 19.5; l 17 4.5 17 19.5; t 5 8; t 5 12; t 5 16; t 19 8; t 19 12; t 19 16; l 7 12 17 12',
  'database':      'd M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3z; d M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6; d M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  'server':        'r 3 3.5 18 7 1; r 3 13.5 18 7 1; t 7 7; t 7 17',
  'cloud':         'd M6.8 19a4.8 4.8 0 0 1 .5-9.6 6.4 6.4 0 0 1 12.1 2.2A4 4 0 0 1 18.5 19z',

  /* --- commerce --- */
  'tag':           'p 3,11 11,3 21,3 21,13 13,21 3,11; t 17.5 6.5',
  'briefcase':     'r 3 7.5 18 12 1.5; p 9,7.5 9,4.5 15,4.5 15,7.5; l 3 13 21 13',
  'building':      'p 5,21 5,3 19,3 19,21; l 9 7 9 7; t 9 7; t 13 7; t 9 11; t 13 11; t 9 15; t 13 15; r 10 18 4 3',
  'credit-card':   'r 2.5 5.5 19 13 1.5; l 2.5 10 21.5 10; l 6 14.5 10 14.5',
  'cart':          'c 9.5 20 1.6; c 17.5 20 1.6; p 2,3.5 5,3.5 7.5,15 19,15 21,7 6,7',
  'receipt':       'p 5,3 19,3 19,21 16,19 12,21 8,19 5,21 5,3; l 8.5 8 15.5 8; l 8.5 12 15.5 12',
  'dollar':        'l 12 2.5 12 21.5; d M16.5 7.5a4 4 0 0 0-4-2.5h-1a3.5 3.5 0 0 0 0 7h2a3.5 3.5 0 0 1 0 7h-1a4 4 0 0 1-4-2.5',
  'rupee':         'l 6.5 4 17.5 4; l 6.5 8.5 17.5 8.5; d M6.5 13h5a4.5 4.5 0 0 0 0-9; l 9 13 17 21',
  'percent':       'c 6.5 6.5 3; c 17.5 17.5 3; l 20 4 4 20',
  'target':        'c 12 12 8.5; c 12 12 4.5; t 12 12',
  'trending-up':   'p 3,17 9.5,10.5 13.5,14.5 21,7; p 15,7 21,7 21,13',
  'trending-down': 'p 3,7 9.5,13.5 13.5,9.5 21,17; p 15,17 21,17 21,11',
  'bar-chart':     'l 3 20.5 21 20.5; r 5 12 3.6 8.5; r 10.2 7 3.6 13.5; r 15.4 14.5 3.6 6',
  'pie-chart':     'c 12 12 8.5; l 12 12 12 3.5; l 12 12 20 15.5',
  'line-chart':    'p 3,3.5 3,20.5 21,20.5; p 6,16 10,10.5 13.5,13.5 20,5.5; t 10 10.5; t 13.5 13.5',
  'activity':      'p 2.5,12 7,12 9.5,5.5 14.5,18.5 17,12 21.5,12',

  /* --- time --- */
  'calendar':      'r 3.5 5.5 17 15 1.5; l 3.5 10 20.5 10; l 8 3 8 7; l 16 3 16 7; t 8.5 14; t 12 14; t 15.5 14; t 8.5 17.5',
  'clock':         'c 12 12 8.7; p 12,6.8 12,12 16,14.5',
  'timer':         'c 12 13.5 7.5; l 12 13.5 12 9.5; l 9 2.5 15 2.5; l 12 2.5 12 6',
  'history':       'd M4 12a8 8 0 1 0 8-8 8 8 0 0 0-6.9 4; p 3,3 3,8.5 8.5,8.5; p 12,8 12,12.5 15.5,14.5',
  'hourglass':     'l 6 3 18 3; l 6 21 18 21; p 6,3 6,7 12,12 18,7 18,3; p 6,21 6,17 12,12 18,17 18,21',

  /* --- status --- */
  'info':          'c 12 12 8.7; l 12 11 12 16.5; t 12 7.8',
  'help':          'c 12 12 8.7; d M9.5 9.5a2.6 2.6 0 0 1 5 1c0 1.7-2.5 2-2.5 3.8; t 12 17.5',
  'alert-circle':  'c 12 12 8.7; l 12 7.5 12 13; t 12 16.5',
  'alert':         'g 12,3 22,20 2,20; l 12 9 12 14.5; t 12 17.3',
  'check-circle':  'c 12 12 8.7; p 8,12 11,15 16.5,9',
  'x-circle':      'c 12 12 8.7; l 9 9 15 15; l 15 9 9 15',
  'star':          'g 12,3 14.6,9.3 21.4,9.9 16.3,14.4 17.8,21 12,17.5 6.2,21 7.7,14.4 2.6,9.9 9.4,9.3',
  'heart':         'd M12 20.5C6 15 3.4 12.4 3.4 9.3A4 4 0 0 1 12 7.2a4 4 0 0 1 8.6 2.1c0 3.1-2.6 5.7-8.6 11.2z',
  'flag':          'l 5 3 5 21; p 5,4 18,4 15,9 18,14 5,14',
  'bookmark':      'p 6,3 18,3 18,21 12,16 6,21',
  'thumbs-up':     'r 2.5 10 4 10 1; p 6.5,10 10,3.5 12,3.5 12,10 19,10 21,12 19,20 6.5,20',
  'shield':        'p 12,3 20,6 20,12 12,21 4,12 4,6',
  'zap':           'g 13,2 5,13.5 11,13.5 10,22 19,10 13,10',
  'lightbulb':     'd M8.5 14a5.5 5.5 0 1 1 7 0c-.8 1-1 1.6-1 3h-5c0-1.4-.2-2-1-3z; l 9.5 20 14.5 20; l 10.5 22.5 13.5 22.5',

  /* --- editing --- */
  'edit':          'p 18,3.5 20.5,6 9,17.5 5,19 6.5,15; l 15.5 6 18 8.5',
  'pen':           'p 3,21 4.5,16 16.5,4 20,7.5 8,19.5; l 14 6.5 17.5 10',
  'type':          'l 5 5 19 5; l 12 5 12 20; l 9 20 15 20',
  'bold':          'p 7,4 14,4 14,4; d M7 4h6.5a4 4 0 0 1 0 8H7zm0 8h7.5a4 4 0 0 1 0 8H7z',
  'italic':        'l 10 4 18 4; l 6 20 14 20; l 14.5 4 9.5 20',
  'scissors':      'c 6.5 6 2.8; c 6.5 18 2.8; l 8.8 7.6 20 18; l 8.8 16.4 20 6',
  'crop':          'p 6,2.5 6,18 21.5,18; p 2.5,6 18,6 18,21.5',
  'palette':       'd M12 3a9 9 0 0 0 0 18c1.4 0 1.8-1 1.4-2-.5-1.4.5-2.5 2-2.5H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3z; t 8 9; t 12.5 7; t 16.5 10',
  'droplet':       'd M12 2.5 6.5 9.5a7 7 0 1 0 11 0z',
  'wand':          'l 4 20 16 8; l 18 3 18 7; l 21.5 5 18.5 6.5; l 16.5 6.5 13.5 5; l 20 10 17 9',

  /* --- dev --- */
  'code':          'p 8,7 3,12 8,17; p 16,7 21,12 16,17; l 13.5 4 10.5 20',
  'terminal':      'r 2.5 4 19 16 1.5; p 6,10 8.5,12.5 6,15; l 11.5 15.5 17 15.5',
  'git-branch':    'c 6.5 5.5 2.6; c 6.5 18.5 2.6; c 17.5 8.5 2.6; l 6.5 8.1 6.5 15.9; d M15 10.5c-2 3-8.5 1.5-8.5 5.5',
  'bug':           'd M7 11a5 5 0 0 1 10 0v4a5 5 0 0 1-10 0z; l 9 6.5 10.5 9; l 15 6.5 13.5 9; l 3 11 7 11.5; l 21 11 17 11.5; l 3 17.5 7 15.5; l 21 17.5 17 15.5',
  'layers':        'g 12,2.5 21.5,7.5 12,12.5 2.5,7.5; p 2.5,12 12,17 21.5,12; p 2.5,16.5 12,21.5 21.5,16.5',
  'box':           'g 12,2.5 21,7 21,17 12,21.5 3,17 3,7; l 3 7 12 11.5; l 21 7 12 11.5; l 12 11.5 12 21.5',
  'package':       'g 12,2.5 21,7 21,17 12,21.5 3,17 3,7; l 3 7 12 11.5; l 21 7 12 11.5; l 12 11.5 12 21.5; l 7.5 4.7 16.5 9.2',
  'cpu':           'r 6.5 6.5 11 11 1; r 10 10 4 4; l 12 2.5 12 6.5; l 12 17.5 12 21.5; l 2.5 12 6.5 12; l 17.5 12 21.5 12',
  'wifi':          'd M3 10a13 13 0 0 1 18 0; d M6.5 13.5a8 8 0 0 1 11 0; d M10 17a3.5 3.5 0 0 1 4 0; t 12 20',
  'battery':       'r 2.5 8 17 8 1.5; l 21.5 11 21.5 13; r 4.5 10 8 4',

  /* --- media --- */
  'play':          'g 7,4 20,12 7,20',
  'pause':         'r 7 4.5 3.5 15; r 13.5 4.5 3.5 15',
  'stop':          'r 6 6 12 12 1',
  'skip-back':     'l 6 5 6 19; g 19,5 8.5,12 19,19',
  'skip-forward':  'l 18 5 18 19; g 5,5 15.5,12 5,19',
  'volume':        'g 3,9.5 7,9.5 12,5 12,19 7,14.5 3,14.5; d M15.5 9a4 4 0 0 1 0 6; d M18 6.5a7.5 7.5 0 0 1 0 11',
  'volume-x':      'g 3,9.5 7,9.5 12,5 12,19 7,14.5 3,14.5; l 16 10 21 15; l 21 10 16 15',
  'mic':           'r 9.5 2.5 5 10 2.5; d M6 11.5a6 6 0 0 0 12 0; l 12 17.5 12 21; l 8.5 21 15.5 21',
  'camera':        'p 3,8 7,8 9,5.5 15,5.5 17,8 21,8 21,19.5 3,19.5 3,8; c 12 13.5 3.6',
  'video':         'r 2.5 6 13 12 1.5; g 15.5,12 21.5,8 21.5,16',

  /* --- misc --- */
  'map-pin':       'd M12 21.5S5 15 5 10a7 7 0 0 1 14 0c0 5-7 11.5-7 11.5z; c 12 10 2.6',
  'map':           'p 2.5,5.5 8.5,3 15.5,6 21.5,3.5 21.5,18.5 15.5,21 8.5,18 2.5,20.5 2.5,5.5; l 8.5 3 8.5 18; l 15.5 6 15.5 21',
  'globe':         'c 12 12 8.7; l 3.3 12 20.7 12; d M12 3.3a13 13 0 0 1 0 17.4; d M12 3.3a13 13 0 0 0 0 17.4',
  'compass':       'c 12 12 8.7; g 15,9 13,13 9,15 11,11',
  'sun':           'c 12 12 4; l 12 2 12 5; l 12 19 12 22; l 2 12 5 12; l 19 12 22 12; l 5 5 7 7; l 17 17 19 19; l 19 5 17 7; l 7 17 5 19',
  'moon':          'd M15 3.5A9 9 0 1 0 20.5 15 7 7 0 0 1 15 3.5z',
  'gift':          'r 3 8 18 4 1; p 5,12 5,21 19,21 19,12; l 12 8 12 21; d M12 8 8.5 8a2.5 2.5 0 0 1 0-5c2 0 3.5 5 3.5 5zm0 0h3.5a2.5 2.5 0 0 0 0-5C13.5 3 12 8 12 8z',
  'coffee':        'p 4,7 17,7 17,15 4,15 4,7; d M17 8h1.5a3 3 0 0 1 0 6H17; l 3 19 18 19',
  'smile':         'c 12 12 8.7; d M8 14a5 5 0 0 0 8 0; t 9 9.5; t 15 9.5',
  'rocket':        'd M12 2.5c3 2.5 5 6.5 5 11l-2.5 4h-5L7 13.5c0-4.5 2-8.5 5-11z; c 12 10 2; p 7,17 4,21 8,20; p 17,17 20,21 16,20',
  'inbox':         'p 2.5,12 7,12 9,15.5 15,15.5 17,12 21.5,12; p 2.5,12 5.5,4.5 18.5,4.5 21.5,12 21.5,20 2.5,20 2.5,12',
  'loader':        'l 12 2.5 12 6.5; l 12 17.5 12 21.5; l 2.5 12 6.5 12; l 17.5 12 21.5 12; l 5.2 5.2 8 8; l 16 16 18.8 18.8; l 18.8 5.2 16 8; l 8 16 5.2 18.8',
  'square':        'r 4.5 4.5 15 15 1.5',
  'circle':        'c 12 12 8.5',
  'triangle':      'g 12,3.5 21,20 3,20',
  'anchor':        'c 12 5 2.5; l 12 7.5 12 21; l 7 12 17 12; d M3.5 15a8.5 8.5 0 0 0 17 0'
};

const ICON_ALIASES = {
  'sliders': 'settings', 'x': 'close', 'cancel': 'close', 'tick': 'check', 'add': 'plus', 'remove': 'minus',
  'hamburger': 'menu', 'dots': 'more-h', 'kebab': 'more-v', 'gear': 'settings', 'cog': 'settings',
  'left': 'chevron-left', 'right': 'chevron-right', 'up': 'chevron-up', 'down': 'chevron-down',
  'caret': 'chevron-down', 'back': 'arrow-left', 'forward': 'arrow-right',
  'person': 'user', 'people': 'users', 'team': 'users', 'account': 'user',
  'email': 'mail', 'envelope': 'mail', 'notification': 'bell', 'chat': 'message', 'comment': 'message',
  'doc': 'file-text', 'document': 'file-text', 'attachment': 'paperclip', 'delete': 'trash', 'bin': 'trash',
  'picture': 'image', 'photo': 'image', 'company': 'building', 'org': 'building', 'deal': 'briefcase',
  'money': 'dollar', 'inr': 'rupee', 'chart': 'bar-chart', 'graph': 'line-chart', 'pie': 'pie-chart',
  'date': 'calendar', 'time': 'clock', 'warning': 'alert', 'warn': 'alert', 'error': 'alert-circle',
  'success': 'check-circle', 'favourite': 'star', 'favorite': 'star', 'like': 'thumbs-up',
  'pencil': 'edit', 'write': 'edit', 'brush': 'palette', 'colour': 'palette', 'color': 'palette',
  'sound': 'volume', 'mute': 'volume-x', 'location': 'map-pin', 'pin': 'map-pin', 'world': 'globe',
  'spinner': 'loader', 'idea': 'lightbulb', 'flash': 'zap', 'secure': 'lock', 'password': 'lock',
  'more': 'more-h', 'ellipsis': 'more-h', 'overflow': 'more-h', 'options': 'more-v'
};

/* Rule: a search that cannot answer says who can. Widgets and icons are two
 * separate surfaces; a widget filter that finds nothing should point at the
 * other one rather than shrugging. Matches canonical names and aliases. */
function iconsMatching(q) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return [];
  const hits = [];
  for (const n of iconNames()) {
    if (n.indexOf(query) >= 0) { hits.push(n); continue; }
    const alts = ICON_ALIASES_BY_TARGET[n] || [];
    let hit = false;
    for (const a of alts) if (a.indexOf(query) >= 0) { hit = true; break; }
    if (hit) hits.push(n);
  }
  return hits;
}

// reverse index, so searching "email" finds "mail"
const ICON_ALIASES_BY_TARGET = (function () {
  const out = {};
  for (const a in ICON_ALIASES) {
    const t = ICON_ALIASES[a];
    (out[t] = out[t] || []).push(a);
  }
  return out;
})();

function resolveIconName(name) {
  const k = String(name || '').trim().toLowerCase().replace(/\s+/g, '-');
  if (ICON_SPECS[k]) return k;
  if (ICON_ALIASES[k] && ICON_SPECS[ICON_ALIASES[k]]) return ICON_ALIASES[k];
  return null;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgChild(svg, tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  svg.appendChild(el);
  return el;
}

function buildIconSvg(spec, size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('wf-svg');

  for (const raw of String(spec).split(';')) {
    const s = raw.trim();
    if (!s) continue;
    const op = s[0];
    const rest = s.slice(1).trim();
    if (op === 'd') { svgChild(svg, 'path', { d: rest }); continue; }
    if (op === 'p' || op === 'g') {
      svgChild(svg, op === 'p' ? 'polyline' : 'polygon', { points: rest.replace(/\s+/g, ' ') });
      continue;
    }
    const n = rest.split(/[\s,]+/).map(Number);
    if (op === 'c') svgChild(svg, 'circle', { cx: n[0], cy: n[1], r: n[2] });
    else if (op === 'r') svgChild(svg, 'rect', { x: n[0], y: n[1], width: n[2], height: n[3], rx: n[4] == null ? 0 : n[4] });
    else if (op === 'l') svgChild(svg, 'line', { x1: n[0], y1: n[1], x2: n[2], y2: n[3] });
    else if (op === 't') svgChild(svg, 'circle', { cx: n[0], cy: n[1], r: 1.35, fill: 'currentColor', stroke: 'none' });
  }
  return svg;
}

/* Append an icon to `host`. Unknown names fall back to Obsidian's bundled
 * Lucide set when it is reachable, so `icon: <any lucide name>` also works
 * inside the app — then to a labelled placeholder so a typo is visible
 * rather than silently blank. */
function iconEl(host, name, size) {
  const px = size || 16;
  const wrap = host.createSpan({ cls: 'wf-ico' });
  wrap.style.width = px + 'px';
  wrap.style.height = px + 'px';

  const key = resolveIconName(name);
  if (key) {
    wrap.appendChild(buildIconSvg(ICON_SPECS[key], px));
    return wrap;
  }
  try {
    if (typeof obsidian !== 'undefined' && obsidian && typeof obsidian.setIcon === 'function') {
      obsidian.setIcon(wrap, String(name).trim().toLowerCase());
      if (wrap.firstChild) {
        const svg = wrap.querySelector('svg');
        if (svg) { svg.setAttribute('width', String(px)); svg.setAttribute('height', String(px)); }
        return wrap;
      }
    }
  } catch (e) { /* not in Obsidian, or no such lucide icon */ }
  wrap.addClass('wf-ico-missing');
  wrap.setAttribute('title', 'no icon named "' + name + '"');
  return wrap;
}

function iconNames() {
  return Object.keys(ICON_SPECS).sort();
}

/* ------------------------------------------------------------------ *
 * Widget registry
 *
 * group / label / snippet / size drive the palette and Quick Add.
 * render(el, node, ctx) draws the widget into el.
 * ------------------------------------------------------------------ */

const WIDGETS = {};

function widget(names, spec) {
  const list = Array.isArray(names) ? names : [names];
  const canonical = list[0];
  spec.name = canonical;
  spec.aliases = list.slice(1);
  for (const n of list) WIDGETS[n] = spec;
}

/* ---------- Containers ---------- */

widget(['window', 'browser'], {
  group: 'Container', label: 'Browser window', size: [900, 620],
  snippet: 'window: Projects | app.example.com/projects\n  h1: Projects\n  text: Screen content goes here',
  render: function (el, node, ctx) {
    // "Tab title | url", either half optional. With one part we guess: something
    // that looks like an address is the address, anything else is the tab title.
    const parts = String(node.value || '').split('|');
    let titlePart = '', urlPart = '';
    if (parts.length > 1) {
      titlePart = parts[0].trim();
      urlPart = parts.slice(1).join('|').trim();
    } else {
      const only = (parts[0] || '').trim();
      if (/^https?:\/\//i.test(only) || /[a-z0-9-]+\.[a-z]{2,}/i.test(only) || only.indexOf('/') >= 0) urlPart = only;
      else titlePart = only;
    }

    // several tabs, separated by ";", "*" marking the open one
    const tabs = titlePart
      ? titlePart.split(';').map(function (t) {
          let x = t.trim(); let active = false;
          if (x.endsWith('*')) { active = true; x = x.slice(0, -1).trim(); }
          return { text: x, active: active };
        }).filter(function (t) { return t.text; })
      : [{ text: 'A Web Page', active: true }];
    if (!tabs.some(function (t) { return t.active; })) tabs[0].active = true;

    const tabBar = el.createDiv({ cls: 'wf-browser-tabs' });
    for (const t of tabs) {
      const tab = tabBar.createDiv({ cls: 'wf-browser-tab' + (t.active ? ' wf-active' : ''), text: t.text });
      void tab;
    }

    const bar = el.createDiv({ cls: 'wf-browser-bar' });
    const nav = bar.createDiv({ cls: 'wf-browser-nav' });
    iconEl(nav, 'arrow-left', 19);
    iconEl(nav, 'arrow-right', 19);
    iconEl(nav, 'refresh', 18);
    const addr = bar.createDiv({ cls: 'wf-browser-url' });
    const url = urlPart || 'https://';
    addr.createSpan({ cls: urlPart ? 'wf-value' : 'wf-placeholder', text: url });

    renderTree(el.createDiv({ cls: 'wf-browser-body wf-stack' }), node, ctx);
  }
});

widget(['phone', 'device'], {
  group: 'Container', label: 'Phone frame', size: [420, 780],
  snippet: 'phone: 9:41\n  nav: Projects\n  list:\n    Website redesign\n    Mobile app',
  render: function (el, node, ctx) {
    const bar = el.createDiv({ cls: 'wf-phone-status' });
    bar.createSpan({ text: node.value || '9:41' });
    const pi = bar.createSpan({ cls: 'wf-phone-icons' });
    iconEl(pi, 'wifi', 12); iconEl(pi, 'battery', 12);
    renderTree(el.createDiv({ cls: 'wf-phone-body wf-stack' }), node, ctx);
  }
});

widget(['card', 'panel', 'box'], {
  group: 'Container', label: 'Card / panel', size: [380, 240],
  snippet: 'card: Project summary\n  kv:\n    Status | In progress\n    Due | 12 Mar',
  render: function (el, node, ctx) {
    if (node.value) el.createDiv({ cls: 'wf-card-title', text: node.value });
    renderTree(el.createDiv({ cls: 'wf-card-body wf-stack' }), node, ctx);
  }
});

widget(['screen'], {
  group: 'Container', label: 'Screen (titled frame)', size: [900, 620],
  snippet: 'screen: 2. Project detail\n  h1: Website redesign\n  btn: Save (primary)',
  render: function (el, node, ctx) {
    el.createDiv({ cls: 'wf-screen-title', text: node.value || 'Screen' });
    renderTree(el.createDiv({ cls: 'wf-screen-body wf-stack' }), node, ctx);
  }
});

widget(['modal', 'dialog'], {
  group: 'Container', label: 'Modal dialog', size: [520, 320],
  snippet: 'modal: Delete this project?\n  text: This cannot be undone.\n  row:\n    btn: Cancel\n    btn: Delete (danger)',
  render: function (el, node, ctx) {
    const head = el.createDiv({ cls: 'wf-modal-head' });
    head.createDiv({ cls: 'wf-modal-title', text: node.value || 'Dialog' });
    iconEl(head.createDiv({ cls: 'wf-modal-x' }), 'close', 14);
    renderTree(el.createDiv({ cls: 'wf-modal-body wf-stack' }), node, ctx);
  }
});

widget(['row', 'hbox'], {
  group: 'Container', label: 'Row (horizontal)', size: [520, 80],
  snippet: 'row:\n  input: Search...\n  btn: Go (primary)',
  render: function (el, node, ctx) {
    const info = splitMods(node.value);
    const box = el.createDiv({ cls: 'wf-row-box' });
    applyMods(box, info.mods);
    renderTree(box, node, ctx);
  }
});

widget(['col', 'vbox', 'stack'], {
  group: 'Container', label: 'Column (vertical)', size: [320, 240],
  snippet: 'col:\n  h2: Section\n  text: Body copy',
  render: function (el, node, ctx) {
    const info = splitMods(node.value);
    const box = el.createDiv({ cls: 'wf-col-box wf-stack' });
    applyMods(box, info.mods);
    renderTree(box, node, ctx);
  }
});

widget(['scroll'], {
  group: 'Container', label: 'Scroll area', size: [360, 240],
  snippet: 'scroll:\n  lorem: 60',
  render: function (el, node, ctx) {
    const box = el.createDiv({ cls: 'wf-scroll-box wf-stack' });
    renderTree(box, node, ctx);
    el.createDiv({ cls: 'wf-scrollbar' }).createDiv({ cls: 'wf-scrollthumb' });
  }
});

/* ---------- Navigation ---------- */

widget(['nav', 'navbar', 'header'], {
  group: 'Navigation', label: 'Nav bar', size: [860, 72],
  snippet: 'nav: Projects* | People | Reports | Settings',
  render: function (el, node) {
    const items = splitItems(node.value);
    let brand = null;
    if (items.length && /^[A-Z]/.test(items[0].text) && items.length > 2 && !items[0].active) {
      // leave brand detection to explicit syntax instead of guessing
    }
    const bar = el.createDiv({ cls: 'wf-navbar' });
    for (const it of items) {
      const a = bar.createDiv({ cls: 'wf-navitem', text: it.text });
      if (it.active) a.addClass('wf-active');
      if (it.disabled) a.addClass('wf-m-disabled');
    }
    void brand;
  }
});

widget(['tabs'], {
  group: 'Navigation', label: 'Tab strip', size: [520, 56],
  snippet: 'tabs: Overview* | Activity | Files | Notes',
  render: function (el, node) {
    const bar = el.createDiv({ cls: 'wf-tabs' });
    for (const it of splitItems(node.value)) {
      const t = bar.createDiv({ cls: 'wf-tab', text: it.text });
      if (it.active) t.addClass('wf-active');
      if (it.disabled) t.addClass('wf-m-disabled');
    }
  }
});

widget(['sidebar', 'sidenav'], {
  group: 'Navigation', label: 'Sidebar nav', size: [220, 400],
  snippet: 'sidebar: Dashboard | Projects* | People | Reports | Settings',
  render: function (el, node) {
    const bar = el.createDiv({ cls: 'wf-sidebar' });
    for (const it of splitItems(node.value)) {
      const t = bar.createDiv({ cls: 'wf-sideitem' });
      if (it.icon) iconEl(t.createSpan({ cls: 'wf-sideglyph' }), it.icon, 14);
      else t.addClass('wf-noglyph');
      t.createSpan({ text: it.text });
      if (it.active) t.addClass('wf-active');
      if (it.disabled) t.addClass('wf-m-disabled');
    }
  }
});

widget(['breadcrumb', 'crumbs'], {
  group: 'Navigation', label: 'Breadcrumb', size: [420, 40],
  snippet: 'breadcrumb: Projects | Website redesign | Settings',
  render: function (el, node) {
    const bar = el.createDiv({ cls: 'wf-crumbs' });
    const items = splitItems(node.value);
    items.forEach(function (it, i) {
      if (i) iconEl(bar.createSpan({ cls: 'wf-crumb-sep' }), 'chevron-right', 12);
      const c = bar.createSpan({ cls: 'wf-crumb', text: it.text });
      if (i === items.length - 1) c.addClass('wf-active');
    });
  }
});

widget(['steps', 'wizard'], {
  group: 'Navigation', label: 'Step indicator', size: [520, 64],
  snippet: 'steps: Details | Pricing* | Review | Done',
  render: function (el, node) {
    const bar = el.createDiv({ cls: 'wf-steps' });
    const items = splitItems(node.value);
    let activeIdx = items.findIndex(function (i) { return i.active; });
    if (activeIdx < 0) activeIdx = 0;
    items.forEach(function (it, i) {
      if (i) bar.createDiv({ cls: 'wf-step-line' + (i <= activeIdx ? ' wf-done' : '') });
      const s = bar.createDiv({ cls: 'wf-step' });
      const dot = s.createDiv({ cls: 'wf-step-dot' });
      if (i < activeIdx) iconEl(dot, 'check', 13); else dot.setText(String(i + 1));
      if (i < activeIdx) dot.addClass('wf-done');
      if (i === activeIdx) dot.addClass('wf-active');
      s.createDiv({ cls: 'wf-step-label', text: it.text });
    });
  }
});

widget(['pagination', 'pager'], {
  group: 'Navigation', label: 'Pagination', size: [300, 48],
  snippet: 'pagination: 1 | 2* | 3 | 4 | 5',
  render: function (el, node) {
    const bar = el.createDiv({ cls: 'wf-pager' });
    iconEl(bar.createDiv({ cls: 'wf-page' }), 'chevron-left', 13);
    for (const it of splitItems(node.value)) {
      const p = bar.createDiv({ cls: 'wf-page', text: it.text });
      if (it.active) p.addClass('wf-active');
    }
    iconEl(bar.createDiv({ cls: 'wf-page' }), 'chevron-right', 13);
  }
});

widget(['toolbar'], {
  group: 'Navigation', label: 'Icon toolbar', size: [280, 48],
  snippet: 'toolbar: edit | trash | download | more',
  render: function (el, node) {
    const bar = el.createDiv({ cls: 'wf-toolbar' });
    for (const it of splitItems(node.value)) {
      const b = bar.createDiv({ cls: 'wf-toolbtn' });
      iconEl(b, it.text, 16);
      if (it.active) b.addClass('wf-active');
      b.setAttribute('title', it.text);
    }
  }
});

/* ---------- Inputs ---------- */

function fieldWrap(el, labelText) {
  if (!labelText) return el.createDiv({ cls: 'wf-field' });
  const f = el.createDiv({ cls: 'wf-field' });
  f.createDiv({ cls: 'wf-label', text: labelText });
  return f;
}

// "Email address = you@example.com" -> label + filled value
function labelValue(raw) {
  const info = splitMods(raw);
  const eq = info.text.indexOf('=');
  if (eq >= 0) return { label: info.text.slice(0, eq).trim(), value: info.text.slice(eq + 1).trim(), filled: true, mods: info.mods, style: info.style };
  return { label: '', value: info.text, filled: false, mods: info.mods, style: info.style };
}

widget(['input', 'field', 'text-input'], {
  group: 'Input', label: 'Text input', size: [340, 76],
  snippet: 'input: Email address = you@example.com',
  render: function (el, node) {
    const lv = labelValue(node.value);
    const f = fieldWrap(el, lv.label);
    const box = f.createDiv({ cls: 'wf-input' });
    applyMods(box, lv.mods); applyStyle(box, lv.style);
    box.createSpan({ cls: lv.filled ? 'wf-value' : 'wf-placeholder', text: lv.value || 'Placeholder' });
    if (lv.filled) box.createSpan({ cls: 'wf-caret' });
  }
});

widget(['password'], {
  group: 'Input', label: 'Password field', size: [340, 76],
  snippet: 'password: Password',
  render: function (el, node) {
    const lv = labelValue(node.value);
    const f = fieldWrap(el, lv.label || node.value);
    const box = f.createDiv({ cls: 'wf-input' });
    box.createSpan({ cls: 'wf-value', text: '••••••••••' });
  }
});

widget(['search'], {
  group: 'Input', label: 'Search box', size: [340, 56],
  snippet: 'search: Filter projects...',
  render: function (el, node) {
    const info = splitMods(node.value);
    const box = el.createDiv({ cls: 'wf-input wf-search' });
    applyMods(box, info.mods); applyStyle(box, info.style);
    iconEl(box.createSpan({ cls: 'wf-inputicon' }), 'search', 14);
    box.createSpan({ cls: 'wf-placeholder', text: info.text || 'Search' });
  }
});

widget(['textarea'], {
  group: 'Input', label: 'Textarea', size: [340, 140],
  snippet: 'textarea: Notes',
  render: function (el, node) {
    const lv = labelValue(node.value);
    const f = fieldWrap(el, lv.label);
    const box = f.createDiv({ cls: 'wf-textarea' });
    applyMods(box, lv.mods); applyStyle(box, lv.style);
    box.createSpan({ cls: lv.filled ? 'wf-value' : 'wf-placeholder', text: lv.value || 'Multi-line text' });
    box.createDiv({ cls: 'wf-resize', text: '⌟' });
  }
});

widget(['select', 'dropdown'], {
  group: 'Input', label: 'Dropdown', size: [340, 76],
  snippet: 'select: Status | Planned | In progress* | Done',
  render: function (el, node) {
    const items = splitItems(node.value);
    let label = '', chosen = '';
    if (items.length > 1) {
      const act = items.filter(function (i) { return i.active; });
      label = items[0].text;
      chosen = act.length ? act[0].text : items[1].text;
      if (items[0].active) { label = ''; chosen = items[0].text; }
    } else if (items.length === 1) { chosen = items[0].text; }
    const f = fieldWrap(el, label);
    const box = f.createDiv({ cls: 'wf-input wf-select' });
    box.createSpan({ cls: 'wf-value', text: chosen || 'Choose one' });
    iconEl(box.createSpan({ cls: 'wf-caret-glyph' }), 'chevron-down', 14);
  }
});

widget(['checkbox', 'check'], {
  group: 'Input', label: 'Checkbox / group', size: [300, 100],
  snippet: 'checkbox:\n  [x] Email me updates\n  [ ] Send weekly digest',
  render: function (el, node) {
    const rows = dataRows(node);
    const list = rows.length ? rows : (node.value ? [node.value] : ['[ ] Option']);
    const box = el.createDiv({ cls: 'wf-checkgroup' });
    for (const r of list) {
      const st = checkState(r);
      const line = box.createDiv({ cls: 'wf-checkline' });
      const mark = line.createDiv({ cls: 'wf-checkbox' });
      if (st.checked) iconEl(mark, 'check', 11);
      if (st.checked) mark.addClass('wf-checked');
      line.createSpan({ text: st.text });
    }
  }
});

widget(['radio', 'radios'], {
  group: 'Input', label: 'Radio group', size: [300, 100],
  snippet: 'radio:\n  (o) Monthly\n  ( ) Annual',
  render: function (el, node) {
    const rows = dataRows(node);
    const list = rows.length ? rows : splitItems(node.value).map(function (i, idx) { return (i.active || (idx === 0 && !splitItems(node.value).some(function (x) { return x.active; })) ? '(o) ' : '( ) ') + i.text; });
    const box = el.createDiv({ cls: 'wf-checkgroup' });
    for (const r of list) {
      const st = checkState(r);
      const line = box.createDiv({ cls: 'wf-checkline' });
      const mark = line.createDiv({ cls: 'wf-radio' });
      if (st.checked) { mark.addClass('wf-checked'); mark.createDiv({ cls: 'wf-radio-in' }); }
      line.createSpan({ text: st.text });
    }
  }
});

widget(['toggle', 'switch'], {
  group: 'Input', label: 'Toggle switch', size: [280, 48],
  snippet: 'toggle: [x] Email me about updates',
  render: function (el, node) {
    const st = checkState(node.value);
    const line = el.createDiv({ cls: 'wf-checkline' });
    const sw = line.createDiv({ cls: 'wf-switch' + (st.checked ? ' wf-checked' : '') });
    sw.createDiv({ cls: 'wf-knob' });
    line.createSpan({ text: st.text || 'Setting' });
  }
});

widget(['slider', 'range'], {
  group: 'Input', label: 'Slider', size: [300, 60],
  snippet: 'slider: Budget | 60',
  render: function (el, node) {
    const parts = String(node.value || '').split('|');
    let label = '', pct = 50;
    if (parts.length > 1) { label = parts[0].trim(); pct = Number(parts[1]) || 50; }
    else { pct = Number(parts[0]) || 50; }
    const f = fieldWrap(el, label);
    const track = f.createDiv({ cls: 'wf-track' });
    track.createDiv({ cls: 'wf-track-fill' }).style.width = Math.max(0, Math.min(100, pct)) + '%';
    const knob = track.createDiv({ cls: 'wf-knob-round' });
    knob.style.left = Math.max(0, Math.min(100, pct)) + '%';
  }
});

widget(['date', 'datepicker'], {
  group: 'Input', label: 'Date picker', size: [300, 76],
  snippet: 'date: Close date = 12 Mar 2026',
  render: function (el, node) {
    const lv = labelValue(node.value);
    const f = fieldWrap(el, lv.label);
    const box = f.createDiv({ cls: 'wf-input wf-select' });
    box.createSpan({ cls: lv.filled ? 'wf-value' : 'wf-placeholder', text: lv.value || 'dd / mm / yyyy' });
    iconEl(box.createSpan({ cls: 'wf-caret-glyph' }), 'calendar', 14);
  }
});

widget(['upload', 'dropzone'], {
  group: 'Input', label: 'File dropzone', size: [340, 130],
  snippet: 'upload: Drop a CSV here, or browse',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-dropzone' });
    iconEl(box.createDiv({ cls: 'wf-dz-glyph' }), 'upload-cloud', 22);
    box.createDiv({ text: node.value || 'Drop files here' });
  }
});

widget(['stepper', 'numberinput'], {
  group: 'Input', label: 'Number stepper', size: [180, 56],
  snippet: 'stepper: 3',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-stepper' });
    iconEl(box.createDiv({ cls: 'wf-step-btn' }), 'minus', 13);
    box.createDiv({ cls: 'wf-step-val', text: String(node.value || '1').trim() });
    iconEl(box.createDiv({ cls: 'wf-step-btn' }), 'plus', 13);
  }
});

/* ---------- Actions ---------- */

widget(['btn', 'button'], {
  group: 'Action', label: 'Button', size: [200, 56],
  snippet: 'btn: Save changes (primary)',
  render: function (el, node) {
    const info = splitMods(node.value);
    const b = el.createDiv({ cls: 'wf-btn', text: info.text || 'Button' });
    applyMods(b, info.mods); applyStyle(b, info.style);
  }
});

widget(['btns', 'buttongroup', 'btngroup'], {
  group: 'Action', label: 'Button group', size: [320, 56],
  snippet: 'btns: Day | Week* | Month',
  render: function (el, node) {
    const g = el.createDiv({ cls: 'wf-btngroup' });
    for (const it of splitItems(node.value)) {
      const b = g.createDiv({ cls: 'wf-btn wf-seg', text: it.text });
      if (it.active) b.addClass('wf-active');
      if (it.disabled) b.addClass('wf-m-disabled');
    }
  }
});

widget(['link', 'a'], {
  group: 'Action', label: 'Text link', size: [180, 40],
  snippet: 'link: Forgot password?',
  render: function (el, node) {
    const info = splitMods(node.value);
    const a = el.createDiv({ cls: 'wf-link', text: info.text || 'Link text' });
    applyMods(a, info.mods);
  }
});

widget(['icon'], {
  group: 'Action', label: 'Icon', size: [80, 80],
  snippet: 'icon: briefcase',
  render: function (el, node) {
    const info = splitMods(node.value);
    const box = el.createDiv({ cls: 'wf-icon' });
    const sz = info.style.width ? parseInt(info.style.width, 10) : 22;
    iconEl(box, info.text || 'square', sz);
    if (info.mods.indexOf('large') >= 0) box.addClass('wf-m-large');
  }
});

widget(['fab'], {
  group: 'Action', label: 'Floating action button', size: [90, 90],
  snippet: 'fab: plus',
  render: function (el, node) {
    iconEl(el.createDiv({ cls: 'wf-fab' }), node.value || 'plus', 22);
  }
});

/* ---------- Display ---------- */

['h1', 'h2', 'h3'].forEach(function (h) {
  widget([h], {
    group: 'Display', label: 'Heading ' + h.slice(1), size: [360, 56],
    snippet: h + ': Section heading',
    render: function (el, node) {
      const info = splitMods(node.value);
      const d = el.createDiv({ cls: 'wf-heading wf-' + h, text: info.text || 'Heading' });
      applyMods(d, info.mods);
    }
  });
});

widget(['text', 'p', 'label', 'textbox', 'caption'], {
  group: 'Display', label: 'Paragraph', size: [360, 80],
  snippet: 'text: A short line of body copy.',
  render: function (el, node) {
    const info = splitMods(node.value);
    const rows = dataRows(node);
    const body = rows.length ? rows.join(' ') : info.text;
    const d = el.createDiv({ cls: 'wf-text', text: body || '' });
    applyMods(d, info.mods); applyStyle(d, info.style);
  }
});

widget(['lorem', 'greek', 'placeholder-text'], {
  group: 'Display', label: 'Greeked text', size: [360, 100],
  snippet: 'lorem: 40',
  render: function (el, node) {
    const n = Number(String(node.value || '').trim()) || 24;
    el.createDiv({ cls: 'wf-text wf-greek', text: loremWords(n) });
  }
});

widget(['img', 'image'], {
  group: 'Display', label: 'Image placeholder', size: [320, 200],
  snippet: 'img: 320x180',
  render: function (el, node) {
    const info = splitMods(node.value);
    const dims = parseDims(info.text);
    const box = el.createDiv({ cls: 'wf-img' });
    if (dims) { box.style.width = dims.w + 'px'; box.style.height = dims.h + 'px'; box.style.flex = '0 0 auto'; }
    applyStyle(box, info.style);
    box.createDiv({ cls: 'wf-img-x' });
    const cap = dims ? dims.w + ' × ' + dims.h : (info.text || 'image');
    box.createDiv({ cls: 'wf-img-label', text: cap });
  }
});

widget(['avatar'], {
  group: 'Display', label: 'Avatar / stack', size: [120, 72],
  snippet: 'avatar: AB',
  render: function (el, node) {
    const v = String(node.value || 'A').trim();
    const asCount = /^\d+$/.test(v) ? Number(v) : 0;
    const box = el.createDiv({ cls: 'wf-avatars' });
    if (asCount) {
      for (let i = 0; i < Math.min(asCount, 5); i++) box.createDiv({ cls: 'wf-avatar', text: '○' });
      if (asCount > 5) box.createDiv({ cls: 'wf-avatar wf-avatar-more', text: '+' + (asCount - 5) });
    } else {
      for (const it of splitItems(v)) box.createDiv({ cls: 'wf-avatar', text: it.text.slice(0, 2).toUpperCase() });
    }
  }
});

widget(['list', 'ul'], {
  group: 'Display', label: 'List', size: [340, 180],
  snippet: 'list:\n  Website redesign\n  Mobile app\n  -\n  Onboarding flow',
  render: function (el, node) {
    const rows = dataRows(node);
    const src = rows.length ? rows : splitItems(node.value).map(function (i) { return (i.active ? '* ' : '') + i.text; });
    const box = el.createDiv({ cls: 'wf-list' });
    for (const raw of src) {
      let t = raw.trim();
      if (t === '-' || t === '--' || t === '---') { box.createDiv({ cls: 'wf-list-sep' }); continue; }
      let selected = false;
      if (t.startsWith('*')) { selected = true; t = t.slice(1).trim(); }
      if (t.startsWith('-')) t = t.slice(1).trim();
      const st = checkState(t);
      const row = box.createDiv({ cls: 'wf-list-item' + (selected ? ' wf-selected' : '') });
      if (st.explicit) {
        const mark = row.createDiv({ cls: 'wf-checkbox' });
        if (st.checked) { iconEl(mark, 'check', 11); mark.addClass('wf-checked'); }
        row.createSpan({ text: st.text });
      } else {
        row.createSpan({ text: t });
      }
    }
  }
});

widget(['table', 'grid', 'datagrid'], {
  group: 'Display', label: 'Data table', size: [560, 240],
  snippet: 'table:\n  Name | Status | Owner\n  * Website redesign | In progress | Design\n  Mobile app | Done | Engineering\n  Onboarding flow | Planned | Support',
  render: function (el, node) {
    const info = splitMods(node.value);
    const rows = dataRows(node);
    const noHeader = info.mods.indexOf('flat') >= 0;
    const table = el.createDiv({ cls: 'wf-table' });
    rows.forEach(function (raw, idx) {
      let t = raw.trim();
      if (/^-{1,3}$/.test(t)) { table.createDiv({ cls: 'wf-tr-sep' }); return; }
      let selected = false;
      if (t.startsWith('*')) { selected = true; t = t.slice(1).trim(); }
      const isHeader = idx === 0 && !noHeader && !selected;
      const tr = table.createDiv({ cls: 'wf-tr' + (isHeader ? ' wf-th' : '') + (selected ? ' wf-selected' : '') });
      const cells = t.split('|');
      cells.forEach(function (c) { tr.createDiv({ cls: 'wf-td', text: c.trim() }); });
    });
    if (!rows.length) table.createDiv({ cls: 'wf-tr wf-th' }).createDiv({ cls: 'wf-td', text: 'Column' });
  }
});

widget(['kv', 'details', 'dl'], {
  group: 'Display', label: 'Key / value pairs', size: [340, 160],
  snippet: 'kv:\n  Status | In progress\n  Owner | Design\n  Due | 12 Mar',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-kv' });
    for (const raw of dataRows(node)) {
      const parts = raw.split('|');
      const row = box.createDiv({ cls: 'wf-kv-row' });
      row.createDiv({ cls: 'wf-kv-k', text: (parts[0] || '').trim() });
      row.createDiv({ cls: 'wf-kv-v', text: parts.slice(1).join('|').trim() || '—' });
    }
  }
});

widget(['badge', 'tag', 'chip'], {
  group: 'Display', label: 'Badge / chips', size: [200, 44],
  snippet: 'badge: Draft | Active* | Archived',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-badges' });
    for (const it of splitItems(node.value)) {
      const b = box.createDiv({ cls: 'wf-badge', text: it.text });
      if (it.active) b.addClass('wf-active');
    }
  }
});

widget(['alert', 'banner'], {
  group: 'Display', label: 'Alert banner', size: [400, 64],
  snippet: 'alert: Import finished with 3 warnings (warning)',
  render: function (el, node) {
    const info = splitMods(node.value);
    const box = el.createDiv({ cls: 'wf-alert' });
    applyMods(box, info.mods);
    const glyph = info.mods.indexOf('error') >= 0 ? 'warn' : info.mods.indexOf('success') >= 0 ? 'check' : 'info';
    iconEl(box.createSpan({ cls: 'wf-alert-glyph' }), glyph, 16);
    box.createSpan({ text: info.text || 'Message' });
  }
});

widget(['progress'], {
  group: 'Display', label: 'Progress bar', size: [300, 56],
  snippet: 'progress: Import | 70',
  render: function (el, node) {
    const parts = String(node.value || '').split('|');
    let label = '', pct = 50;
    if (parts.length > 1) { label = parts[0].trim(); pct = Number(parts[1]) || 0; }
    else pct = Number(parts[0]) || 0;
    const f = fieldWrap(el, label);
    const bar = f.createDiv({ cls: 'wf-progress' });
    bar.createDiv({ cls: 'wf-progress-fill' }).style.width = Math.max(0, Math.min(100, pct)) + '%';
    f.createDiv({ cls: 'wf-progress-pct', text: Math.round(pct) + '%' });
  }
});

widget(['chart', 'bars'], {
  group: 'Display', label: 'Bar chart', size: [360, 220],
  snippet: 'chart: Projects by status\n  Planned | 40\n  In progress | 75\n  Done | 55\n  Blocked | 20',
  render: function (el, node) {
    if (node.value) el.createDiv({ cls: 'wf-chart-title', text: node.value });
    const rows = dataRows(node).map(function (r) {
      const p = r.split('|');
      return { label: (p[0] || '').trim(), v: Number(p[1]) || 0 };
    });
    const max = rows.reduce(function (a, r) { return Math.max(a, r.v); }, 1);
    const box = el.createDiv({ cls: 'wf-chart' });
    for (const r of rows) {
      const col = box.createDiv({ cls: 'wf-chart-col' });
      const bar = col.createDiv({ cls: 'wf-chart-bar' });
      bar.style.height = Math.max(4, (r.v / max) * 100) + '%';
      col.createDiv({ cls: 'wf-chart-label', text: r.label });
    }
    if (!rows.length) box.createDiv({ cls: 'wf-chart-empty', text: 'label | value rows' });
  }
});

widget(['stat', 'metric', 'kpi'], {
  group: 'Display', label: 'Stat tile', size: [200, 110],
  snippet: 'stat: 1,284 | Tasks done this quarter',
  render: function (el, node) {
    const parts = String(node.value || '').split('|');
    const box = el.createDiv({ cls: 'wf-stat' });
    box.createDiv({ cls: 'wf-stat-num', text: (parts[0] || '0').trim() });
    box.createDiv({ cls: 'wf-stat-label', text: (parts[1] || 'Metric').trim() });
  }
});

widget(['empty', 'emptystate'], {
  group: 'Display', label: 'Empty state', size: [360, 200],
  snippet: 'empty: No projects yet | Create your first project',
  render: function (el, node) {
    const parts = String(node.value || '').split('|');
    const box = el.createDiv({ cls: 'wf-empty' });
    iconEl(box.createDiv({ cls: 'wf-empty-glyph' }), 'inbox', 30);
    box.createDiv({ cls: 'wf-empty-title', text: (parts[0] || 'Nothing here yet').trim() });
    if (parts[1]) box.createDiv({ cls: 'wf-btn wf-m-primary', text: parts[1].trim() });
  }
});

widget(['spinner', 'loading'], {
  group: 'Display', label: 'Loading state', size: [200, 80],
  snippet: 'spinner: Loading projects',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-spinner-box' });
    iconEl(box.createDiv({ cls: 'wf-spinner' }), 'loader', 17);
    box.createSpan({ text: node.value || 'Loading…' });
  }
});

/* ---------- Annotations (redlining) ---------- *
 * Job B6: argue with the wireframe on the wireframe. This is a first-class
 * group with its own slot in the rail, not an afterthought, because saying
 * "this bit is unresolved" next to the thing it is about is half of what a
 * lo-fi wireframe is for. Divider and spacer used to live here; they are
 * layout, not commentary, so they moved out.
 */

widget(['note', 'sticky'], {
  group: 'Annotations', label: 'Sticky note', size: [240, 140],
  snippet: 'note: Check this wording with the team',
  render: function (el, node) {
    const rows = dataRows(node);
    const box = el.createDiv({ cls: 'wf-note' });
    if (rows.length) {
      // keep the lines the user typed; a sticky note is a list as often as a sentence
      for (const line of rows) box.createDiv({ cls: 'wf-note-line', text: line });
    } else {
      box.setText(node.value || 'Note');
    }
  }
});

widget(['callout', 'marker'], {
  group: 'Annotations', label: 'Numbered callout', size: [340, 56],
  snippet: 'callout: 1 | Status defaults to Planned',
  render: function (el, node) {
    const parts = String(node.value || '').split('|');
    const box = el.createDiv({ cls: 'wf-callout' });
    box.createDiv({ cls: 'wf-callout-num', text: (parts[0] || '1').trim() });
    box.createSpan({ text: parts.slice(1).join('|').trim() });
  }
});

widget(['divider', 'hr', 'sep'], {
  group: 'Display', label: 'Divider', size: [340, 24],
  snippet: 'divider:',
  render: function (el, node) {
    if (node.value) {
      const d = el.createDiv({ cls: 'wf-divider-label' });
      d.createDiv({ cls: 'wf-divline' });
      d.createSpan({ text: node.value });
      d.createDiv({ cls: 'wf-divline' });
    } else {
      el.createDiv({ cls: 'wf-divline' });
    }
  }
});

widget(['spacer', 'gap'], {
  group: 'Display', label: 'Spacer', size: [340, 40],
  snippet: 'spacer: 24',
  render: function (el, node) {
    const h = Number(String(node.value || '').trim()) || 16;
    el.createDiv({ cls: 'wf-spacer' }).style.height = h + 'px';
  }
});

/* ---------- Chart / SVG helpers ---------- */

function svgBox(host, w, h, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('fill', 'none');
  if (cls) svg.classList.add(cls);
  host.appendChild(svg);
  return svg;
}

function numRows(node) {
  return dataRows(node).map(function (r) {
    const p = r.split('|');
    return { label: (p[0] || '').trim(), v: Number(p[1]) || 0 };
  }).filter(function (r) { return r.label || r.v; });
}

/* ---------- Controls that were missing ---------- */

widget(['accordion'], {
  group: 'Navigation', label: 'Accordion', size: [360, 220],
  snippet: 'accordion:\n  * Project details | Status, owner and dates live here\n  People\n  Activity history',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-accordion' });
    for (const raw of dataRows(node)) {
      let t = raw.trim(); let open = false;
      if (t.startsWith('*')) { open = true; t = t.slice(1).trim(); }
      const parts = t.split('|');
      const sec = box.createDiv({ cls: 'wf-acc-sec' + (open ? ' wf-open' : '') });
      const head = sec.createDiv({ cls: 'wf-acc-head' });
      iconEl(head, open ? 'chevron-down' : 'chevron-right', 13);
      head.createSpan({ text: (parts[0] || 'Section').trim() });
      if (open) sec.createDiv({ cls: 'wf-acc-body', text: parts.slice(1).join('|').trim() || loremWords(14) });
    }
  }
});

widget(['vtabs', 'verticaltabs'], {
  group: 'Navigation', label: 'Vertical tabs', size: [200, 200],
  snippet: 'vtabs: General* | Members | Billing | Advanced',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-vtabs' });
    for (const it of splitItems(node.value)) {
      const t = box.createDiv({ cls: 'wf-vtab', text: it.text });
      if (it.active) t.addClass('wf-active');
      if (it.disabled) t.addClass('wf-m-disabled');
    }
  }
});

widget(['tree', 'treepane'], {
  group: 'Navigation', label: 'Tree / file pane', size: [260, 240],
  snippet: 'tree:\n  Projects\n    Website redesign\n    * Mobile app\n  People\n  Reports',
  render: function (el, node) {
    const rows = flatRows(node);
    const box = el.createDiv({ cls: 'wf-tree' });
    for (const r of rows) {
      let t = r.value.trim();
      let sel = false;
      if (t.startsWith('*')) { sel = true; t = t.slice(1).trim(); }
      const row = box.createDiv({ cls: 'wf-tree-row' + (sel ? ' wf-selected' : '') });
      row.style.paddingLeft = (7 + r.depth * 15) + 'px';
      iconEl(row, r.hasKids ? 'chevron-down' : 'file', 12);
      row.createSpan({ text: t });
    }
    if (!rows.length) box.createDiv({ cls: 'wf-tree-row', text: 'indent rows to nest' });
  }
});

widget(['menu', 'dropdown-menu', 'contextmenu'], {
  group: 'Navigation', label: 'Open menu', size: [240, 220],
  snippet: 'menu:\n  Rename\n  Duplicate\n  -\n  * Move to folder\n  [x] Show archived\n  -\n  Delete',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-menu' });
    for (const raw of dataRows(node)) {
      let t = raw.trim();
      if (/^-{1,3}$/.test(t)) { box.createDiv({ cls: 'wf-menu-sep' }); continue; }
      let hi = false, sub = false;
      if (t.startsWith('*')) { hi = true; t = t.slice(1).trim(); }
      if (t.endsWith('>')) { sub = true; t = t.slice(0, -1).trim(); }
      const st = checkState(t);
      const row = box.createDiv({ cls: 'wf-menu-row' + (hi ? ' wf-active' : '') });
      const tick = row.createDiv({ cls: 'wf-menu-tick' });
      if (st.explicit && st.checked) iconEl(tick, 'check', 12);
      row.createSpan({ cls: 'wf-menu-label', text: st.explicit ? st.text : t });
      if (sub) iconEl(row, 'chevron-right', 12);
    }
  }
});

widget(['menubar'], {
  group: 'Navigation', label: 'Menu bar', size: [340, 40],
  snippet: 'menubar: File | Edit* | View | Help',
  render: function (el, node) {
    const bar = el.createDiv({ cls: 'wf-menubar' });
    for (const it of splitItems(node.value)) {
      const b = bar.createDiv({ cls: 'wf-menubar-item', text: it.text });
      if (it.active) b.addClass('wf-active');
    }
  }
});

widget(['scrollbar'], {
  group: 'Navigation', label: 'Scroll bar', size: [40, 200],
  snippet: 'scrollbar: 30',
  render: function (el, node) {
    const pct = Math.max(0, Math.min(90, Number(String(node.value || '20').trim()) || 20));
    const bar = el.createDiv({ cls: 'wf-sbar' });
    const thumb = bar.createDiv({ cls: 'wf-sbar-thumb' });
    thumb.style.top = pct + '%';
  }
});

/* --- inputs --- */

widget(['colorpicker', 'swatches'], {
  group: 'Input', label: 'Colour picker', size: [220, 120],
  snippet: 'colorpicker: 8',
  render: function (el, node) {
    const n = Math.max(4, Math.min(24, Number(String(node.value || '8').trim()) || 8));
    const box = el.createDiv({ cls: 'wf-swatches' });
    for (let i = 0; i < n; i++) {
      const sw = box.createDiv({ cls: 'wf-swatch' });
      const shade = 12 + Math.round((i / Math.max(1, n - 1)) * 74);
      sw.style.background = 'hsl(0 0% ' + shade + '%)';
      if (i === 1) sw.addClass('wf-active');
    }
  }
});

widget(['calendar', 'monthview'], {
  group: 'Input', label: 'Calendar month', size: [300, 260],
  snippet: 'calendar: March 2026 | 12',
  render: function (el, node) {
    const parts = String(node.value || '').split('|');
    const title = (parts[0] || 'Month YYYY').trim();
    const sel = Number(parts[1]) || 0;
    const box = el.createDiv({ cls: 'wf-cal' });
    const head = box.createDiv({ cls: 'wf-cal-head' });
    iconEl(head, 'chevron-left', 13);
    head.createSpan({ cls: 'wf-cal-title', text: title });
    iconEl(head, 'chevron-right', 13);
    const dow = box.createDiv({ cls: 'wf-cal-grid wf-cal-dow' });
    for (const d of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) dow.createDiv({ text: d });
    const grid = box.createDiv({ cls: 'wf-cal-grid' });
    for (let i = 1; i <= 35; i++) {
      const day = i - 2;
      const cell = grid.createDiv({ cls: 'wf-cal-day', text: day >= 1 && day <= 31 ? String(day) : '' });
      if (day < 1 || day > 31) cell.addClass('wf-muted');
      if (sel && day === sel) cell.addClass('wf-active');
    }
  }
});

widget(['rating', 'stars'], {
  group: 'Input', label: 'Star rating', size: [180, 44],
  snippet: 'rating: 4 of 5',
  render: function (el, node) {
    const m = String(node.value || '4 of 5').match(/(\d+)\s*(?:of|\/)\s*(\d+)/);
    const filled = m ? Number(m[1]) : 4;
    const total = m ? Number(m[2]) : 5;
    const box = el.createDiv({ cls: 'wf-rating' });
    for (let i = 0; i < Math.min(10, total); i++) {
      const s = box.createDiv({ cls: 'wf-star' + (i < filled ? ' wf-filled' : '') });
      iconEl(s, 'star', 16);
    }
  }
});

widget(['fieldset', 'group'], {
  group: 'Container', label: 'Field set', size: [340, 180],
  snippet: 'fieldset: Billing address\n  input: Street\n  input: City',
  render: function (el, node, ctx) {
    const box = el.createDiv({ cls: 'wf-fieldset' });
    box.createDiv({ cls: 'wf-fieldset-legend', text: node.value || 'Group' });
    renderTree(box.createDiv({ cls: 'wf-stack' }), node, ctx);
  }
});

widget(['well'], {
  group: 'Container', label: 'Well (inset)', size: [340, 120],
  snippet: 'well:\n  text: Sunken area for secondary content',
  render: function (el, node, ctx) {
    renderTree(el.createDiv({ cls: 'wf-well wf-stack' }), node, ctx);
  }
});

widget(['splitter', 'split'], {
  group: 'Container', label: 'Split panes', size: [420, 200],
  snippet: 'splitter:\n  list:\n    Website redesign\n    Mobile app\n  card: Detail\n    text: Selected record',
  render: function (el, node, ctx) {
    const box = el.createDiv({ cls: 'wf-split' });
    const kids = node.children.filter(function (c) { return c.type !== '_row'; });
    const left = box.createDiv({ cls: 'wf-split-pane wf-stack' });
    const handle = box.createDiv({ cls: 'wf-split-handle' });
    handle.createDiv({ cls: 'wf-split-grip' });
    const right = box.createDiv({ cls: 'wf-split-pane wf-stack' });
    renderTree(left, { children: kids.slice(0, 1) }, ctx);
    renderTree(right, { children: kids.slice(1) }, ctx);
  }
});

/* --- display --- */

widget(['pie', 'piechart', 'donut'], {
  group: 'Display', label: 'Pie chart', size: [300, 200],
  snippet: 'pie: Projects by status\n  In progress | 45\n  Done | 30\n  Planned | 25',
  render: function (el, node) {
    if (node.value) el.createDiv({ cls: 'wf-chart-title', text: node.value });
    const rows = numRows(node);
    const total = rows.reduce(function (a, r) { return a + r.v; }, 0) || 1;
    const wrap = el.createDiv({ cls: 'wf-pie-wrap' });
    const R = 42, C = 48;
    const svg = svgBox(wrap.createDiv({ cls: 'wf-pie' }), 96, 96);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svgChild(svg, 'circle', { cx: C, cy: C, r: R, stroke: 'currentColor', 'stroke-width': 1.6 });
    let ang = -Math.PI / 2;
    for (const r of rows) {
      const next = ang + (r.v / total) * Math.PI * 2;
      svgChild(svg, 'line', {
        x1: C, y1: C,
        x2: (C + R * Math.cos(ang)).toFixed(2), y2: (C + R * Math.sin(ang)).toFixed(2),
        stroke: 'currentColor', 'stroke-width': 1.6
      });
      ang = next;
    }
    const legend = wrap.createDiv({ cls: 'wf-legend' });
    for (const r of rows) {
      const li = legend.createDiv({ cls: 'wf-legend-row' });
      li.createDiv({ cls: 'wf-legend-key' });
      li.createSpan({ text: r.label + '  ' + Math.round((r.v / total) * 100) + '%' });
    }
    if (!rows.length) legend.createDiv({ cls: 'wf-chart-empty', text: 'label | value rows' });
  }
});

widget(['linechart', 'trend', 'sparkline'], {
  group: 'Display', label: 'Line chart', size: [340, 200],
  snippet: 'linechart: Active users\n  Jan | 30\n  Feb | 52\n  Mar | 41\n  Apr | 68\n  May | 60',
  render: function (el, node) {
    if (node.value) el.createDiv({ cls: 'wf-chart-title', text: node.value });
    const rows = numRows(node);
    const box = el.createDiv({ cls: 'wf-linechart' });
    const W = 100, H = 46;
    const svg = svgBox(box, W, H);
    svg.setAttribute('vector-effect', 'non-scaling-stroke');
    if (rows.length > 1) {
      const max = Math.max.apply(null, rows.map(function (r) { return r.v; })) || 1;
      const min = Math.min.apply(null, rows.map(function (r) { return r.v; }));
      const span = (max - min) || 1;
      const pts = rows.map(function (r, i) {
        const x = (i / (rows.length - 1)) * (W - 4) + 2;
        const y = H - 3 - ((r.v - min) / span) * (H - 8);
        return x.toFixed(2) + ',' + y.toFixed(2);
      });
      svgChild(svg, 'polyline', {
        points: pts.join(' '), stroke: 'currentColor', 'stroke-width': 1.6,
        'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke'
      });
      const lastPt = pts[pts.length - 1].split(',');
      svgChild(svg, 'circle', { cx: lastPt[0], cy: lastPt[1], r: 1.8, fill: 'currentColor' });
    }
    const axis = el.createDiv({ cls: 'wf-linechart-axis' });
    for (const r of rows) axis.createDiv({ text: r.label });
    if (rows.length < 2) box.createDiv({ cls: 'wf-chart-empty', text: 'needs 2+ label | value rows' });
  }
});

widget(['tagcloud'], {
  group: 'Display', label: 'Tag cloud', size: [300, 130],
  snippet: 'tagcloud: pricing | onboarding | churn | integrations | api | mobile',
  render: function (el, node) {
    const items = splitItems(node.value);
    const box = el.createDiv({ cls: 'wf-tagcloud' });
    items.forEach(function (it, i) {
      const t = box.createSpan({ cls: 'wf-cloud-tag', text: it.text });
      t.style.fontSize = (11 + ((i * 5) % 4) * 3.5) + 'px';
      if (it.active) t.addClass('wf-active');
    });
  }
});

widget(['video', 'player'], {
  group: 'Display', label: 'Video player', size: [340, 230],
  snippet: 'video: Product walkthrough',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-video' });
    const stage = box.createDiv({ cls: 'wf-video-stage' });
    stage.createDiv({ cls: 'wf-img-x' });
    iconEl(stage.createDiv({ cls: 'wf-video-play' }), 'play', 26);
    const bar = box.createDiv({ cls: 'wf-video-bar' });
    iconEl(bar, 'play', 13);
    const track = bar.createDiv({ cls: 'wf-video-track' });
    track.createDiv({ cls: 'wf-video-fill' }).style.width = '38%';
    bar.createSpan({ cls: 'wf-video-time', text: '1:12 / 3:20' });
    iconEl(bar, 'volume', 13);
    iconEl(bar, 'maximize', 13);
    if (node.value) box.createDiv({ cls: 'wf-video-cap', text: node.value });
  }
});

widget(['map'], {
  group: 'Display', label: 'Map', size: [320, 220],
  snippet: 'map: Chennai office',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-map' });
    const svg = svgBox(box, 100, 70, 'wf-map-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    const roads = [[0, 22, 100, 30], [0, 52, 100, 46], [28, 0, 34, 70], [70, 0, 64, 70]];
    for (const r of roads) svgChild(svg, 'line', { x1: r[0], y1: r[1], x2: r[2], y2: r[3], stroke: 'currentColor', 'stroke-width': 1.1 });
    svgChild(svg, 'rect', { x: 38, y: 33, width: 22, height: 14, stroke: 'currentColor', 'stroke-width': 0.9 });
    const pin = box.createDiv({ cls: 'wf-map-pin' });
    iconEl(pin, 'map-pin', 24);
    if (node.value) box.createDiv({ cls: 'wf-map-cap', text: node.value });
  }
});

/* ---------- primitives ---------- *
 * The workhorses. The Essentials tier opens with Rectangle and Text because
 * most of wireframing is "I need a box here" and "I need to say something
 * here", and every specific widget is a shortcut for a box you would otherwise
 * draw yourself. These take text, so a rectangle with a word in it - the most
 * useful thing on any board - is one element rather than two stacked.
 */

function drawPrimitive(el, node, kind) {
  const info = splitMods(node.value);
  const box = el.createDiv({ cls: 'wf-prim wf-prim-' + kind });
  applyMods(box, info.mods);
  const text = String(info.text || '').trim();
  if (text) box.createDiv({ cls: 'wf-prim-text', text: text });
}

widget(['rect', 'rectangle', 'box', 'block'], {
  group: 'Display', label: 'Rectangle', size: [240, 140],
  snippet: 'rect: Anything goes in here',
  render: function (el, node) { drawPrimitive(el, node, 'rect'); }
});

widget(['circle', 'ellipse', 'oval'], {
  group: 'Display', label: 'Circle / ellipse', size: [160, 160],
  snippet: 'circle: Or here',
  render: function (el, node) { drawPrimitive(el, node, 'circle'); }
});

widget(['triangle'], {
  group: 'Display', label: 'Triangle', size: [160, 140],
  snippet: 'triangle:',
  render: function (el, node) { drawPrimitive(el, node, 'triangle'); }
});

/* Kept for boards written before rect/circle/triangle existed: `shape: circle`
 * still draws a circle. New boards should reach for the specific ones. */
widget(['shape'], {
  group: 'Display', label: 'Shape (by name)', size: [140, 140],
  snippet: 'shape: rect',
  render: function (el, node) {
    const info = splitMods(node.value);
    const kind = (info.text || 'rect').trim().toLowerCase();
    const use = ['rect', 'circle', 'triangle'].indexOf(kind) >= 0 ? kind : 'rect';
    const box = el.createDiv({ cls: 'wf-prim wf-prim-' + use });
    applyMods(box, info.mods);
  }
});

widget(['iconrow', 'icons'], {
  group: 'Display', label: 'Row of icons', size: [320, 80],
  snippet: 'iconrow: briefcase | users | calendar | bar-chart | settings',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-iconrow' });
    for (const it of splitItems(node.value)) {
      const cell = box.createDiv({ cls: 'wf-iconrow-cell' + (it.active ? ' wf-active' : '') });
      iconEl(cell, it.text, 22);
      cell.createDiv({ cls: 'wf-iconrow-label', text: it.text });
    }
  }
});

widget(['sitemap'], {
  group: 'Display', label: 'Sitemap', size: [400, 180],
  snippet: 'sitemap: Home | Projects | People | Reports',
  render: function (el, node) {
    const items = splitItems(node.value);
    const box = el.createDiv({ cls: 'wf-sitemap' });
    box.createDiv({ cls: 'wf-sitemap-root', text: items.length ? items[0].text : 'Home' });
    box.createDiv({ cls: 'wf-sitemap-stem' });
    const row = box.createDiv({ cls: 'wf-sitemap-row' });
    for (const it of items.slice(1)) {
      const cell = row.createDiv({ cls: 'wf-sitemap-cell' });
      cell.createDiv({ cls: 'wf-sitemap-tick' });
      cell.createDiv({ cls: 'wf-sitemap-box' + (it.active ? ' wf-active' : ''), text: it.text });
    }
  }
});

/* --- more annotations --- */

widget(['tooltip'], {
  group: 'Annotations', label: 'Tooltip', size: [220, 60],
  snippet: 'tooltip: Only owners can change this',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-tooltip' });
    box.createDiv({ cls: 'wf-tooltip-body', text: node.value || 'Tooltip text' });
    box.createDiv({ cls: 'wf-tooltip-tail' });
  }
});

widget(['bubble', 'speech'], {
  group: 'Annotations', label: 'Comment bubble', size: [260, 110],
  snippet: 'bubble: Reviewer | Can we drop the second CTA?',
  render: function (el, node) {
    const parts = String(node.value || '').split('|');
    const who = parts.length > 1 ? parts[0].trim() : '';
    const what = (parts.length > 1 ? parts.slice(1).join('|') : parts[0] || '').trim();
    const box = el.createDiv({ cls: 'wf-bubble' });
    if (who) box.createDiv({ cls: 'wf-bubble-who', text: who });
    box.createDiv({ text: what || 'Comment' });
    box.createDiv({ cls: 'wf-bubble-tail' });
  }
});

widget(['brace'], {
  group: 'Annotations', label: 'Curly brace (across)', size: [300, 60],
  snippet: 'brace: shared header',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-brace' });
    const svg = svgBox(box, 100, 12, 'wf-brace-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    svgChild(svg, 'path', {
      d: 'M1 1 C1 7 3 7 8 7 L44 7 C48 7 48 11 50 11 C52 11 52 7 56 7 L92 7 C97 7 99 7 99 1',
      stroke: 'currentColor', 'stroke-width': 1.4, 'vector-effect': 'non-scaling-stroke'
    });
    if (node.value) box.createDiv({ cls: 'wf-brace-label', text: node.value });
  }
});

widget(['vbrace'], {
  group: 'Annotations', label: 'Curly brace (down)', size: [140, 200],
  snippet: 'vbrace: repeats per row',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-vbrace' });
    const svg = svgBox(box.createDiv({ cls: 'wf-vbrace-rail' }), 12, 100, 'wf-brace-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    svgChild(svg, 'path', {
      d: 'M1 1 C7 1 7 3 7 8 L7 44 C7 48 11 48 11 50 C11 52 7 52 7 56 L7 92 C7 97 7 99 1 99',
      stroke: 'currentColor', 'stroke-width': 1.4, 'vector-effect': 'non-scaling-stroke'
    });
    if (node.value) box.createDiv({ cls: 'wf-brace-label', text: node.value });
  }
});

widget(['arrow'], {
  group: 'Annotations', label: 'Annotation arrow', size: [240, 60],
  snippet: 'arrow: goes to the detail screen',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-arrow' });
    const svg = svgBox(box.createDiv({ cls: 'wf-arrow-rail' }), 100, 10, 'wf-arrow-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    svgChild(svg, 'line', { x1: 1, y1: 5, x2: 97, y2: 5, stroke: 'currentColor', 'stroke-width': 1.5, 'vector-effect': 'non-scaling-stroke' });
    svgChild(svg, 'polyline', { points: '90,1 98,5 90,9', stroke: 'currentColor', 'stroke-width': 1.5, fill: 'none', 'vector-effect': 'non-scaling-stroke' });
    if (node.value) box.createDiv({ cls: 'wf-arrow-label', text: node.value });
  }
});

widget(['measure', 'redline', 'dim'], {
  group: 'Annotations', label: 'Redline measurement', size: [240, 50],
  snippet: 'measure: 24px',
  render: function (el, node) {
    const box = el.createDiv({ cls: 'wf-measure' });
    box.createDiv({ cls: 'wf-measure-cap' });
    const rail = box.createDiv({ cls: 'wf-measure-rail' });
    rail.createDiv({ cls: 'wf-measure-line' });
    rail.createDiv({ cls: 'wf-measure-val', text: node.value || '0px' });
    box.createDiv({ cls: 'wf-measure-cap' });
  }
});

/* ------------------------------------------------------------------ *
 * Tree renderer
 * ------------------------------------------------------------------ */

function renderTree(container, parentNode, ctx) {
  for (const child of parentNode.children) {
    if (child.type === '_row') continue; // data rows belong to their parent widget
    const def = WIDGETS[child.type];
    if (!def) continue;
    const wrap = container.createDiv({ cls: 'wf-w wf-w-' + def.name });
    const info = splitMods(child.value);
    applyStyle(wrap, info.style);
    if (info.mods.indexOf('grow') >= 0 || info.mods.indexOf('fill') >= 0) wrap.style.flex = '1 1 auto';
    if (info.mods.indexOf('right') >= 0) wrap.style.marginLeft = 'auto';
    if (info.mods.indexOf('center') >= 0) { wrap.style.marginLeft = 'auto'; wrap.style.marginRight = 'auto'; }
    try {
      def.render(wrap, child, ctx);
    } catch (e) {
      wrap.empty();
      wrap.createDiv({ cls: 'wf-error', text: '⚠ ' + child.type + ' — ' + (e && e.message ? e.message : 'render failed') });
    }
  }
}

function renderWireframe(el, source, settings) {
  const tree = parseWf(source);
  const root = el.createDiv({ cls: 'wf-root wf-stack wf-skin-' + (settings && settings.skin ? settings.skin : 'sketch') });
  if (!tree.children.length) {
    root.createDiv({ cls: 'wf-error', text: 'Empty wf block. Try:  btn: Save (primary)' });
    return root;
  }
  renderTree(root, tree, { settings: settings });
  return root;
}

/* ------------------------------------------------------------------ *
 * Canvas integration
 *
 * The Canvas API is not public, so every call is feature-detected and
 * wrapped. If Obsidian changes it, the DSL and markdown rendering keep
 * working; only the insert helpers degrade.
 * ------------------------------------------------------------------ */

function getCanvas(app) {
  const leaf = app.workspace.getMostRecentLeaf();
  const view = leaf && leaf.view;
  if (!view || view.getViewType() !== 'canvas') return null;
  return view.canvas || null;
}

function canvasCenter(canvas) {
  try {
    if (typeof canvas.posCenter === 'function') return canvas.posCenter();
  } catch (e) { /* fall through */ }
  try {
    const rect = canvas.canvasRect || { width: 900, height: 700 };
    return {
      x: (-canvas.x || 0) + rect.width / (2 * (canvas.zoom || 1)),
      y: (-canvas.y || 0) + rect.height / (2 * (canvas.zoom || 1))
    };
  } catch (e) { return { x: 0, y: 0 }; }
}

function fence(body) {
  return '```wf\n' + body + '\n```';
}

function addTextNode(canvas, text, size, pos) {
  const at = pos || canvasCenter(canvas);
  const opts = {
    pos: { x: Math.round(at.x - size[0] / 2), y: Math.round(at.y - size[1] / 2) },
    size: { width: size[0], height: size[1] },
    text: text,
    save: true,
    focus: false
  };
  if (typeof canvas.createTextNode !== 'function') throw new Error('This Obsidian version does not expose canvas.createTextNode');
  const n = canvas.createTextNode(opts);
  try { canvas.requestSave(); } catch (e) { /* noop */ }
  return n;
}

function addGroupNode(canvas, label, size, pos) {
  const at = pos || canvasCenter(canvas);
  const opts = {
    pos: { x: Math.round(at.x - size[0] / 2), y: Math.round(at.y - size[1] / 2) },
    size: { width: size[0], height: size[1] },
    label: label,
    save: true,
    focus: false
  };
  if (typeof canvas.createGroupNode !== 'function') throw new Error('This Obsidian version does not expose canvas.createGroupNode');
  const n = canvas.createGroupNode(opts);
  try { canvas.requestSave(); } catch (e) { /* noop */ }
  return n;
}

function addFileNode(canvas, file, size, pos) {
  const at = pos || canvasCenter(canvas);
  const opts = {
    pos: { x: Math.round(at.x - size[0] / 2), y: Math.round(at.y - size[1] / 2) },
    size: { width: size[0], height: size[1] },
    file: file,
    save: true,
    focus: false
  };
  if (typeof canvas.createFileNode !== 'function') throw new Error('This Obsidian version does not expose canvas.createFileNode');
  const n = canvas.createFileNode(opts);
  try { canvas.requestSave(); } catch (e) { /* noop */ }
  return n;
}

function selectedNodes(canvas) {
  try {
    const sel = canvas.selection;
    if (!sel) return [];
    return Array.from(sel);
  } catch (e) { return []; }
}

function nodeText(n) {
  try {
    if (typeof n.text === 'string') return n.text;
    if (n.unknownData && typeof n.unknownData.text === 'string') return n.unknownData.text;
    if (n.getData) { const d = n.getData(); if (d && typeof d.text === 'string') return d.text; }
  } catch (e) { /* noop */ }
  return null;
}

/* ------------------------------------------------------------------ *
 * Appending into an existing wireframe
 *
 * The palette only earns its place if clicking a widget adds it to the
 * screen you are building, not to a brand-new node. So when a wireframe
 * node is selected we splice the snippet into its last wf block, guessing
 * the indent the way a person would: nest inside the container the block
 * ends with, otherwise sit beside the last line.
 * ------------------------------------------------------------------ */

const CONTAINER_TYPES = ['window', 'browser', 'phone', 'device', 'card', 'panel', 'box',
  'screen', 'modal', 'dialog', 'row', 'hbox', 'col', 'vbox', 'stack', 'scroll',
  'fieldset', 'group', 'well', 'splitter', 'split'];

function isContainerLine(line) {
  const m = String(line).match(/^\s*([a-zA-Z][\w-]*)\s*:/);
  return !!(m && CONTAINER_TYPES.indexOf(m[1].toLowerCase()) >= 0);
}

// Re-indent a multi-line snippet to sit at `indent`, preserving its own shape.
function reindentSnippet(snippet, indent) {
  const pad = new Array(indent + 1).join(' ');
  return String(snippet).split('\n').map(function (l) {
    return l.trim() ? pad + l : l;
  }).join('\n');
}

function chooseIndent(bodyLines) {
  const real = bodyLines.filter(function (l) { return l.trim().length > 0; });
  if (!real.length) return 0;
  const last = real[real.length - 1];
  const li = last.match(/^ */)[0].length;
  return isContainerLine(last) ? li + 2 : li;
}

// Returns the new node text, or null when there is no wf block to append to.
function appendToWfBlock(text, snippet) {
  const src = String(text == null ? '' : text);
  const re = /```wf[ \t]*\n([\s\S]*?)```/g;
  let m, last = null;
  while ((m = re.exec(src))) last = m;
  if (!last) return null;

  const body = last[1];
  const bodyLines = body.replace(/\n$/, '').split('\n');
  const indent = chooseIndent(bodyLines);
  const addition = reindentSnippet(snippet, indent);

  // rebuild: everything up to the end of the body, then the addition, then the fence
  const bodyStart = last.index + last[0].indexOf('\n') + 1;
  const bodyEnd = bodyStart + body.length;
  const before = src.slice(0, bodyEnd).replace(/\n*$/, '');
  const after = src.slice(bodyEnd);
  return before + '\n' + addition + '\n' + after;
}

function nodeHasWf(node) {
  const t = nodeText(node);
  return !!(t && t.indexOf('```wf') >= 0);
}

function setNodeText(node, text) {
  if (typeof node.setText === 'function') { node.setText(text); return true; }
  if (typeof node.setData === 'function') {
    const d = (typeof node.getData === 'function' ? node.getData() : {}) || {};
    d.text = text; node.setData(d); return true;
  }
  return false;
}

/* Palette thumbnail: render the widget at its natural size, then shrink it.
 *
 * `zoom` rather than `transform: scale()` on purpose — zoom participates in
 * layout, so the card sizes itself to the scaled content and short widgets
 * don't leave a pocket of dead space under them.
 *
 * fit:true (whole screens) constrains height too, so a full screen thumbnail
 * is never clipped mid-word. fit:false (single widgets) constrains width only,
 * because a widget's nominal node height is a canvas hint, not its content
 * height — honouring it would shrink a nav bar to a sliver. Those get a cap
 * and a fade instead. */
function renderThumb(host, snippet, settings, natural, avail, maxH, fit) {
  let zoom = Math.min(1, (avail - 2) / natural[0]);
  if (fit) zoom = Math.min(zoom, maxH / natural[1]);

  const frame = host.createDiv({ cls: 'wf-thumb' });
  frame.style.maxHeight = maxH + 'px';
  const stage = frame.createDiv({ cls: 'wf-thumb-stage' });
  stage.style.width = natural[0] + 'px';
  stage.style.zoom = String(Number(zoom.toFixed(4)));
  renderWireframe(stage, snippet, settings);
  return frame;
}

/* ------------------------------------------------------------------ *
 * Element catalog
 *
 * A generated note listing every widget and icon, rendered live. The
 * palette panel is ~300px wide, which is fine for picking something you
 * already know and useless for browsing; a note gets the full editor
 * width. Generated from the registry so it can never drift.
 * ------------------------------------------------------------------ */

const CATALOG_INTRO = [
  'Everything the plugin can draw, rendered live. Generated from the plugin itself —',
  'run **Rebuild element catalog** after an update to refresh it.',
  '',
  'The grey line under each heading is the text that produces it. Copy it into any',
  'Canvas node, or just drag the same widget out of the palette.',
  ''
].join('\n');

const GROUP_ORDER = ['Container', 'Navigation', 'Input', 'Action', 'Display', 'Annotations'];

/* Job B5: "the handful you use constantly is available without any search at
 * all." So the first group is Essentials, and the same element appears in
 * every group where it is relevant rather than in one canonical place. These
 * twelve are cross-listed at the top of the palette; each still belongs to its
 * real group, so the catalog documents every widget exactly once. */
const ESSENTIALS = ['window', 'phone', 'card', 'rect', 'circle', 'h1', 'text',
  'btn', 'input', 'select', 'table', 'list', 'note', 'img'];

function uniqueDefs() {
  const seen = [];
  const defs = [];
  for (const key in WIDGETS) {
    const d = WIDGETS[key];
    if (seen.indexOf(d) >= 0) continue;
    seen.push(d);
    defs.push(d);
  }
  return defs;
}

/* Primary groups, each widget in exactly one. The catalog note and the README's
 * counted claims both read this, so it has to stay a partition. */
function catalogGroups() {
  const defs = uniqueDefs();
  return GROUP_ORDER.map(function (g) {
    return {
      name: g,
      defs: defs.filter(function (d) { return d.group === g; })
                .sort(function (a, b) { return a.name.localeCompare(b.name); })
    };
  }).filter(function (g) { return g.defs.length; });
}

/* What the palette shows: Essentials first, then the primary groups. A widget
 * appears more than once here on purpose - that is the whole point of the tier.
 * `keep` is the search predicate, applied before grouping so an empty group
 * never gets a heading. */
function paletteGroups(keep) {
  const pass = typeof keep === 'function' ? keep : function () { return true; };
  const defs = uniqueDefs().filter(pass);
  const byLabel = function (a, b) { return a.label.localeCompare(b.label); };
  const essentials = ESSENTIALS.map(function (n) { return WIDGETS[n]; })
    .filter(function (d) { return d && defs.indexOf(d) >= 0; });
  const out = [];
  if (essentials.length) out.push({ name: 'Essentials', defs: essentials.slice().sort(byLabel) });
  for (const g of GROUP_ORDER) {
    const inGroup = defs.filter(function (d) { return d.group === g; }).sort(byLabel);
    if (inGroup.length) out.push({ name: g, defs: inGroup });
  }
  return out;
}

/* A board's sticky notes and callouts are already a list of things nobody has
 * decided yet, so the note starts as that list rather than as a blank page.
 * Everything else is headings the writer can delete. */
const ANNOTATION_TYPES = ['note', 'callout', 'bubble', 'tooltip', 'brace', 'vbrace', 'measure'];

function boardNotesTemplate(basename, doc) {
  const lines = [];
  lines.push('# ' + basename);
  lines.push('');
  lines.push('Notes for [[' + basename + ']].');
  lines.push('');

  const screens = (doc.elements || []).filter(function (e) {
    return CONTAINER_TYPES.indexOf(e.type) >= 0 && String(e.value || '').trim();
  });
  if (screens.length) {
    lines.push('## Screens');
    lines.push('');
    for (const e of screens) {
      lines.push('- **' + String(e.value).split('|')[0].trim() + '**');
    }
    lines.push('');
  }

  const flow = (doc.links || []).filter(function (l) { return String(l.label || '').trim(); });
  if (flow.length) {
    lines.push('## Flow');
    lines.push('');
    const byId = {};
    for (const e of (doc.elements || [])) byId[e.id] = e;
    for (const l of flow) {
      const a = byId[l.from], b = byId[l.to];
      const nameOf = function (e) {
        if (!e) return 'something';
        const v = String(e.value || '').split('|')[0].trim();
        const def = WIDGETS[e.type];
        return v || (def ? def.label.toLowerCase() : e.type);
      };
      lines.push('- ' + nameOf(a) + ' \u2192 ' + nameOf(b) + ' (' + String(l.label).trim() + ')');
    }
    lines.push('');
  }

  const open = (doc.elements || []).filter(function (e) {
    return ANNOTATION_TYPES.indexOf(e.type) >= 0 &&
           (String(e.value || '').trim() || String(e.rows || '').trim());
  });
  lines.push('## Open questions');
  lines.push('');
  if (open.length) {
    for (const e of open) {
      const text = String(e.rows || '').trim() || String(e.value || '').trim();
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t) lines.push('- [ ] ' + t.replace(/^\d+\s*\|\s*/, ''));
      }
    }
  } else {
    lines.push('- [ ] ');
  }
  lines.push('');
  lines.push('## Decided');
  lines.push('');
  lines.push('## Rejected, and why');
  lines.push('');
  return lines.join('\n');
}

function buildCatalogMarkdown() {
  const groups = catalogGroups();
  const total = groups.reduce(function (a, g) { return a + g.defs.length; }, 0);
  const icons = iconNames();

  const out = [];
  out.push('---');
  out.push('tags: [wireframe-catalog]');
  out.push('---');
  out.push('# Wireframe elements');
  out.push('');
  out.push(total + ' widgets · ' + icons.length + ' icons · ' +
           Object.keys(WIDGETS).length + ' names including aliases');
  out.push('');
  out.push(CATALOG_INTRO);

  // contents
  out.push('## Contents');
  out.push('');
  for (const g of groups) out.push('- [[#' + g.name + ']] — ' + g.defs.length);
  out.push('- [[#Icons]] — ' + icons.length);
  out.push('');

  for (const g of groups) {
    out.push('---');
    out.push('');
    out.push('## ' + g.name);
    out.push('');
    for (const d of g.defs) {
      const aka = d.aliases && d.aliases.length ? '  ·  also `' + d.aliases.join('`, `') + '`' : '';
      out.push('### `' + d.name + '` — ' + d.label + aka);
      out.push('');
      // the source, on one line, so it can be read and copied
      out.push('`' + d.snippet.replace(/\n/g, ' ⏎ ') + '`');
      out.push('');
      out.push('```wf');
      out.push(d.snippet);
      out.push('```');
      out.push('');
    }
  }

  // icons, as iconrow blocks so they render as real icons with their names
  out.push('---');
  out.push('');
  out.push('## Icons');
  out.push('');
  out.push('`icon: <name>` for one, `iconrow: a | b | c` for a labelled row. Names also work');
  out.push('in `toolbar:` and after a colon in `sidebar:` items, e.g. `Projects:folder`.');
  out.push('');
  const PER_ROW = 8;
  for (let i = 0; i < icons.length; i += PER_ROW) {
    out.push('```wf');
    out.push('iconrow: ' + icons.slice(i, i + PER_ROW).join(' | '));
    out.push('```');
    out.push('');
  }

  // synonyms
  const byT = ICON_ALIASES_BY_TARGET;
  const keys = Object.keys(byT).sort();
  if (keys.length) {
    out.push('### Synonyms');
    out.push('');
    out.push('These resolve to the icon on the right, so you do not have to remember the exact name.');
    out.push('');
    out.push('| type this | you get |');
    out.push('| --- | --- |');
    for (const k of keys) out.push('| ' + byT[k].map(function (a) { return '`' + a + '`'; }).join(', ') + ' | `' + k + '` |');
    out.push('');
  }

  out.push('Inside Obsidian any name that is not listed here falls through to the app\'s');
  out.push('bundled Lucide icons, which adds about a thousand more. A name that matches');
  out.push('nothing renders as a dashed box, so a typo is visible rather than silently blank.');
  out.push('');
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * Drag and drop
 *
 * The payload lives in a module variable rather than only in dataTransfer,
 * because custom MIME types are not readable during `dragover` — and the
 * drop target needs to know what is coming to draw a hint. dataTransfer
 * still carries text/plain so a drop that misses our handler degrades into
 * Canvas creating a plain card with the wf block in it.
 * ------------------------------------------------------------------ */

let DRAG_PAYLOAD = null;

function beginDrag(evt, payload, ghostEl) {
  DRAG_PAYLOAD = payload;
  try {
    evt.dataTransfer.effectAllowed = 'copy';
    evt.dataTransfer.setData('text/plain', fence(payload.snippet));
    if (ghostEl) evt.dataTransfer.setDragImage(ghostEl, 18, 14);
  } catch (e) { /* older webviews */ }
}

function endDrag() {
  DRAG_PAYLOAD = null;
  clearDropHints(document.body);
}

function makeDraggable(el, payload, ghostEl) {
  el.setAttribute('draggable', 'true');
  el.addEventListener('dragstart', function (evt) { beginDrag(evt, payload, ghostEl || el); });
  el.addEventListener('dragend', endDrag);
}

// Scoped to a root rather than the whole document: sweeping `document` is a
// review flag, and it can touch DOM belonging to other plugins.
function clearDropHints(root) {
  const scope = root || document.body;
  if (!scope) return;
  for (const cls of ['wf-drop-armed', 'wf-drop-target']) {
    const found = scope.querySelectorAll('.' + cls);
    for (let i = 0; i < found.length; i++) found[i].classList.remove(cls);
  }
}

function canvasViewFor(app, el) {
  const leaves = app.workspace.getLeavesOfType('canvas');
  for (const leaf of leaves) {
    try {
      if (leaf.view && leaf.view.containerEl && leaf.view.containerEl.contains(el)) return leaf.view;
    } catch (e) { /* keep looking */ }
  }
  return null;
}

function canvasPosFromEvent(canvas, evt) {
  try {
    if (typeof canvas.posFromEvt === 'function') return canvas.posFromEvt(evt);
  } catch (e) { /* fall through */ }
  return canvasCenter(canvas);
}

/* The smallest wireframe node containing `pos` — the one a drop should join.
 * Groups are skipped: dropping inside a screen frame should create a node in
 * it, not try to edit the frame. */
function wfNodeAt(canvas, pos) {
  let best = null;
  try {
    canvas.nodes.forEach(function (n) {
      if (!nodeHasWf(n)) return;
      if (pos.x < n.x || pos.x > n.x + n.width) return;
      if (pos.y < n.y || pos.y > n.y + n.height) return;
      const area = (n.width || 1) * (n.height || 1);
      if (!best || area < best.area) best = { node: n, area: area };
    });
  } catch (e) { return null; }
  return best ? best.node : null;
}

/* ------------------------------------------------------------------ *
 * Quick Add — keyboard-first widget insertion
 * ------------------------------------------------------------------ */

class QuickAddModal extends FuzzySuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder('Widget name — e.g. btn, table, nav, phone');
    this.setInstructions([
      { command: '↵', purpose: 'insert as a new Canvas node' },
      { command: 'esc', purpose: 'cancel' }
    ]);
  }
  getItems() {
    const seen = [];
    const out = [];
    for (const key in WIDGETS) {
      const def = WIDGETS[key];
      if (seen.indexOf(def) >= 0) continue;
      seen.push(def);
      out.push(def);
    }
    return out.sort(function (a, b) {
      if (a.group === b.group) return a.label.localeCompare(b.label);
      return a.group.localeCompare(b.group);
    });
  }
  getItemText(def) {
    return def.name + ' ' + def.label + ' ' + def.group + ' ' + (def.aliases || []).join(' ');
  }
  renderSuggestion(match, el) {
    const def = match.item;
    el.addClass('wf-qa-row');
    el.createDiv({ cls: 'wf-qa-name', text: def.name });
    el.createDiv({ cls: 'wf-qa-label', text: def.label });
    el.createDiv({ cls: 'wf-qa-group', text: def.group });
  }
  onChooseItem(def) {
    this.plugin.insertWidget(def);
  }
}

/* ------------------------------------------------------------------ *
 * Palette side panel
 * ------------------------------------------------------------------ */

class PaletteView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.filter = '';
  }
  getViewType() { return VIEW_PALETTE; }
  getDisplayText() { return 'Wireframe palette'; }
  getIcon() { return 'drafting-compass'; }

  async onOpen() {
    this.draw();
    // keyboard shortcuts are bound to the stage, so give it focus on open —
    // otherwise pressing C or Delete before the first click did nothing
    window.setTimeout(() => { if (this.stageEl) this.stageEl.focus(); }, 0);
    // thumbnails are scaled to the panel width, so redraw when it changes
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        const w = this.contentEl.clientWidth;
        if (this.lastWidth && Math.abs(w - this.lastWidth) < 24) return;
        this.lastWidth = w;
        this.drawList();
      });
      this.ro.observe(this.contentEl);
    }
  }

  async onClose() { if (this.ro) this.ro.disconnect(); }

  avail() {
    const w = this.contentEl.clientWidth || 300;
    return Math.max(160, w - 34);
  }

  draw() {
    const c = this.contentEl;
    c.empty();
    c.addClass('wf-palette');

    const search = c.createEl('input', {
      cls: 'wf-palette-search',
      attr: { type: 'text', placeholder: 'Filter — try button, table, phone' }
    });
    search.value = this.filter;
    search.addEventListener('input', () => { this.filter = search.value; this.drawList(); });

    const catBtn = c.createDiv({ cls: 'wf-palette-catalog' });
    iconEl(catBtn, 'grid', 15);
    catBtn.createSpan({ text: 'Browse all elements in a note' });
    catBtn.setAttribute('title', 'Generates "Element catalog", a note showing every widget and icon at full width');
    catBtn.addEventListener('click', () => this.plugin.writeCatalog());

    const hint = c.createDiv({ cls: 'wf-palette-hint' });
    hint.createDiv({ text: 'Drag anything onto the canvas. Drop it on a screen to add it to that screen, or on empty canvas to start a new one.' });
    hint.createDiv({ cls: 'wf-palette-hint-2', text: 'Clicking works too — it adds to the selected screen.' });

    const frames = c.createDiv();
    frames.createDiv({ cls: 'wf-palette-grouphead', text: 'New screen frame' });
    const fbar = frames.createDiv({ cls: 'wf-palette-fbar' });
    for (const p of SCREEN_PRESETS) {
      const b = fbar.createDiv({ cls: 'wf-palette-chip', text: p.label });
      b.setAttribute('title', p.width + ' × ' + p.height + ' — an empty Canvas group to arrange wireframes inside\n\nDrag onto the canvas, or click.');
      b.addEventListener('click', () => this.plugin.insertScreenFrame(p.id));
      makeDraggable(b, { frame: p.id, size: [p.width, p.height], label: p.label, snippet: '' });
    }

    this.listEl = c.createDiv({ cls: 'wf-palette-list' });
    this.lastWidth = this.contentEl.clientWidth;
    this.drawList();
  }

  card(host, opts) {
    const card = host.createDiv({ cls: 'wf-card-btn' });
    const head = card.createDiv({ cls: 'wf-card-btn-head' });
    head.createDiv({ cls: 'wf-card-btn-name', text: opts.title });
    if (opts.badge) head.createDiv({ cls: 'wf-card-btn-badge', text: opts.badge });
    const frame = renderThumb(card, opts.snippet, this.plugin.settings, opts.size,
                              this.avail(), opts.maxH || 150, !!opts.fit);
    if (!opts.fit) card.addClass('wf-may-clip');
    void frame;
    card.setAttribute('title', (opts.tip || opts.snippet) + '\n\nDrag onto the canvas, or click.');
    card.addEventListener('click', opts.onClick);
    makeDraggable(card, { snippet: opts.snippet, size: opts.size, label: opts.title }, frame);
    return card;
  }

  drawList() {
    const el = this.listEl;
    if (!el) return;
    el.empty();
    const q = this.filter.trim().toLowerCase();

    // ---- whole screens to start from ----
    const starterKeys = Object.keys(STARTERS).filter(function (k) {
      return !q || k.toLowerCase().indexOf(q) >= 0;
    });
    if (starterKeys.length) {
      el.createDiv({ cls: 'wf-palette-grouphead', text: 'Whole screens' });
      const wrap = el.createDiv({ cls: 'wf-palette-cards' });
      for (const k of starterKeys) {
        const s = STARTERS[k];
        this.card(wrap, {
          title: k, snippet: s.body, size: s.size, maxH: 230, fit: true,
          tip: 'Insert this whole screen as a new Canvas node',
          onClick: () => this.plugin.insertStarter(k)
        });
      }
    }

    // ---- individual widgets ----
    const groups = paletteGroups(function (def) {
      if (!q) return true;
      const hay = (def.name + ' ' + def.label + ' ' + def.group + ' ' +
        (def.aliases || []).join(' ')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    let any = starterKeys.length > 0;
    for (const group of groups) {
      const defs = group.defs;
      if (!defs.length) continue;
      any = true;
      el.createDiv({ cls: 'wf-palette-grouphead', text: group.name + '  ·  ' + defs.length });
      const wrap = el.createDiv({ cls: 'wf-palette-cards' });
      for (const def of defs) {
        this.card(wrap, {
          title: def.label, badge: def.name, snippet: def.snippet, size: def.size,
          tip: def.snippet + (def.aliases.length ? '\n\nalso: ' + def.aliases.join(', ') : ''),
          onClick: () => this.plugin.insertWidget(def)
        });
      }
    }
    // ---- icon browser ----
    const names = iconNames().filter(function (n) { return !q || n.indexOf(q) >= 0; });
    if (names.length) {
      any = true;
      el.createDiv({ cls: 'wf-palette-grouphead', text: 'Icons  ·  ' + names.length });
      const grid = el.createDiv({ cls: 'wf-icongrid' });
      for (const n of names) {
        const cell = grid.createDiv({ cls: 'wf-icongrid-cell' });
        iconEl(cell, n, 19);
        cell.createDiv({ cls: 'wf-icongrid-name', text: n });
        cell.setAttribute('title', 'icon: ' + n + '\n\nDrag onto the canvas, or click.');
        cell.addEventListener('click', () => this.plugin.insertIcon(n));
        const idef = WIDGETS['icon'];
        makeDraggable(cell, { snippet: 'icon: ' + n, size: idef ? idef.size : [80, 80], label: 'icon ' + n });
      }
      el.createDiv({
        cls: 'wf-palette-foot',
        text: 'Any Lucide icon name also works, e.g.  icon: sparkles'
      });
    }

    if (!any) el.createDiv({ cls: 'wf-palette-none', text: 'Nothing matches "' + this.filter + '"' });
  }
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

class WireframeSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const c = this.containerEl;
    c.empty();

    new Setting(c)
      .setName('Skin')
      .setDesc('Sketch is the hand-drawn look. Clean is flat grey boxes. Wire is outline-only, best for print.')
      .addDropdown((d) => d
        .addOption('sketch', 'Sketch (hand-drawn)')
        .addOption('clean', 'Clean (flat grey)')
        .addOption('wire', 'Wire (outline only)')
        .setValue(this.plugin.settings.skin)
        .onChange(async (v) => { this.plugin.settings.skin = v; await this.plugin.saveSettings(); this.plugin.refreshAll(); }));

    new Setting(c)
      .setName('Default screen frame')
      .setDesc('Used by the "New screen frame" command.')
      .addDropdown((d) => {
        for (const p of SCREEN_PRESETS) d.addOption(p.id, p.label + ' — ' + p.width + '×' + p.height);
        d.setValue(this.plugin.settings.defaultScreen);
        d.onChange(async (v) => { this.plugin.settings.defaultScreen = v; await this.plugin.saveSettings(); });
      });

    new Setting(c)
      .setName('Masters folder')
      .setDesc('Where reusable components go. A master is a note with a wf block; embed it as a Canvas file node and every instance updates when you edit the note.')
      .addText((t) => t
        .setPlaceholder('Wireframes/Masters')
        .setValue(this.plugin.settings.mastersFolder)
        .onChange(async (v) => { this.plugin.settings.mastersFolder = v.trim() || DEFAULT_SETTINGS.mastersFolder; await this.plugin.saveSettings(); }));

    new Setting(c)
      .setName('Node padding')
      .setDesc('Inner padding of a wireframe inside its Canvas node, in pixels.')
      .addSlider((s) => s
        .setLimits(0, 48, 2)
        .setValue(this.plugin.settings.nodePadding)
        .setDynamicTooltip()
        .onChange(async (v) => { this.plugin.settings.nodePadding = v; await this.plugin.saveSettings(); this.plugin.applyCssVars(); }));
  }
}

/* ------------------------------------------------------------------ *
 * Master picker
 * ------------------------------------------------------------------ */

/* Transform-to is reachable from the element itself, and its control names the
 * element's CURRENT type. Same-group widgets are listed first because those
 * are the plausible swaps: with an empty query the list you see
 * is the one worth scanning. */
class TransformModal extends FuzzySuggestModal {
  constructor(app, view, elm) {
    super(app);
    this.view = view;
    this.elm = elm;
    const def = WIDGETS[elm.type];
    this.setPlaceholder('Change this ' + (def ? def.label.toLowerCase() : elm.type) + ' into…');
    this.setInstructions([
      { command: '\u21b5', purpose: 'transform, keeping position and size' },
      { command: 'esc', purpose: 'leave it as it is' }
    ]);
  }
  getItems() {
    const cur = WIDGETS[this.elm.type];
    const seen = [], sameGroup = [], rest = [];
    for (const key in WIDGETS) {
      const def = WIDGETS[key];
      if (seen.indexOf(def) >= 0) continue;
      seen.push(def);
      if (def === cur) continue;               // it is already that
      (cur && def.group === cur.group ? sameGroup : rest).push(def);
    }
    const byLabel = function (a, b) { return a.label.localeCompare(b.label); };
    return sameGroup.sort(byLabel).concat(rest.sort(byLabel));
  }
  getItemText(def) {
    return def.name + ' ' + def.label + ' ' + def.group + ' ' + (def.aliases || []).join(' ');
  }
  renderSuggestion(match, el) {
    const def = match.item;
    el.addClass('wf-qa-row');
    el.createDiv({ cls: 'wf-qa-name', text: def.name });
    el.createDiv({ cls: 'wf-qa-label', text: def.label });
    el.createDiv({ cls: 'wf-qa-group', text: def.group });
  }
  onChooseItem(def) { this.view.transformSelection(def); }
}

class MasterPickerModal extends FuzzySuggestModal {
  constructor(app, plugin, files) {
    super(app);
    this.plugin = plugin;
    this.files = files;
    this.setPlaceholder('Insert a master…');
  }
  getItems() { return this.files; }
  getItemText(f) { return f.basename; }
  onChooseItem(f) { this.plugin.insertMaster(f); }
}

/* Obsidian's review guidelines rule out window.prompt/alert, so text input
 * that is not part of a view goes through a Modal. */
class TextPromptModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts || {};
    this.value = this.opts.value || '';
    this.done = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    // a Modal has a titleEl for exactly this; an h3 in the body is a heading
    // Obsidian's own styling does not know about
    this.titleEl.setText(this.opts.title || 'Name');
    if (this.opts.description) {
      contentEl.createEl('p', { cls: 'wf-modal-desc', text: this.opts.description });
    }
    const input = contentEl.createEl('input', {
      cls: 'wf-modal-input',
      attr: { type: 'text', placeholder: this.opts.placeholder || '' }
    });
    input.value = this.value;
    const row = contentEl.createDiv({ cls: 'wf-modal-row' });
    const cancel = row.createEl('button', { text: 'Cancel' });
    const ok = row.createEl('button', { cls: 'mod-cta', text: this.opts.cta || 'Save' });

    const finish = (val) => {
      if (this.done) return;
      this.done = true;
      this.close();
      if (this.opts.onSubmit) this.opts.onSubmit(val);
    };
    ok.addEventListener('click', () => finish(input.value.trim()));
    cancel.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') { evt.preventDefault(); finish(input.value.trim()); }
      if (evt.key === 'Escape') { evt.preventDefault(); finish(null); }
    });
    window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  onClose() {
    this.contentEl.empty();
    if (!this.done) { this.done = true; if (this.opts.onSubmit) this.opts.onSubmit(null); }
  }
}

class IconPickerModal extends FuzzySuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder('Icon name — briefcase, users, calendar…');
  }
  getItems() { return iconNames(); }
  getItemText(n) { return n + ' ' + (ICON_ALIASES_BY_TARGET[n] || []).join(' '); }
  renderSuggestion(match, el) {
    el.addClass('wf-qa-row');
    const ic = el.createDiv({ cls: 'wf-icopick' });
    iconEl(ic, match.item, 18);
    el.createDiv({ cls: 'wf-qa-label', text: match.item });
    const al = (ICON_ALIASES_BY_TARGET[match.item] || []);
    if (al.length) el.createDiv({ cls: 'wf-qa-group', text: al.join(', ') });
  }
  onChooseItem(n) { this.plugin.insertIcon(n); }
}

class StarterModal extends FuzzySuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder('Insert a starter wireframe…');
  }
  getItems() { return Object.keys(STARTERS); }
  getItemText(k) { return k; }
  onChooseItem(k) { this.plugin.insertStarter(k); }
}

const STARTERS = {
  'Desktop app shell': {
    size: [1000, 640],
    body: [
      'window: Projects | app.example.com/projects',
      '  row:',
      '    sidebar: Dashboard | Projects* | People | Reports | Settings',
      '    col: (grow)',
      '      row:',
      '        h1: Projects (grow)',
      '        btn: New project (primary)',
      '      row:',
      '        search: Filter projects... (grow)',
      '        btns: All* | Active | Done',
      '      table:',
      '        Name | Status | Owner | Due',
      '        * Website redesign | In progress | Design | 12 Mar',
      '        Mobile app | Done | Engineering | 28 Feb',
      '        Onboarding flow | Planned | Support | 3 Apr',
      '      pagination: 1* | 2 | 3'
    ].join('\n')
  },
  'Login screen': {
    size: [460, 520],
    body: [
      'card: Sign in',
      '  input: Work email',
      '  password: Password',
      '  row:',
      '    checkbox: [x] Remember me',
      '    link: Forgot? (right)',
      '  btn: Sign in (primary, fill)',
      '  divider: or',
      '  btn: Continue with Google (fill)'
    ].join('\n')
  },
  'Mobile list screen': {
    size: [420, 780],
    body: [
      'phone: 9:41',
      '  nav: Projects*',
      '  search: Search projects...',
      '  list:',
      '    * Website redesign — In progress',
      '    Mobile app — Done',
      '    Onboarding flow — Planned',
      '    -',
      '    Billing rework — Blocked',
      '  fab: plus'
    ].join('\n')
  },
  'Form / settings page': {
    size: [520, 620],
    body: [
      'card: Notification settings',
      '  toggle: [x] Email me about updates',
      '  toggle: [ ] Weekly digest',
      '  divider:',
      '  select: Digest day | Monday* | Friday',
      '  slider: Quiet hours | 30',
      '  radio:',
      '    (o) All activity',
      '    ( ) Mentions only',
      '  divider:',
      '  row:',
      '    btn: Cancel',
      '    btn: Save changes (primary)'
    ].join('\n')
  },
  'Empty + loading + error states': {
    size: [420, 560],
    body: [
      'col:',
      '  card: Empty',
      '    empty: No projects yet | Create your first project',
      '  card: Loading',
      '    spinner: Fetching projects',
      '  card: Error',
      '    alert: Could not reach the server (error)',
      '    btn: Retry'
    ].join('\n')
  },
  'Dashboard with metrics': {
    size: [900, 520],
    body: [
      'window: Dashboard | app.example.com',
      '  h1: This quarter',
      '  row:',
      '    stat: 1,284 | Tasks done',
      '    stat: 42% | On time',
      '    stat: 18 | Active projects',
      '  row:',
      '    chart: Projects by status',
      '      Planned | 40',
      '      In progress | 75',
      '      Done | 55',
      '      Blocked | 20',
      '    card: Busiest teams',
      '      kv:',
      '        Design | 18',
      '        Engineering | 12',
      '        Support | 9'
    ].join('\n')
  }
};

/* ================================================================== *
 * WIREFRAME EDITOR
 *
 * A standalone editor, not a Canvas add-on. `.wire` files open in a view
 * with the conventional layout: palette on the left, canvas in the
 * middle, property inspector on the right.
 *
 * Elements are absolutely positioned — no flow
 * layout, no nesting. That is what makes direct manipulation simple: an
 * element is a box you can move and resize, and containers are just
 * boxes you place other boxes on top of.
 *
 * Every element is still rendered by the same 79 widget renderers used
 * by the ```wf code blocks. It goes through the DSL to get there, so the
 * editor and the code-block mode can never draw the same widget two
 * different ways.
 * ================================================================== */

const WIRE_VIEW = 'wireframy-editor';
const WIRE_EXT = 'wire';
const GRID = 8;
const UNDO_DEPTH = 80;
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/* ---------- document ---------- */

function emptyDoc() {
  return { version: 1, skin: null, elements: [], links: [], view: { x: 0, y: 0, zoom: 1 }, nextId: 1 };
}

function parseDoc(text) {
  if (!text || !text.trim()) return emptyDoc();
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return emptyDoc(); }
  const doc = emptyDoc();
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.elements)) doc.elements = raw.elements.filter(function (e) {
      return e && typeof e.type === 'string' && WIDGETS[e.type];
    }).map(normaliseElement);
    if (raw.view && typeof raw.view === 'object') {
      doc.view = {
        x: Number(raw.view.x) || 0,
        y: Number(raw.view.y) || 0,
        zoom: Math.min(4, Math.max(0.2, Number(raw.view.zoom) || 1))
      };
    }
    if (typeof raw.skin === 'string') doc.skin = raw.skin;
    if (Array.isArray(raw.links)) {
      const ids = doc.elements.map(function (e) { return e.id; });
      doc.links = raw.links.filter(function (l) {
        // drop links whose endpoints no longer exist, rather than drawing into space
        return l && ids.indexOf(Number(l.from)) >= 0 && ids.indexOf(Number(l.to)) >= 0 &&
               Number(l.from) !== Number(l.to);
      }).map(function (l) {
        return {
          id: Number(l.id) || 0, from: Number(l.from), to: Number(l.to),
          label: typeof l.label === 'string' ? l.label : ''
        };
      });
    }
  }
  doc.nextId = Math.max(
    doc.elements.reduce(function (a, e) { return Math.max(a, Number(e.id) || 0); }, 0),
    doc.links.reduce(function (a, l) { return Math.max(a, Number(l.id) || 0); }, 0)
  ) + 1;
  return doc;
}

function normaliseElement(e) {
  return {
    id: Number(e.id) || 0,
    type: e.type,
    x: Math.round(Number(e.x) || 0),
    y: Math.round(Number(e.y) || 0),
    w: Math.max(16, Math.round(Number(e.w) || 160)),
    h: Math.max(12, Math.round(Number(e.h) || 40)),
    value: typeof e.value === 'string' ? e.value : '',
    // a widget that does not read rows should not carry them: older versions
    // offered a rows box on containers, and the text people typed is still in
    // those files doing nothing
    rows: (typeof e.rows === 'string' && defTakesRows(WIDGETS[e.type])) ? e.rows : '',
    mods: Array.isArray(e.mods) ? e.mods.filter(function (m) { return typeof m === 'string'; }) : []
  };
}

function serializeDoc(doc) {
  return JSON.stringify({
    version: 1,
    skin: doc.skin,
    view: { x: Math.round(doc.view.x), y: Math.round(doc.view.y), zoom: Number(doc.view.zoom.toFixed(3)) },
    elements: doc.elements.map(function (e) {
      const o = { id: e.id, type: e.type, x: e.x, y: e.y, w: e.w, h: e.h };
      if (e.value) o.value = e.value;
      if (e.rows) o.rows = e.rows;
      if (e.mods && e.mods.length) o.mods = e.mods;
      return o;
    }),
    links: (doc.links || []).map(function (l) {
      const o = { id: l.id, from: l.from, to: l.to };
      if (l.label) o.label = l.label;
      return o;
    })
  }, null, 2) + '\n';
}

/* ---------- element -> the DSL -> the shared renderers ---------- */

function elementDsl(elm) {
  const mods = (elm.mods && elm.mods.length) ? ' (' + elm.mods.join(', ') + ')' : '';
  let out = elm.type + ': ' + String(elm.value == null ? '' : elm.value) + mods;
  const rows = String(elm.rows == null ? '' : elm.rows);
  if (rows.trim()) {
    out += '\n' + rows.replace(/\s+$/, '').split('\n').map(function (l) { return '  ' + l; }).join('\n');
  }
  return out;
}

function elementNode(elm) {
  const tree = parseWf(elementDsl(elm));
  return tree.children[0] || { type: elm.type, value: '', children: [] };
}

function renderElementInto(host, elm, skin) {
  const def = WIDGETS[elm.type];
  const root = host.createDiv({ cls: 'wf-root wf-skin-' + (skin || 'sketch') });
  if (!def) { root.createDiv({ cls: 'wf-error', text: 'unknown widget "' + elm.type + '"' }); return; }
  const wrap = root.createDiv({ cls: 'wf-w wf-w-' + def.name });
  try {
    def.render(wrap, elementNode(elm), {});
  } catch (e) {
    wrap.empty();
    wrap.createDiv({ cls: 'wf-error', text: '⚠ ' + (e && e.message ? e.message : 'render failed') });
  }
}

/* A new element, seeded from the widget's palette snippet so it arrives
 * looking like its thumbnail rather than blank. */
function elementFromDef(def, id, x, y) {
  const tree = parseWf(def.snippet);
  const top = tree.children[0];
  let value = '', rows = '', mods = [];
  if (top) {
    const info = splitMods(top.value);
    value = info.text;
    mods = info.mods;
    rows = top.children.filter(function (c) { return c.type === '_row'; })
                       .map(function (c) { return c.value; }).join('\n');
  }
  return {
    id: id, type: def.name,
    x: Math.round(x), y: Math.round(y),
    w: def.size[0], h: def.size[1],
    value: value, rows: rows, mods: mods
  };
}

/* Which widgets actually read data rows.
 *
 * Deriving this from the snippet was wrong twice over: it said yes for every
 * container (whose indented lines are child widgets) and no for `text:` and
 * `note:` (which accept rows but whose default shows none). This list is the
 * set of renderers that call dataRows / numRows / flatRows, and the test suite
 * verifies it behaviourally — render each widget with rows and without, and the
 * output only differs for the ones named here. */
const ROWS_WIDGETS = ['accordion', 'chart', 'checkbox', 'kv', 'linechart', 'list',
  'menu', 'note', 'pie', 'radio', 'table', 'text', 'tree'];

function defTakesRows(def) {
  return !!def && ROWS_WIDGETS.indexOf(def.name) >= 0;
}

function isRowElement(elm) {
  // deliberately not "elm.rows is non-empty": a stale rows value left on a
  // container by an older version would otherwise resurrect the empty rows box
  return defTakesRows(WIDGETS[elm.type]);
}

/* Pure containers have no text of their own — their value only ever carries
 * modifiers — so double-clicking them should say so rather than opening an
 * empty box. */
const NO_TEXT_TYPES = ['row', 'hbox', 'col', 'vbox', 'stack', 'scroll', 'well', 'splitter', 'split',
  'triangle', 'shape'];
function hasEditableText(type) { return NO_TEXT_TYPES.indexOf(type) < 0; }

/* ---------- placing a container places what its thumbnail showed ---------- *
 * Dragging "Field set" out of the palette should give you the field set with
 * Street and City inside it, not an empty rectangle. Elements are absolutely
 * positioned, so the children are laid out once, here, at drop time.
 */

// how much of the top of a container is chrome the children must clear
function chromeInset(type, hasTitle) {
  if (type === 'window' || type === 'browser') return 78;
  if (type === 'phone' || type === 'device') return 44;
  if (type === 'modal' || type === 'dialog') return 46;
  if (type === 'card' || type === 'panel' || type === 'box') return hasTitle ? 40 : 12;
  if (type === 'screen') return 40;
  if (type === 'fieldset' || type === 'group') return 24;
  return 12;
}

const ROW_CONTAINERS = ['row', 'hbox', 'splitter', 'split'];

/* Lays a container's children out inside it, growing the container when its
 * declared size cannot hold them — better to end up with a taller field set
 * than with two squashed inputs, and you can resize it afterwards anyway.
 * Recurses depth-first so a nested container is grown before its own height is
 * used to advance the stack. */
function layoutChildren(parentNode, parentElm, out, nextId) {
  const kids = parentNode.children.filter(function (c) { return c.type !== '_row' && WIDGETS[c.type]; });
  if (!kids.length) return nextId;

  const pad = 16;
  const gap = 10;
  const top = parentElm.y + chromeInset(parentElm.type, !!parentElm.value);
  const innerX = parentElm.x + pad;
  const innerW = Math.max(40, parentElm.w - pad * 2);
  const horizontal = ROW_CONTAINERS.indexOf(parentElm.type) >= 0;

  function makeChild(kid, x, y, w, h) {
    const info = splitMods(kid.value);
    return {
      id: nextId++, type: WIDGETS[kid.type].name,
      x: Math.round(x), y: Math.round(y),
      w: Math.max(24, Math.round(w)), h: Math.max(20, Math.round(h)),
      value: info.text,
      rows: kid.children.filter(function (c) { return c.type === '_row'; })
                        .map(function (c) { return c.value; }).join('\n'),
      mods: info.mods
    };
  }

  if (horizontal) {
    const each = Math.max(40, Math.floor((innerW - gap * (kids.length - 1)) / kids.length));
    let x = innerX;
    let tallest = 0;
    for (const kid of kids) {
      const def = WIDGETS[kid.type];
      const elm = makeChild(kid, x, top, each, def.size[1]);
      out.push(elm);
      nextId = layoutChildren(kid, elm, out, nextId);
      tallest = Math.max(tallest, elm.h);
      x += each + gap;
    }
    const needed = top + tallest + pad - parentElm.y;
    if (needed > parentElm.h) parentElm.h = Math.round(needed);
    return nextId;
  }

  let y = top;
  for (const kid of kids) {
    const def = WIDGETS[kid.type];
    const elm = makeChild(kid, innerX, y, innerW, def.size[1]);
    out.push(elm);
    nextId = layoutChildren(kid, elm, out, nextId);   // may grow elm.h
    y += elm.h + gap;
  }
  const needed = (y - gap) + pad - parentElm.y;
  if (needed > parentElm.h) parentElm.h = Math.round(needed);
  return nextId;
}

/* Returns every element the palette card promised: the widget itself, plus any
 * children its thumbnail showed, laid out inside it. */
function elementsFromDef(def, startId, x, y) {
  const tree = parseWf(def.snippet);
  const top = tree.children[0];
  const info = top ? splitMods(top.value) : { text: '', mods: [] };
  const root = {
    id: startId, type: def.name,
    x: Math.round(x), y: Math.round(y),
    w: def.size[0], h: def.size[1],
    value: info.text,
    rows: top ? top.children.filter(function (c) { return c.type === '_row'; })
                            .map(function (c) { return c.value; }).join('\n') : '',
    mods: info.mods
  };
  const out = [root];
  if (top) layoutChildren(top, root, out, startId + 1);
  return out;
}

/* Kept for the single-element case and for tests. */
function elementFromDef(def, id, x, y) {
  return elementsFromDef(def, id, x, y)[0];
}

/* ---------- connector geometry ---------- *
 * Cubic beziers, the way Obsidian Canvas draws its edges: the curve leaves the
 * middle of a side along that side's normal and enters the target the same way,
 * so two boxes side by side get a clean S and a box below gets a soft drop.
 * Right-angle elbows were the earlier shape and read as a flowchart rather than
 * a sketch.
 */
const LABEL_HIT = 24;      // how far around a label counts as aiming at it
const ARROW_PAD = 26;

function centreOf(e) { return { x: e.x + e.w / 2, y: e.y + e.h / 2 }; }

function bezierAt(g, t) {
  const u = 1 - t;
  return {
    x: u * u * u * g.p1.x + 3 * u * u * t * g.c1.x + 3 * u * t * t * g.c2.x + t * t * t * g.p2.x,
    y: u * u * u * g.p1.y + 3 * u * u * t * g.c1.y + 3 * u * t * t * g.c2.y + t * t * t * g.p2.y
  };
}

function linkGeometry(a, b) {
  const ca = centreOf(a), cb = centreOf(b);
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  const horizontal = Math.abs(dx) >= Math.abs(dy);

  let p1, p2, n1, n2, dir;
  if (horizontal) {
    if (dx >= 0) {
      p1 = { x: a.x + a.w, y: ca.y }; p2 = { x: b.x, y: cb.y };
      n1 = { x: 1, y: 0 }; n2 = { x: -1, y: 0 }; dir = 'e';
    } else {
      p1 = { x: a.x, y: ca.y }; p2 = { x: b.x + b.w, y: cb.y };
      n1 = { x: -1, y: 0 }; n2 = { x: 1, y: 0 }; dir = 'w';
    }
  } else {
    if (dy >= 0) {
      p1 = { x: ca.x, y: a.y + a.h }; p2 = { x: cb.x, y: b.y };
      n1 = { x: 0, y: 1 }; n2 = { x: 0, y: -1 }; dir = 's';
    } else {
      p1 = { x: ca.x, y: a.y }; p2 = { x: cb.x, y: b.y + b.h };
      n1 = { x: 0, y: -1 }; n2 = { x: 0, y: 1 }; dir = 'n';
    }
  }

  // How far the control points reach out. Proportional to the gap, so short
  // hops stay tight and long ones sweep, with limits at both ends.
  const dist = Math.sqrt((p2.x - p1.x) * (p2.x - p1.x) + (p2.y - p1.y) * (p2.y - p1.y));
  const k = Math.max(34, Math.min(210, dist * 0.45));
  const c1 = { x: p1.x + n1.x * k, y: p1.y + n1.y * k };
  const c2 = { x: p2.x + n2.x * k, y: p2.y + n2.y * k };

  const g = { p1: p1, p2: p2, c1: c1, c2: c2, dir: dir };
  g.mid = bezierAt(g, 0.5);

  // the arrowhead points along the tangent at the end, which for a cubic is
  // simply the direction from the last control point to the endpoint
  const tx = p2.x - c2.x, ty = p2.y - c2.y;
  const len = Math.sqrt(tx * tx + ty * ty) || 1;
  g.end = { x: tx / len, y: ty / len };

  // a bezier never leaves the hull of its four points, so this bounds it
  g.hull = [p1, c1, c2, p2];
  return g;
}

function bezierPath(g, ox, oy) {
  const f = function (n) { return Math.round(n * 100) / 100; };
  return 'M ' + f(g.p1.x - ox) + ' ' + f(g.p1.y - oy) +
         ' C ' + f(g.c1.x - ox) + ' ' + f(g.c1.y - oy) +
         ' ' + f(g.c2.x - ox) + ' ' + f(g.c2.y - oy) +
         ' ' + f(g.p2.x - ox) + ' ' + f(g.p2.y - oy);
}

/* A small filled triangle at the endpoint, rotated onto the curve's tangent. */
function arrowHead(p, dirVec, size) {
  const k = size || 9;
  const ux = dirVec.x, uy = dirVec.y;
  const px = -uy, py = ux;
  const bx = p.x - ux * k, by = p.y - uy * k;
  const w = k * 0.44;
  return [
    [p.x, p.y],
    [bx + px * w, by + py * w],
    [bx - px * w, by - py * w]
  ];
}

/* ---------- editable properties, per widget ---------- */

const MODS_ALL = ['bold', 'muted', 'small', 'large', 'center', 'right', 'disabled'];
const MODS_BY_TYPE = {
  btn: ['primary', 'secondary', 'danger', 'ghost', 'disabled', 'fill', 'small', 'large'],
  btns: ['disabled', 'fill'],
  link: ['muted', 'small', 'bold'],
  alert: ['error', 'success', 'warning'],
  input: ['disabled'], password: ['disabled'], search: ['disabled'],
  textarea: ['disabled'], select: ['disabled'], date: ['disabled'],
  row: ['top', 'middle', 'bottom', 'stretch', 'nowrap'],
  text: MODS_ALL, h1: ['center', 'right'], h2: ['center', 'right'], h3: ['center', 'right'],
  table: ['flat'], icon: ['large'], shape: ['fill', 'dashed'],
  rect: ['fill', 'dashed', 'bold', 'muted', 'small', 'large'],
  circle: ['fill', 'dashed', 'bold', 'muted', 'small', 'large'],
  triangle: ['fill', 'dashed']
};
function modsFor(type) {
  if (Object.prototype.hasOwnProperty.call(MODS_BY_TYPE, type)) return MODS_BY_TYPE[type];
  return ['bold', 'muted', 'small', 'large', 'disabled'];
}

/* Human wording for what the one-line field actually is, per widget. */
const VALUE_LABEL = {
  window: 'Tab title | address', phone: 'Status bar', card: 'Title', screen: 'Screen name',
  fieldset: 'Legend', well: 'No text — drop widgets onto it',
  row: 'No text — a layout box', col: 'No text — a layout box',
  scroll: 'No text — a layout box', splitter: 'No text — a layout box',
  modal: 'Title', nav: 'Items, separated by |', tabs: 'Tabs, separated by |',
  sidebar: 'Items, separated by |', vtabs: 'Tabs, separated by |',
  breadcrumb: 'Trail, separated by |', steps: 'Steps, separated by |',
  pagination: 'Pages, separated by |', toolbar: 'Icon names, separated by |',
  menubar: 'Menus, separated by |', btns: 'Segments, separated by |',
  badge: 'Chips, separated by |', tagcloud: 'Tags, separated by |',
  iconrow: 'Icon names, separated by |', sitemap: 'Root | children',
  input: 'Label = value', password: 'Label', textarea: 'Label = value',
  select: 'Label | options', date: 'Label = value', search: 'Placeholder',
  slider: 'Label | 0-100', progress: 'Label | 0-100', scrollbar: 'Position 0-90',
  stepper: 'Value', rating: 'e.g. 4 of 5', colorpicker: 'How many swatches',
  calendar: 'Month YYYY | selected day', toggle: '[x] Label',
  btn: 'Button text', link: 'Link text', icon: 'Icon name', fab: 'Icon name',
  img: 'e.g. 320x180', avatar: 'Initials, or a number', lorem: 'How many words',
  stat: 'Number | label', empty: 'Title | button', spinner: 'Message',
  alert: 'Message', chart: 'Chart title', pie: 'Chart title', linechart: 'Chart title',
  video: 'Caption', map: 'Caption', shape: 'rect, circle or triangle',
  rect: 'Text inside it (optional)', circle: 'Text inside it (optional)',
  triangle: 'No text — a plain shape',
  note: 'Note text', callout: 'Number | text', bubble: 'Who | what',
  tooltip: 'Tooltip text', brace: 'Label', vbrace: 'Label', arrow: 'Label',
  measure: 'e.g. 24px', divider: 'Label (optional)', spacer: 'Height in px'
};
function valueLabel(type) { return VALUE_LABEL[type] || 'Text'; }

const ROWS_LABEL = {
  table: 'Rows — cells split by |, * marks the selected row, - is a separator',
  list: 'Items — one per line, * marks selected, - is a separator',
  menu: 'Items — - separator, [x] tick, > submenu, * highlighted',
  kv: 'Pairs — Label | value',
  checkbox: 'Options — [x] or [ ] then the label',
  radio: 'Options — (o) or ( ) then the label',
  chart: 'Bars — Label | number', pie: 'Slices — Label | number',
  linechart: 'Points — Label | number',
  tree: 'Rows — indent two spaces to nest, * marks selected',
  accordion: 'Sections — * marks the open one, Title | body',
  text: 'Body copy',
  note: 'Lines — one per line, kept as separate lines'
};
function rowsLabel(type) { return ROWS_LABEL[type] || 'Rows, one per line'; }

/* ---------- exporting the board as a picture ---------- *
 * Job B8: get the picture into the conversation that is already happening.
 * The widgets are DOM, so the only honest way to picture them is to let the
 * browser draw the DOM: serialise the surface into an SVG foreignObject and
 * rasterise that. Re-implementing 79 renderers against a 2D canvas would be a
 * second source of truth, and the two would drift.
 */

/* Obsidian loads a plugin's styles.css into a stylesheet of its own, so there is
 * no single element holding it. Walk the document's sheets and keep the rules
 * that are ours - selectors mentioning .wf- or .wire-, plus any block defining
 * a --wf-* token. Reading one element instead of this produced a completely
 * unstyled export, and nothing said so. */
function collectPluginCss(docObj) {
  const out = [];
  const sheets = (docObj && docObj.styleSheets) || [];
  for (let i = 0; i < sheets.length; i++) {
    let rules = null;
    try { rules = sheets[i].cssRules; } catch (e) { continue; }   // cross-origin
    if (!rules) continue;
    for (let j = 0; j < rules.length; j++) {
      const t = (rules[j] && rules[j].cssText) || '';
      if (/\.(wf-|wire-)/.test(t) || /--wf-/.test(t)) out.push(t);
    }
  }
  return out.join('\n');
}

/* The exported SVG must not depend on Obsidian's stylesheet being present, so
 * every custom property the plugin's CSS references is resolved to a literal
 * and emitted as a :root block ahead of it. */
function exportCss(cssText, probeEl) {
  const css = String(cssText || '');
  const names = [];
  const re = /var\((--[a-zA-Z0-9-]+)/g;
  let m;
  while ((m = re.exec(css))) if (names.indexOf(m[1]) < 0) names.push(m[1]);
  let cs = null;
  try { cs = probeEl && typeof getComputedStyle === 'function' ? getComputedStyle(probeEl) : null; }
  catch (e) { cs = null; }
  const decls = [];
  for (const n of names) {
    let v = '';
    try { v = cs ? String(cs.getPropertyValue(n) || '').trim() : ''; } catch (e) { v = ''; }
    if (v) decls.push(n + ': ' + v + ';');
  }
  return ':root {' + decls.join(' ') + '}\n' + css;
}

/* The extent of the drawing, in document coordinates, with a margin. Exporting
 * the viewport would crop whatever is off-screen, which is the one thing the
 * person pasting it into Slack will not notice until it is too late. */
function boardBounds(doc, pad) {
  const margin = typeof pad === 'number' ? pad : 32;
  const els = (doc && doc.elements) || [];
  if (!els.length) return { x: 0, y: 0, w: 640, h: 400, empty: true };
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const e of els) {
    x1 = Math.min(x1, e.x); y1 = Math.min(y1, e.y);
    x2 = Math.max(x2, e.x + e.w); y2 = Math.max(y2, e.y + e.h);
  }
  return {
    x: Math.round(x1 - margin), y: Math.round(y1 - margin),
    w: Math.max(1, Math.round(x2 - x1 + margin * 2)),
    h: Math.max(1, Math.round(y2 - y1 + margin * 2)),
    empty: false
  };
}

/* A filename that will not collide and will not offend the vault. */
/* A data URL is base64; the vault wants bytes. atob is the browser's own
 * decoder, so no node builtin is involved. */
function dataUrlToBytes(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  if (comma < 0) return null;
  try {
    const bin = window.atob(s.slice(comma + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) { return null; }
}

function imageNameFor(basename, taken) {
  const safe = String(basename || 'Wireframe').replace(/[\\/:|#^\[\]]/g, ' ').trim() || 'Wireframe';
  let name = safe + '.png';
  let n = 2;
  while (taken && taken(name)) { name = safe + ' ' + n++ + '.png'; if (n > 500) break; }
  return name;
}

/* ---------- transform in place ---------- *
 * The job: "I realise the thing I drew as a combo box should be a radio group,
 * and I do not want to rebuild the layout around that." So geometry ALWAYS
 * carries over - that is the whole point, and everything positioned around it
 * stays put. Content carries over only where the target can actually hold it:
 * text when the target has editable text, rows when it reads rows, modifiers
 * only where the target offers them. What the target cannot hold is dropped
 * rather than kept invisibly in the file, so what you see is what is stored.
 * The id is preserved, so any arrows attached to the element survive.
 */
function transformElement(elm, targetDef) {
  if (!elm || !targetDef || !targetDef.name) return null;
  const type = targetDef.name;
  const allowed = modsFor(type);
  return normaliseElement({
    id: elm.id,
    type: type,
    x: elm.x, y: elm.y, w: elm.w, h: elm.h,
    value: hasEditableText(type) ? elm.value : '',
    rows: defTakesRows(targetDef) ? elm.rows : '',
    mods: (Array.isArray(elm.mods) ? elm.mods : []).filter(function (m) {
      return allowed.indexOf(m) >= 0;
    })
  });
}

/* What survived and what did not, in words. The user just changed the identity
 * of something on their board; silence would leave them guessing. */
function transformSummary(before, after, fromDef, toDef) {
  const from = fromDef ? fromDef.label : before.type;
  const to = toDef ? toDef.label : after.type;
  const head = from + ' → ' + to + '.';
  const kept = after.value ? 'Text, position and size kept.' : 'Position and size kept.';
  const dropped = [];
  if (before.value && !after.value) dropped.push('text');
  if (before.rows && !after.rows) dropped.push('rows');
  const keptMods = Array.isArray(after.mods) ? after.mods : [];
  for (const m of (Array.isArray(before.mods) ? before.mods : [])) {
    if (keptMods.indexOf(m) < 0) dropped.push(m);
  }
  if (!dropped.length) return head + ' ' + kept;
  return head + ' ' + kept + ' Dropped: ' + dropped.join(', ') + '.';
}

/* ---------- clipboard ---------- *
 * Two paths on purpose. The DOM copy/cut/paste events are the correct hook for
 * Cmd+C/V/X: they fire for the keystroke AND for the native Edit menu, and they
 * do not require claiming a hotkey that the whole app already uses. The module
 * buffer is the fallback for when clipboardData is unavailable, and is what
 * makes paste work between two wireframes in the same session.
 */
const WIRE_CLIP_KIND = 'wireframy-clip';
let WIRE_CLIPBOARD = null;

function clipFromSelection(view) {
  const ids = view.sel.slice();
  if (!ids.length) return null;
  const elements = view.selected().map(function (e) { return JSON.parse(JSON.stringify(e)); });
  // an arrow travels with the copy only when both of its ends do
  const links = view.doc.links
    .filter(function (l) { return ids.indexOf(l.from) >= 0 && ids.indexOf(l.to) >= 0; })
    .map(function (l) { return JSON.parse(JSON.stringify(l)); });
  return { kind: WIRE_CLIP_KIND, version: 1, elements: elements, links: links };
}

function parseClip(text) {
  if (!text) return null;
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return null; }
  if (!raw || raw.kind !== WIRE_CLIP_KIND || !Array.isArray(raw.elements)) return null;
  const elements = raw.elements.filter(function (e) { return e && WIDGETS[e.type]; }).map(normaliseElement);
  if (!elements.length) return null;
  return { kind: WIRE_CLIP_KIND, version: 1, elements: elements, links: Array.isArray(raw.links) ? raw.links : [] };
}

/* ---------- the editor view ---------- */

class WireEditorView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.doc = emptyDoc();
    this.sel = [];                 // selected element ids
    this.els = new Map();          // id -> DOM node, for cheap drag updates
    this.history = [];
    this.hIndex = -1;
    this.grid = true;
    this.filter = '';
    this.drag = null;
    this.editing = null;
    this.selLink = null;       // links have their own selection
    this.connectMode = false;
    this.locked = false;       // job B7: a board you opened only to look at
    this.presenting = false;   // job B2: the board on a wall, in a meeting
    this.showHelp = false;     // the shortcut list, when nothing is selected
    this.palOpen = false;      // the palette is a search bar until you use it
    this.palTab = 'elements';  // the palette has two tabs: elements and icons
    this.iconFilter = '';      // each tab keeps its own query
  }

  getViewType() { return WIRE_VIEW; }
  getIcon() { return 'drafting-compass'; }
  getDisplayText() { return this.file ? this.file.basename : 'Wireframe'; }

  /* --- TextFileView contract --- */

  getViewData() { return serializeDoc(this.doc); }

  setViewData(data, clear) {
    this.doc = parseDoc(data);
    if (clear) { this.history = []; this.hIndex = -1; }
    this.sel = [];
    if (!this.appEl) this.build();
    this.renderAll();
    this.snapshot(true);
  }

  clear() {
    this.doc = emptyDoc();
    this.sel = [];
    if (this.appEl) this.renderAll();
  }

  skin() { return this.doc.skin || this.plugin.settings.skin || 'sketch'; }

  /* --- history --- */

  snapshot(initial) {
    const state = JSON.stringify({ e: this.doc.elements, l: this.doc.links });
    if (!initial && this.history[this.hIndex] === state) return;
    this.history = this.history.slice(0, this.hIndex + 1);
    this.history.push(state);
    if (this.history.length > UNDO_DEPTH) this.history.shift();
    this.hIndex = this.history.length - 1;
  }

  commit() {                       // after any mutation
    this.snapshot(false);
    this.requestSave();
    this.renderAll();
  }

  undo() {
    if (this.hIndex <= 0) return;
    this.hIndex--;
    this.restore(this.history[this.hIndex]);
    this.requestSave();
    this.renderAll();
  }

  redo() {
    if (this.hIndex >= this.history.length - 1) return;
    this.hIndex++;
    this.restore(this.history[this.hIndex]);
    this.requestSave();
    this.renderAll();
  }

  /* --- helpers --- */

  restore(state) {
    const snap = JSON.parse(state);
    this.doc.elements = (snap.e || []).map(normaliseElement);
    this.doc.links = snap.l || [];
    this.sel = this.sel.filter((id) => this.byId(id));
    if (this.selLink && !this.linkById(this.selLink)) this.selLink = null;
  }

  linkById(id) {
    for (const l of this.doc.links) if (l.id === id) return l;
    return null;
  }

  // a link is meaningless once an endpoint is gone
  pruneLinks() {
    const ids = this.doc.elements.map(function (e) { return e.id; });
    this.doc.links = this.doc.links.filter(function (l) {
      return ids.indexOf(l.from) >= 0 && ids.indexOf(l.to) >= 0;
    });
  }

  byId(id) {
    for (const e of this.doc.elements) if (e.id === id) return e;
    return null;
  }
  selected() { return this.sel.map((id) => this.byId(id)).filter(Boolean); }
  snap(n) { return this.grid ? Math.round(n / GRID) * GRID : Math.round(n); }

  /* Topmost element containing a document point. Later elements paint over
   * earlier ones, so the search runs backwards. */
  centreOfId(id) {
    const e = this.byId(id);
    return e ? { x: e.x + e.w / 2, y: e.y + e.h / 2 } : { x: 0, y: 0 };
  }

  elementAt(p) {
    for (let i = this.doc.elements.length - 1; i >= 0; i--) {
      const e = this.doc.elements[i];
      if (p.x >= e.x && p.x <= e.x + e.w && p.y >= e.y && p.y <= e.y + e.h) return e;
    }
    return null;
  }

  /* Arrows have to be hit-tested in document space, for exactly the reason
   * elements do: by the time `dblclick` fires the stage has captured the
   * pointer, so evt.target is the stage and closest('.wire-link') is null.
   * That is why double-clicking an arrow used to do nothing at all.
   *
   * The curve is sampled rather than solved: the distance from a point to a
   * cubic bezier has no cheap closed form, and 40 samples over a link is far
   * below anything a pointer event can notice. */
  linkAt(pt, tolerance) {
    const tol = typeof tolerance === 'number' ? tolerance : 10;
    const SAMPLES = 40;
    let best = null;
    for (const link of this.doc.links) {
      const a = this.byId(link.from), b = this.byId(link.to);
      if (!a || !b) continue;
      const g = linkGeometry(a, b);
      let d = Infinity;
      for (let i = 0; i <= SAMPLES; i++) {
        const q = bezierAt(g, i / SAMPLES);
        const dx = q.x - pt.x, dy = q.y - pt.y;
        const dd = Math.sqrt(dx * dx + dy * dy);
        if (dd < d) d = dd;
      }
      // the label is part of the target - people aim at the text, not the line
      if (link.label) {
        const lx = g.mid.x - pt.x, ly = g.mid.y - pt.y;
        d = Math.min(d, Math.max(0, Math.sqrt(lx * lx + ly * ly) - LABEL_HIT));
      }
      if (d <= tol && (!best || d < best.d)) best = { link: link, d: d };
    }
    return best ? best.link : null;
  }

  docPoint(evt) {
    const r = this.stageEl.getBoundingClientRect();
    const v = this.doc.view;
    return {
      x: (evt.clientX - r.left - v.x) / v.zoom,
      y: (evt.clientY - r.top - v.y) / v.zoom
    };
  }

  /* --- layout --- */

  build() {
    const c = this.contentEl;
    c.empty();
    c.addClass('wire-host');
    this.appEl = c.createDiv({ cls: 'wire-app' });

    this.toolbarEl = this.appEl.createDiv({ cls: 'wire-toolbar' });
    const body = this.appEl.createDiv({ cls: 'wire-body' });
    this.paletteEl = body.createDiv({ cls: 'wire-palette' });
    this.stageEl = body.createDiv({ cls: 'wire-stage', attr: { tabindex: '0' } });
    this.surfaceEl = this.stageEl.createDiv({ cls: 'wire-surface' });
    this.marqueeEl = this.stageEl.createDiv({ cls: 'wire-marquee' });
    this.marqueeEl.hidden = true;
    this.inspectorEl = body.createDiv({ cls: 'wire-inspector' });

    this.buildToolbar();
    this.buildPalette();
    this.installPointer();
    this.installKeys();
    this.registerDomEvent(document, 'fullscreenchange', () => {
      if (this.presenting && !document.fullscreenElement) this.setPresenting(false);
    });
  }

  buildToolbar() {
    const t = this.toolbarEl;
    t.empty();

    /* data-wire-tb is a stable hook that does not move when the copy does:
     * tests target the button, assertions target the tooltip. */
    const btn = (parent, icon, title, fn, label) => {
      const b = parent.createDiv({ cls: 'wire-tb-btn' });
      if (icon) {
        iconEl(b, icon, 15);
        b.setAttribute('data-wire-tb', icon);
      }
      if (label) b.createSpan({ cls: 'wire-tb-label', text: label });
      b.setAttribute('aria-label', title);
      b.setAttribute('title', title);
      b.addEventListener('click', () => { fn(); this.stageEl.focus(); });
      return b;
    };
    const sep = () => t.createDiv({ cls: 'wire-tb-sep' });

    const g1 = t.createDiv({ cls: 'wire-tb-group' });
    btn(g1, 'undo', 'Undo', () => this.undo());
    btn(g1, 'redo', 'Redo', () => this.redo());
    sep();

    const g2 = t.createDiv({ cls: 'wire-tb-group' });
    btn(g2, 'minus', 'Zoom out', () => this.zoomBy(1 / 1.2));
    this.zoomLabel = g2.createDiv({ cls: 'wire-tb-zoom' });
    this.zoomLabel.addEventListener('click', () => this.setZoom(1));
    this.zoomLabel.setAttribute('title', 'Click to reset to 100%');
    btn(g2, 'plus', 'Zoom in', () => this.zoomBy(1.2));
    btn(g2, 'maximize', 'Fit everything', () => this.zoomToFit());
    sep();

    const g3 = t.createDiv({ cls: 'wire-tb-group' });
    this.gridBtn = btn(g3, 'grid', '', () => {
      this.grid = !this.grid;
      this.gridBtn.classList.toggle('wire-on', this.grid);
      this.stageEl.classList.toggle('wire-showgrid', this.grid);
      this.syncGridTooltip();
    });
    this.gridBtn.classList.add('wire-on');
    this.stageEl.classList.add('wire-showgrid');
    this.syncGridTooltip();
    this.skinBtn = btn(g3, 'palette', 'Cycle the skin — sketch, clean, wire', () => {
      const order = ['sketch', 'clean', 'wire'];
      const i = order.indexOf(this.skin());
      this.doc.skin = order[(i + 1) % order.length];
      this.commit();
    }, this.skin());
    sep();

    this.connectBtn = btn(g3, 'arrow-right', 'Connect — click one element, then the next', () => {
      this.setConnectMode(!this.connectMode);
    }, 'connect');
    this.lockBtn = btn(g3, 'lock', 'Lock the board against edits', () => this.setLocked(!this.locked));
    this.lockBtn.setAttribute('aria-label', 'Toggle the edit lock');
    if (this.locked) this.lockBtn.classList.add('wire-on');
    sep();

    const g4 = t.createDiv({ cls: 'wire-tb-group wire-tb-sel' });
    // the control that swaps the type is labelled with the type it currently
    // is, so you always know what you are looking at. The swap icon beside it
    // is the verb, so the label must not repeat the glyph
    this.transformBtn = btn(g4, 'swap',
      'Transform (' + modLabel('T', true) + ')', () => this.openTransform(), ' ');
    btn(g4, 'copy', 'Duplicate (' + modLabel('D') + ')', () => this.duplicate());
    btn(g4, 'chevron-up', 'Bring to front', () => this.reorder(1));
    btn(g4, 'chevron-down', 'Send to back', () => this.reorder(-1));
    btn(g4, 'trash', 'Delete (' + DELETE_KEY_LABEL + ')', () => this.deleteSelection());
    this.selGroup = g4;

    const spacer = t.createDiv({ cls: 'wire-tb-spacer' });
    void spacer;
    this.helpBtn = btn(t, 'help', 'Show the keyboard shortcuts', () => this.setShowHelp(!this.showHelp));
    this.helpBtn.setAttribute('aria-label', 'Toggle the keyboard shortcuts');
    this.countEl = t.createDiv({ cls: 'wire-tb-count' });
  }

  /* Returns a PNG data URL for the whole board, or null if the platform will
   * not rasterise. Selection chrome is stripped from a clone, so the live DOM
   * is never touched and the picture has no handles in it. */
  async boardImage(scale) {
    if (!this.surfaceEl) return null;
    const at = typeof scale === 'number' && scale > 0 ? scale : 2;
    const box = boardBounds(this.doc, 32);

    const clone = this.surfaceEl.cloneNode(true);
    clone.style.transform = 'translate(' + (-box.x) + 'px,' + (-box.y) + 'px)';
    for (const junk of Array.prototype.slice.call(
      clone.querySelectorAll('.wire-handles, .wire-nubs, .wire-guide, .wire-marquee'))) {
      if (junk.parentNode) junk.parentNode.removeChild(junk);
    }
    for (const sel of Array.prototype.slice.call(clone.querySelectorAll('.wire-selected'))) {
      sel.classList.remove('wire-selected');
    }

    const cssText = collectPluginCss(document);
    const css = exportCss(cssText, this.stageEl).replace(/\]\]>/g, ']]&gt;');

    let markup = '';
    try { markup = new XMLSerializer().serializeToString(clone); }
    catch (e) { return null; }

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + (box.w * at) +
      '" height="' + (box.h * at) + '" viewBox="0 0 ' + box.w + ' ' + box.h + '">' +
      '<foreignObject width="100%" height="100%">' +
      '<div xmlns="http://www.w3.org/1999/xhtml">' +
      '<style><![CDATA[' + css + ']]></style>' + markup +
      '</div></foreignObject></svg>';

    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = await new Promise(function (res) {
      const i = new Image();
      i.onload = function () { res(i); };
      i.onerror = function () { res(null); };
      i.src = url;
      window.setTimeout(function () { res(null); }, 8000);
    });
    if (!img) return null;

    const canvas = document.createElement('canvas');
    canvas.width = box.w * at;
    canvas.height = box.h * at;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    // a wireframe on a transparent ground turns into an unreadable smear the
    // moment it lands on a dark Slack theme
    let ground = '#ffffff';
    try {
      const c = getComputedStyle(this.stageEl).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') ground = c;
    } catch (e) { /* keep white */ }
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    try { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); }
    catch (e) { return null; }
    try { return canvas.toDataURL('image/png'); } catch (e) { return null; }
  }

  /* Job B2: get the team to agree on what to build. Presenting is a
   * one-keystroke act, on the toolbar as well as on a shortcut, because the
   * moment you need it is mid-sentence, not after an export. Nothing can be
   * edited while presenting: the point is the room looking at one thing. */
  setPresenting(on) {
    const want = !!on;
    if (want === this.presenting) return;
    this.presenting = want;
    if (want) {
      this.wasLocked = this.locked;
      this.locked = true;
      this.sel = []; this.selLink = null;
      this.setConnectMode(false);
    } else {
      this.locked = !!this.wasLocked;
    }
    this.contentEl.classList.toggle('wire-present', this.presenting);
    this.stageEl.classList.toggle('wire-locked', this.locked);
    this.syncInspectorVisibility();
    // fullscreen is a nicety, not the feature: if the platform refuses, the
    // chrome-free view still works
    try {
      if (this.presenting && this.contentEl.requestFullscreen) {
        const r = this.contentEl.requestFullscreen();
        if (r && r.catch) r.catch(function () { /* refused; carry on */ });
      } else if (!this.presenting && document.fullscreenElement &&
                 document.exitFullscreen) {
        const r = document.exitFullscreen();
        if (r && r.catch) r.catch(function () { /* noop */ });
      }
    } catch (e) { /* noop */ }
    this.renderAll();
    // fit after the chrome has gone, or it fits to the old stage width
    window.setTimeout(() => { if (this.presenting) this.zoomToFit(); this.stageEl.focus(); }, 30);
    if (this.presenting) new Notice('Presenting. Esc to come back.');
  }

  /* Job B7: a full review mode is multiplayer and Obsidian is not, but the
   * half that transfers is the read-only view: stop the accidental drag that
   * silently dirties a file you only opened to look at. */
  setLocked(on) {
    this.locked = !!on;
    this.stageEl.classList.toggle('wire-locked', this.locked);
    if (this.locked) { this.sel = []; this.selLink = null; this.setConnectMode(false); }
    if (this.lockBtn) {
      this.lockBtn.classList.toggle('wire-on', this.locked);
      this.lockBtn.setAttribute('title', this.locked ? 'Unlock and allow edits' : 'Lock the board against edits');
      this.lockBtn.setAttribute('aria-label', 'Toggle the edit lock');
    }
    this.renderAll();
    new Notice(this.locked
      ? 'Board locked. Nothing can be moved until you unlock it.'
      : 'Board unlocked. Edits are back on.');
  }

  /* The transform button's label is the element's current type, so it reads
   * "swap this thing that is currently a browser window". With nothing (or
   * several things) selected there is no single type to name. */
  syncTransformLabel() {
    if (!this.transformBtn) return;
    const label = this.transformBtn.querySelector('.wire-tb-label');
    if (!label) return;
    let text = '';
    if (this.sel.length === 1) {
      const elm = this.byId(this.sel[0]);
      const def = elm ? WIDGETS[elm.type] : null;
      if (def) text = def.label;
    }
    label.textContent = text;
  }

  /* Rule: a toggle's tooltip names the next state, not the control. Static
   * text on a toggle is wrong half the time. The accessible name stays
   * state-neutral so a screen reader is not told the control changed identity. */
  syncGridTooltip() {
    if (!this.gridBtn) return;
    this.gridBtn.setAttribute('title',
      this.grid ? 'Turn the 8px snap grid off' : 'Turn the 8px snap grid on');
    this.gridBtn.setAttribute('aria-label', 'Toggle the 8px snap grid');
  }

  setShowHelp(on) {
    this.showHelp = !!on;
    this.renderInspector();
  }

  setConnectMode(on) {
    this.connectMode = !!on;
    this.connectFrom = null;
    if (this.connectBtn) this.connectBtn.classList.toggle('wire-on', this.connectMode);
    this.stageEl.classList.toggle('wire-connecting', this.connectMode);
    if (this.connectMode) { this.sel = []; this.selLink = null; this.renderAll(); }
    this.stageEl.focus();
  }

  /* Two tabs, because there are two libraries. The icons used to be reachable
   * only by typing a name you already knew into an icon widget's value field,
   * which meant 160 of them were effectively invisible. Icons get their own
   * slot in the rail for the same reason. */
  buildPalette() {
    const p = this.paletteEl;
    p.empty();

    const tabs = p.createDiv({ cls: 'wire-pal-tabs' });
    this.palTabEls = {};
    const tab = (key, label, count) => {
      const t = tabs.createDiv({ cls: 'wire-pal-tab' });
      t.createSpan({ text: label });
      t.createSpan({ cls: 'wire-pal-tab-count', text: String(count) });
      t.setAttribute('data-wire-tab', key);
      t.setAttribute('role', 'tab');
      t.addEventListener('click', () => this.setPaletteTab(key));
      this.palTabEls[key] = t;
      return t;
    };
    tab('elements', 'Elements', uniqueDefs().length);
    tab('icons', 'Icons', iconNames().length);

    this.palSearchEl = p.createEl('input', {
      cls: 'wire-pal-search',
      attr: { type: 'text' }
    });
    this.palHintEl = p.createDiv({
      cls: 'wire-pal-hint',
      text: 'Click above, or pick a tab, to browse'
    });
    this.palSearchEl.addEventListener('input', () => {
      if (this.palTab === 'icons') this.iconFilter = this.palSearchEl.value;
      else this.filter = this.palSearchEl.value;
      this.drawPalette();
    });

    // clicking or typing in the search box is the gesture that opens it
    this.palSearchEl.addEventListener('focus', () => this.setPaletteOpen(true));
    this.palSearchEl.addEventListener('keydown', (evt) => {
      evt.stopPropagation();
      if (evt.key === 'Escape') {
        evt.preventDefault();
        this.palSearchEl.value = '';
        if (this.palTab === 'icons') this.iconFilter = ''; else this.filter = '';
        this.drawPalette();
        this.setPaletteOpen(false);
        this.stageEl.focus();
      }
    });

    this.palListEl = p.createDiv({ cls: 'wire-pal-list' });
    this.syncPaletteOpen();
    this.syncPaletteTab();
    this.drawPalette();
  }

  /* Collapsed, the palette is a tab strip and a search box floating over the
   * top-left of the canvas - a flyout, not a dock. The stage keeps its full
   * width either way; typing or clicking opens the list, going back to the
   * board closes it. */
  setPaletteOpen(on) {
    const want = !!on;
    if (want === this.palOpen) return;
    this.palOpen = want;
    this.syncPaletteOpen();
  }

  syncPaletteOpen() {
    if (!this.paletteEl) return;
    this.paletteEl.classList.toggle('wire-pal-shut', !this.palOpen);
    if (this.palHintEl) this.palHintEl.hidden = this.palOpen;
  }

  setPaletteTab(key, query) {
    this.setPaletteOpen(true);
    this.palTab = key === 'icons' ? 'icons' : 'elements';
    if (typeof query === 'string') {
      if (this.palTab === 'icons') this.iconFilter = query;
      else this.filter = query;
    }
    this.syncPaletteTab();
    this.drawPalette();
    if (this.palSearchEl) this.palSearchEl.focus();
  }

  syncPaletteTab() {
    for (const k in this.palTabEls) {
      this.palTabEls[k].classList.toggle('wire-on', k === this.palTab);
      this.palTabEls[k].setAttribute('aria-selected', k === this.palTab ? 'true' : 'false');
    }
    if (!this.palSearchEl) return;
    const icons = this.palTab === 'icons';
    this.palSearchEl.value = icons ? this.iconFilter : this.filter;
    this.palSearchEl.setAttribute('placeholder', icons
      ? 'Search ' + iconNames().length + ' icons — try user, chart, lock'
      : 'Search elements — try button, table, phone');
  }

  drawPalette() {
    if (this.palTab === 'icons') this.drawIconPalette();
    else this.drawWidgetPalette();
  }

  /* Every icon, drawn at its real size, searchable by name and by alias. Click
   * drops one in the middle; drag places it where you let go. */
  drawIconPalette() {
    const host = this.palListEl;
    host.empty();
    const q = this.iconFilter.trim().toLowerCase();
    const names = q ? iconsMatching(q) : iconNames();

    if (!names.length) {
      const none = host.createDiv({ cls: 'wire-pal-none' });
      none.createDiv({ text: 'No icons match "' + this.iconFilter + '".' });
      const act = none.createDiv({
        cls: 'wire-pal-none-act',
        text: 'Search the elements instead'
      });
      act.addEventListener('click', () => this.setPaletteTab('elements', this.iconFilter));
      return;
    }

    host.createDiv({
      cls: 'wire-pal-group',
      text: q ? names.length + (names.length === 1 ? ' match' : ' matches') : 'All icons'
    });
    const grid = host.createDiv({ cls: 'wire-pal-icons' });
    for (const name of names) {
      const cell = grid.createDiv({ cls: 'wire-pal-icon' });
      iconEl(cell.createDiv({ cls: 'wire-pal-icon-art' }), name, 22);
      cell.createDiv({ cls: 'wire-pal-icon-name', text: name });
      const alts = ICON_ALIASES_BY_TARGET[name] || [];
      cell.setAttribute('title', name + (alts.length ? '  \u00b7  ' + alts.join(', ') : '') +
        '\n\nDrag onto the canvas, or click to drop it in the middle.');
      cell.addEventListener('click', () => this.placeIconAtCentre(name));
      cell.setAttribute('draggable', 'true');
      cell.addEventListener('dragstart', (evt) => {
        this.palDragIcon = name;
        this.palDrag = null;
        try {
          evt.dataTransfer.effectAllowed = 'copy';
          evt.dataTransfer.setData('text/plain', name);
        } catch (e) { /* noop */ }
      });
      cell.addEventListener('dragend', () => { this.palDragIcon = null; });
    }
  }

  drawWidgetPalette() {
    const host = this.palListEl;
    host.empty();
    const q = this.filter.trim().toLowerCase();
    const groups = paletteGroups(function (def) {
      if (!q) return true;
      const hay = (def.name + ' ' + def.label + ' ' + def.group + ' ' +
        def.aliases.join(' ')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    let any = false;
    for (const group of groups) {
      const defs = group.defs;
      if (!defs.length) continue;
      any = true;
      // search results keep their group headings, so you learn where things
      // live by finding them, which a flat result list would not teach
      host.createDiv({ cls: 'wire-pal-group', text: group.name });
      const wrap = host.createDiv({ cls: 'wire-pal-cards' });
      for (const def of defs) {
        const card = wrap.createDiv({ cls: 'wire-pal-card' });
        card.createDiv({ cls: 'wire-pal-name', text: def.label });
        const th = card.createDiv({ cls: 'wire-pal-thumb' });
        const stage = th.createDiv({ cls: 'wire-pal-stage' });
        stage.style.width = def.size[0] + 'px';
        stage.style.zoom = String(Math.min(1, 196 / def.size[0]).toFixed(4));
        renderWireframe(stage, def.snippet, { skin: this.skin() });
        card.setAttribute('title', def.name + (def.aliases.length ? '  ·  ' + def.aliases.join(', ') : '') +
          '\n\nDrag onto the canvas, or click to drop it in the middle.');
        card.addEventListener('click', () => this.placeAtCentre(def));
        card.setAttribute('draggable', 'true');
        card.addEventListener('dragstart', (evt) => {
          this.palDrag = def;
          try {
            evt.dataTransfer.effectAllowed = 'copy';
            evt.dataTransfer.setData('text/plain', def.name);
            evt.dataTransfer.setDragImage(th, 20, 14);
          } catch (e) { /* noop */ }
        });
        card.addEventListener('dragend', () => { this.palDrag = null; });
      }
    }
    if (!any) {
      const none = host.createDiv({ cls: 'wire-pal-none' });
      const hits = iconsMatching(this.filter);
      if (hits.length) {
        none.createDiv({
          text: 'No widgets match "' + this.filter + '" — but ' + hits.length +
            (hits.length === 1 ? ' icon does.' : ' icons do.')
        });
        const act = none.createDiv({
          cls: 'wire-pal-none-act',
          text: 'Show me'
        });
        act.setAttribute('title', 'Switches to the Icons tab, keeping what you typed');
        act.addEventListener('click', () => this.setPaletteTab('icons', this.filter));
      } else {
        none.setText('Nothing matches "' + this.filter + '"');
      }
    }
  }

  /* --- rendering --- */

  renderAll() {
    if (!this.surfaceEl || !this.surfaceEl.isConnected) return;
    if (this.rendering) { this.renderPending = true; return; }
    this.rendering = true;
    try {
      this.renderAllInner();
    } finally {
      this.rendering = false;
      if (this.renderPending) { this.renderPending = false; this.renderAll(); }
    }
  }

  renderAllInner() {
    this.surfaceEl.empty();
    this.els.clear();
    // Arrows first, so they sit behind the elements — the way Canvas draws its
    // edges. Painted on top, their generous click target stole clicks from the
    // elements they were attached to.
    this.renderLinks();
    for (const elm of this.doc.elements) this.renderOne(elm);
    this.renderEmptyState();
    this.applyView();
    this.renderSelection();
    this.renderInspector();
    if (this.countEl) {
      const n = this.doc.elements.length;
      this.countEl.setText(n + (n === 1 ? ' element' : ' elements'));
    }
    if (this.skinBtn) {
      const label = this.skinBtn.querySelector('.wire-tb-label');
      if (label) label.textContent = this.skin();
    }
  }

  renderOne(elm) {
    const box = this.surfaceEl.createDiv({ cls: 'wire-el' });
    box.dataset.id = String(elm.id);
    box.style.left = elm.x + 'px';
    box.style.top = elm.y + 'px';
    box.style.width = elm.w + 'px';
    box.style.height = elm.h + 'px';
    const inner = box.createDiv({ cls: 'wire-el-inner' });
    renderElementInto(inner, elm, this.skin());
    this.els.set(elm.id, box);
    return box;
  }

  /* Each arrow gets its own small SVG, positioned over its own bounding box.
   * One document-sized SVG would have to be huge to cover negative
   * coordinates; per-link boxes keep the maths local and hit-testing exact. */
  renderLinks() {
    for (const link of this.doc.links) {
      const a = this.byId(link.from), b = this.byId(link.to);
      if (!a || !b) continue;
      const g = linkGeometry(a, b);
      const xs = g.hull.map(function (p) { return p.x; });
      const ys = g.hull.map(function (p) { return p.y; });
      const x0 = Math.min.apply(null, xs) - ARROW_PAD;
      const y0 = Math.min.apply(null, ys) - ARROW_PAD;
      const w = Math.max.apply(null, xs) - x0 + ARROW_PAD;
      const h = Math.max.apply(null, ys) - y0 + ARROW_PAD;

      const host = this.surfaceEl.createDiv({
        cls: 'wire-link' + (this.selLink === link.id ? ' wire-link-sel' : '')
      });
      host.dataset.link = String(link.id);
      host.style.left = x0 + 'px';
      host.style.top = y0 + 'px';
      host.style.width = w + 'px';
      host.style.height = h + 'px';

      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('width', String(w));
      svg.setAttribute('height', String(h));
      svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
      svg.setAttribute('fill', 'none');
      host.appendChild(svg);

      const d = bezierPath(g, x0, y0);
      // a fat transparent copy underneath, so the thin curve is easy to click
      svgChild(svg, 'path', { d: d, stroke: 'transparent', 'stroke-width': 16, class: 'wire-link-hit' });
      svgChild(svg, 'path', {
        d: d, stroke: 'currentColor', 'stroke-width': 1.7,
        'stroke-linecap': 'round', class: 'wire-link-line'
      });
      const head = arrowHead({ x: g.p2.x - x0, y: g.p2.y - y0 }, g.end, 10);
      svgChild(svg, 'polygon', {
        points: head.map(function (p) { return p[0] + ',' + p[1]; }).join(' '),
        fill: 'currentColor', stroke: 'none', class: 'wire-link-head'
      });

      if (link.label) {
        const lab = host.createDiv({ cls: 'wire-link-label', text: link.label });
        lab.style.left = (g.mid.x - x0) + 'px';
        lab.style.top = (g.mid.y - y0) + 'px';
      }
    }
  }

  /* Just the selected class, on the hosts that already exist. Rebuilding the
   * link DOM here would destroy the node the pointer is on, which is what broke
   * double-click. */
  renderLinkSelection() {
    const hosts = this.surfaceEl.querySelectorAll('.wire-link');
    for (let i = 0; i < hosts.length; i++) {
      const h = hosts[i];
      h.classList.toggle('wire-link-sel', Number(h.dataset.link) === this.selLink);
    }
  }

  /* A blank canvas is the one moment the tool has to explain itself. */
  renderEmptyState() {
    const existing = this.stageEl.querySelector('.wire-empty');
    if (existing) existing.remove();
    if (this.doc.elements.length) return;
    const box = this.stageEl.createDiv({ cls: 'wire-empty' });
    iconEl(box.createDiv({ cls: 'wire-empty-icon' }), 'layout', 34);
    box.createDiv({ cls: 'wire-empty-title', text: 'Start with a screen' });
    box.createDiv({
      cls: 'wire-empty-body',
      text: 'Drag a widget from UI elements on the left, or click one to drop it here.'
    });
    const row = box.createDiv({ cls: 'wire-empty-row' });
    for (const name of ['window', 'phone', 'card']) {
      const def = WIDGETS[name];
      if (!def) continue;
      const b = row.createDiv({ cls: 'wire-empty-btn', text: 'Add a ' + def.label.toLowerCase() });
      b.addEventListener('click', () => this.placeAtCentre(def));
    }
  }

  renderSelection() {
    for (const [id, box] of this.els) {
      const on = this.sel.indexOf(id) >= 0;
      box.classList.toggle('wire-selected', on);
      const old = box.querySelector('.wire-handles');
      if (old) old.remove();
      if (on && this.sel.length === 1) {
        const hs = box.createDiv({ cls: 'wire-handles' });
        for (const h of HANDLES) {
          const el = hs.createDiv({ cls: 'wire-handle wire-h-' + h });
          el.dataset.handle = h;
        }
      }
      // Connector nubs: always present, faint until you hover the element.
      // Dragging one draws an arrow — no mode to remember, which is how
      // Obsidian Canvas itself behaves.
      if (!box.querySelector('.wire-nubs')) {
        const nubs = box.createDiv({ cls: 'wire-nubs' });
        for (const side of ['n', 'e', 's', 'w']) {
          const nub = nubs.createDiv({ cls: 'wire-nub wire-nub-' + side });
          nub.dataset.nub = side;
          nub.setAttribute('title', 'Drag to connect, or click both ends');
        }
      }
    }
    if (this.selGroup) this.selGroup.classList.toggle('wire-dim', this.sel.length === 0);
    this.syncTransformLabel();
    this.syncInspectorVisibility();
  }

  applyView() {
    const v = this.doc.view;
    this.surfaceEl.style.transform = 'translate(' + v.x + 'px,' + v.y + 'px) scale(' + v.zoom + ')';
    this.stageEl.style.setProperty('--wire-grid', (GRID * v.zoom) + 'px');
    // keep the grid locked to the document, not the viewport
    this.stageEl.style.backgroundPosition = v.x + 'px ' + v.y + 'px';
    if (this.zoomLabel) this.zoomLabel.setText(Math.round(v.zoom * 100) + '%');
  }

  /* --- zoom / pan --- */

  setZoom(z, cx, cy) {
    const v = this.doc.view;
    const nz = Math.min(4, Math.max(0.2, z));
    const r = this.stageEl.getBoundingClientRect();
    const px = cx == null ? r.width / 2 : cx - r.left;
    const py = cy == null ? r.height / 2 : cy - r.top;
    v.x = px - (px - v.x) * (nz / v.zoom);
    v.y = py - (py - v.y) * (nz / v.zoom);
    v.zoom = nz;
    this.applyView();
    this.requestSave();
  }
  zoomBy(f) { this.setZoom(this.doc.view.zoom * f); }

  zoomToFit() {
    const els = this.doc.elements;
    const v = this.doc.view;
    const r = this.stageEl.getBoundingClientRect();
    if (!els.length) { v.x = 40; v.y = 40; v.zoom = 1; this.applyView(); return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of els) {
      x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y);
      x1 = Math.max(x1, e.x + e.w); y1 = Math.max(y1, e.y + e.h);
    }
    const pad = 48;
    const z = Math.min(4, Math.max(0.2, Math.min(
      (r.width - pad * 2) / Math.max(1, x1 - x0),
      (r.height - pad * 2) / Math.max(1, y1 - y0)
    )));
    v.zoom = z;
    v.x = pad - x0 * z + Math.max(0, (r.width - pad * 2 - (x1 - x0) * z) / 2);
    v.y = pad - y0 * z + Math.max(0, (r.height - pad * 2 - (y1 - y0) * z) / 2);
    this.applyView();
    this.requestSave();
  }

  /* --- mutations --- */

  addElement(def, x, y, silent) {
    const group = elementsFromDef(def, this.doc.nextId, this.snap(x), this.snap(y));
    for (const elm of group) this.doc.elements.push(elm);
    this.doc.nextId += group.length;
    // select the container, so the first thing you can do is move the whole thing
    this.sel = [group[0].id];
    if (!silent) this.commit();
    return group[0];
  }

  placeAtCentre(def) {
    const r = this.stageEl.getBoundingClientRect();
    const v = this.doc.view;
    const cx = (r.width / 2 - v.x) / v.zoom - def.size[0] / 2;
    const cy = (r.height / 2 - v.y) / v.zoom - def.size[1] / 2;
    const made = this.addElement(def, cx, cy);
    this.stageEl.focus();
    return made;
  }

  /* One commit, so placing the icon and naming it is a single undo step. */
  placeIconAtCentre(name) {
    const def = WIDGETS['icon'];
    if (!def) return null;
    const r = this.stageEl.getBoundingClientRect();
    const v = this.doc.view;
    const cx = (r.width / 2 - v.x) / v.zoom - def.size[0] / 2;
    const cy = (r.height / 2 - v.y) / v.zoom - def.size[1] / 2;
    const made = this.addElement(def, cx, cy, true);
    if (made) made.value = String(name || '');
    this.commit();
    this.stageEl.focus();
    return made;
  }

  /* Rule: destructive wording matches how destructive the act really is. This
   * one is fully recoverable, so the notice says so rather than staying silent
   * and leaving the user to wonder whether the delete took. */
  undoHint(what) {
    new Notice('Deleted ' + what + ' — ' + modLabel('Z') + ' to undo.');
  }

  /* One commit, so a transform is a single undo step. */
  transformSelection(def) {
    if (this.sel.length !== 1) { new Notice('Select exactly one element first.'); return null; }
    const elm = this.byId(this.sel[0]);
    if (!elm || !def) return null;
    const fromDef = WIDGETS[elm.type];
    if (fromDef === def) {
      new Notice('That is already a ' + def.label.toLowerCase() + '.');
      return null;
    }
    const before = JSON.parse(JSON.stringify(elm));
    const next = transformElement(elm, def);
    if (!next) return null;
    const at = this.doc.elements.indexOf(elm);
    if (at < 0) return null;
    this.doc.elements[at] = next;
    this.sel = [next.id];
    this.commit();
    new Notice(transformSummary(before, next, fromDef, def));
    return next;
  }

  openTransform() {
    if (this.sel.length !== 1) { new Notice('Select exactly one element first.'); return; }
    const elm = this.byId(this.sel[0]);
    if (elm) new TransformModal(this.app, this, elm).open();
  }

  deleteSelection() {
    if (this.selLink) {
      const id = this.selLink;
      this.doc.links = this.doc.links.filter(function (l) { return l.id !== id; });
      this.selLink = null;
      this.commit();
      this.undoHint('the arrow');
      return;
    }
    if (!this.sel.length) return;
    const gone = this.sel.slice();
    const only = gone.length === 1 ? this.byId(gone[0]) : null;
    const onlyDef = only ? WIDGETS[only.type] : null;
    this.doc.elements = this.doc.elements.filter(function (e) { return gone.indexOf(e.id) < 0; });
    this.sel = [];
    this.pruneLinks();
    this.commit();
    this.undoHint(onlyDef ? 'the ' + onlyDef.label.toLowerCase()
                          : gone.length + ' elements');
  }

  addLink(fromId, toId) {
    if (fromId === toId) return null;
    const dupe = this.doc.links.filter(function (l) {
      return (l.from === fromId && l.to === toId) || (l.from === toId && l.to === fromId);
    })[0];
    if (dupe) { this.selLink = dupe.id; this.renderAll(); return dupe; }
    const link = { id: this.doc.nextId++, from: fromId, to: toId, label: '' };
    this.doc.links.push(link);
    this.sel = [];
    this.selLink = link.id;
    this.commit();
    return link;
  }

  copySelection() {
    const clip = clipFromSelection(this);
    if (!clip) return null;
    WIRE_CLIPBOARD = clip;
    return JSON.stringify(clip);
  }

  cutSelection() {
    const text = this.copySelection();
    if (text) this.deleteSelection();
    return text;
  }

  /* Pastes a payload, remapping ids so nothing collides and arrows still point
   * at the right copies. Lands offset from where it was copied; if that would
   * be off-screen it lands in the middle of the view instead. */
  pasteClip(clip) {
    const payload = clip || WIRE_CLIPBOARD;
    if (!payload || !payload.elements.length) return false;

    let dx = GRID * 2, dy = GRID * 2;
    const x0 = Math.min.apply(null, payload.elements.map(function (e) { return e.x; }));
    const y0 = Math.min.apply(null, payload.elements.map(function (e) { return e.y; }));
    const r = this.stageEl.getBoundingClientRect();
    const v = this.doc.view;
    const onScreenX = (x0 + dx) * v.zoom + v.x;
    const onScreenY = (y0 + dy) * v.zoom + v.y;
    if (onScreenX < 0 || onScreenY < 0 || onScreenX > r.width || onScreenY > r.height) {
      dx = ((r.width / 2 - v.x) / v.zoom) - x0;
      dy = ((r.height / 2 - v.y) / v.zoom) - y0;
    }

    const idMap = {};
    const added = [];
    for (const src of payload.elements) {
      if (!src || !WIDGETS[src.type]) continue;
      // Normalise here: this is the trust boundary. A payload can come from an
      // older version, another vault, or a hand-edited clipboard, and an element
      // missing its mods array used to crash the inspector on the next render.
      const copy = normaliseElement(JSON.parse(JSON.stringify(src)));
      const oldId = copy.id;
      copy.id = this.doc.nextId++;
      idMap[oldId] = copy.id;
      copy.x = this.snap(copy.x + dx);
      copy.y = this.snap(copy.y + dy);
      this.doc.elements.push(copy);
      added.push(copy.id);
    }
    for (const l of payload.links || []) {
      const from = idMap[l.from], to = idMap[l.to];
      if (!from || !to) continue;
      this.doc.links.push({ id: this.doc.nextId++, from: from, to: to, label: l.label || '' });
    }

    if (!added.length) return false;
    this.sel = added;
    this.selLink = null;
    this.commit();
    return true;
  }

  duplicate() {
    const clip = clipFromSelection(this);
    if (!clip) return;
    // reuse the paste path so a duplicate keeps its internal arrows as well
    this.pasteClip(clip);
  }

  reorder(dir) {                   // +1 to front, -1 to back
    const picked = this.selected();
    if (!picked.length) return;
    const ids = picked.map(function (e) { return e.id; });
    const rest = this.doc.elements.filter(function (e) { return ids.indexOf(e.id) < 0; });
    this.doc.elements = dir > 0 ? rest.concat(picked) : picked.concat(rest);
    this.commit();
  }

  align(how) {
    const picked = this.selected();
    if (picked.length < 2) return;
    const x0 = Math.min.apply(null, picked.map(function (e) { return e.x; }));
    const x1 = Math.max.apply(null, picked.map(function (e) { return e.x + e.w; }));
    const y0 = Math.min.apply(null, picked.map(function (e) { return e.y; }));
    const y1 = Math.max.apply(null, picked.map(function (e) { return e.y + e.h; }));
    for (const e of picked) {
      if (how === 'left') e.x = x0;
      else if (how === 'right') e.x = x1 - e.w;
      else if (how === 'hcentre') e.x = Math.round((x0 + x1) / 2 - e.w / 2);
      else if (how === 'top') e.y = y0;
      else if (how === 'bottom') e.y = y1 - e.h;
      else if (how === 'vcentre') e.y = Math.round((y0 + y1) / 2 - e.h / 2);
    }
    this.commit();
  }

  /* --- pointer --- */

  installPointer() {
    const stage = this.stageEl;

    this.registerDomEvent(stage, 'pointerdown', (evt) => this.onDown(evt));
    this.registerDomEvent(stage, 'pointermove', (evt) => this.onMove(evt));
    this.registerDomEvent(stage, 'pointerup', (evt) => this.onUp(evt));
    this.registerDomEvent(stage, 'pointercancel', (evt) => this.onUp(evt));
    this.registerDomEvent(stage, 'dblclick', (evt) => {
      // target is unreliable under pointer capture; hit-test instead
      const hit = this.elementAt(this.docPoint(evt));
      if (hit) { evt.preventDefault(); this.startEdit(hit.id); return; }
      // never evt.target here: the stage has the pointer by now
      const link = this.linkAt(this.docPoint(evt));
      if (link) {
        evt.preventDefault();
        this.startEditLink(link.id);
      }
    });
    this.registerDomEvent(stage, 'contextmenu', (evt) => evt.preventDefault());

    // Cmd/Ctrl+C, X and V arrive as these events — and so do the native Edit
    // menu items — which is why the editor does not bind those keys itself.
    this.registerDomEvent(stage, 'copy', (evt) => {
      if (this.editing) return;
      const text = this.copySelection();
      if (!text) return;
      evt.preventDefault();
      if (evt.clipboardData) evt.clipboardData.setData('text/plain', text);
    });
    this.registerDomEvent(stage, 'cut', (evt) => {
      if (this.editing) return;
      const text = this.cutSelection();
      if (!text) return;
      evt.preventDefault();
      if (evt.clipboardData) evt.clipboardData.setData('text/plain', text);
    });
    this.registerDomEvent(stage, 'paste', (evt) => {
      if (this.editing) return;
      const text = evt.clipboardData ? evt.clipboardData.getData('text/plain') : '';
      const clip = parseClip(text);
      if (!clip && !WIRE_CLIPBOARD) return;
      evt.preventDefault();
      this.pasteClip(clip || WIRE_CLIPBOARD);
    });

    this.registerDomEvent(stage, 'wheel', (evt) => {
      if (evt.ctrlKey || evt.metaKey) {
        evt.preventDefault();
        this.setZoom(this.doc.view.zoom * (evt.deltaY < 0 ? 1.12 : 1 / 1.12), evt.clientX, evt.clientY);
        return;
      }
      evt.preventDefault();
      this.doc.view.x -= evt.deltaX;
      this.doc.view.y -= evt.deltaY;
      this.applyView();
      this.requestSave();
    }, { passive: false });

    // dropping from the palette
    this.registerDomEvent(stage, 'dragover', (evt) => {
      if (!this.palDrag && !this.palDragIcon) return;
      evt.preventDefault();
      try { evt.dataTransfer.dropEffect = 'copy'; } catch (e) { /* noop */ }
      stage.classList.add('wire-drop');
    });
    this.registerDomEvent(stage, 'dragleave', () => stage.classList.remove('wire-drop'));
    this.registerDomEvent(stage, 'drop', (evt) => {
      const def = this.palDrag;
      const iconName = this.palDragIcon;
      stage.classList.remove('wire-drop');
      if (!def && !iconName) return;
      evt.preventDefault();
      this.palDrag = null;
      this.palDragIcon = null;
      const p = this.docPoint(evt);
      if (iconName) {
        // one commit, so placing the icon and naming it is a single undo step
        const iconDef = WIDGETS['icon'];
        if (!iconDef) return;
        const made = this.addElement(iconDef,
          p.x - iconDef.size[0] / 2, p.y - iconDef.size[1] / 2, true);
        if (made) made.value = iconName;
        this.commit();
      } else {
        this.addElement(def, p.x - def.size[0] / 2, p.y - def.size[1] / 2);
      }
      this.stageEl.focus();
    });
  }

  onDown(evt) {
    if (!this.surfaceEl || !this.surfaceEl.isConnected) return;
    // back on the board: the palette gets out of the way again
    this.setPaletteOpen(false);
    // a pointerdown inside the open edit box is the user moving the caret, not
    // a click on the board; committing here closed the box mid-sentence
    if (evt.target.closest && evt.target.closest('.wire-edit')) return;
    if (this.editing) this.commitEdit();
    this.stageEl.focus();
    if (evt.button === 2) return;

    let wantPan = evt.button === 1 || evt.altKey || this.spaceDown;
    // Locked: every gesture becomes a pan, so the board can still be read and
    // navigated but nothing on it can move. Enforced here rather than in each
    // handler, because one missed handler is a silently editable "locked" board.
    if (this.locked) wantPan = true;
    const handleEl = evt.target.closest ? evt.target.closest('.wire-handle') : null;
    const nubEl = evt.target.closest ? evt.target.closest('.wire-nub') : null;
    const point = this.docPoint(evt);

    if (nubEl && !wantPan) {
      const owner = nubEl.closest('.wire-el');
      const fromId = owner ? Number(owner.dataset.id) : 0;
      if (fromId) {
        this.drag = { mode: 'connect', from: fromId, start: this.centreOfId(fromId), to: point };
        this.showConnectPreview(this.drag.start, point);
        return;
      }
    }
    let box = evt.target.closest ? evt.target.closest('.wire-el') : null;
    if (!box && !handleEl) {
      const hit = this.elementAt(point);
      if (hit) box = this.els.get(hit.id) || null;
    }

    // drawing an arrow takes precedence over everything except panning
    if (this.connectMode && !wantPan) {
      const hit = this.elementAt(point);
      if (!hit) {
        // a miss used to cancel the whole mode, which felt like a bug
        this.connectFrom = null;
        this.hideConnectPreview();
        return;
      }
      if (this.connectFrom && this.connectFrom !== hit.id) {
        // second click completes it, so click-then-click works as well as drag
        this.addLink(this.connectFrom, hit.id);
        this.connectFrom = null;
        this.setConnectMode(false);
        return;
      }
      this.connectFrom = hit.id;
      this.drag = { mode: 'connect', from: hit.id, start: this.centreOfId(hit.id), to: point, viaMode: true };
      this.showConnectPreview(this.drag.start, point);
      return;
    }

    // clicking an arrow selects it. pointerdown still has a real evt.target, so
    // closest() works here, but fall back to the geometric test so a click just
    // beside the line lands the same way a double-click does.
    const linkEl = evt.target.closest ? evt.target.closest('.wire-link') : null;
    const linkHit = box ? null : (linkEl ? this.linkById(Number(linkEl.dataset.link)) : this.linkAt(point));
    if (linkHit) {
      this.sel = [];
      this.selLink = linkHit.id;
      this.renderSelection();
      this.renderLinkSelection();
      this.renderInspector();
      this.drag = null;
      return;
    }
    if (this.selLink && !linkHit) {
      this.selLink = null;
      this.renderLinkSelection();
      this.renderInspector();
    }

    try { this.stageEl.setPointerCapture(evt.pointerId); } catch (e) { /* noop */ }

    if (wantPan) {
      this.drag = { mode: 'pan', sx: evt.clientX, sy: evt.clientY, vx: this.doc.view.x, vy: this.doc.view.y };
      this.stageEl.classList.add('wire-panning');
      return;
    }

    if (handleEl && this.sel.length === 1) {
      const e = this.byId(this.sel[0]);
      if (!e) return;
      this.drag = {
        mode: 'resize', handle: handleEl.dataset.handle,
        start: this.docPoint(evt), before: { x: e.x, y: e.y, w: e.w, h: e.h }, id: e.id
      };
      return;
    }

    if (box) {
      const id = Number(box.dataset.id);
      if (evt.shiftKey) {
        const i = this.sel.indexOf(id);
        if (i >= 0) this.sel.splice(i, 1); else this.sel.push(id);
      } else if (this.sel.indexOf(id) < 0) {
        this.sel = [id];
      }
      this.renderSelection();
      this.renderInspector();
      const picked = this.selected();
      this.drag = {
        mode: 'move', start: this.docPoint(evt), moved: false,
        before: picked.map(function (e) { return { id: e.id, x: e.x, y: e.y }; })
      };
      return;
    }

    // empty canvas: marquee
    if (!evt.shiftKey) { this.sel = []; this.renderSelection(); this.renderInspector(); }
    this.drag = { mode: 'marquee', start: this.docPoint(evt), base: this.sel.slice() };
  }

  onMove(evt) {
    const d = this.drag;
    if (!d) return;

    if (d.mode === 'connect') {
      const p = this.docPoint(evt);
      d.to = p;
      const over = this.elementAt(p);
      d.overId = over && over.id !== d.from ? over.id : null;
      this.showConnectPreview(d.start, p, d.overId);
      return;
    }

    if (d.mode === 'pan') {
      this.doc.view.x = d.vx + (evt.clientX - d.sx);
      this.doc.view.y = d.vy + (evt.clientY - d.sy);
      this.applyView();
      return;
    }

    const p = this.docPoint(evt);

    if (d.mode === 'move') {
      let dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (!d.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      d.moved = true;

      // snap the whole selection's bounding box to the edges and centres of
      // everything else, and show the lines it snapped to
      const adj = this.alignSnap(d, dx, dy);
      dx = adj.dx; dy = adj.dy;
      this.showGuides(adj.guides);

      for (const b of d.before) {
        const e = this.byId(b.id);
        if (!e) continue;
        e.x = adj.snapped ? Math.round(b.x + dx) : this.snap(b.x + dx);
        e.y = adj.snapped ? Math.round(b.y + dy) : this.snap(b.y + dy);
        const box = this.els.get(b.id);
        if (box) { box.style.left = e.x + 'px'; box.style.top = e.y + 'px'; }
      }
      this.syncInspectorGeometry();
      return;
    }

    if (d.mode === 'resize') {
      const e = this.byId(d.id);
      if (!e) return;
      const b = d.before;
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      const h = d.handle;
      let x = b.x, y = b.y, w = b.w, hh = b.h;
      if (h.indexOf('e') >= 0) w = b.w + dx;
      if (h.indexOf('s') >= 0) hh = b.h + dy;
      if (h.indexOf('w') >= 0) { x = b.x + dx; w = b.w - dx; }
      if (h.indexOf('n') >= 0) { y = b.y + dy; hh = b.h - dy; }
      w = Math.max(24, this.snap(w));
      hh = Math.max(20, this.snap(hh));
      if (h.indexOf('w') >= 0) x = this.snap(b.x + b.w - w);
      if (h.indexOf('n') >= 0) y = this.snap(b.y + b.h - hh);
      e.x = x; e.y = y; e.w = w; e.h = hh;
      const box = this.els.get(e.id);
      if (box) {
        box.style.left = x + 'px'; box.style.top = y + 'px';
        box.style.width = w + 'px'; box.style.height = hh + 'px';
      }
      this.syncInspectorGeometry();
      return;
    }

    if (d.mode === 'marquee') {
      const v = this.doc.view;
      const x0 = Math.min(d.start.x, p.x), y0 = Math.min(d.start.y, p.y);
      const x1 = Math.max(d.start.x, p.x), y1 = Math.max(d.start.y, p.y);
      d.rect = { x0: x0, y0: y0, x1: x1, y1: y1 };
      this.marqueeEl.hidden = false;
      this.marqueeEl.style.left = (x0 * v.zoom + v.x) + 'px';
      this.marqueeEl.style.top = (y0 * v.zoom + v.y) + 'px';
      this.marqueeEl.style.width = ((x1 - x0) * v.zoom) + 'px';
      this.marqueeEl.style.height = ((y1 - y0) * v.zoom) + 'px';
    }
  }

  onUp(evt) {
    const d = this.drag;
    this.drag = null;
    this.stageEl.classList.remove('wire-panning');
    this.marqueeEl.hidden = true;
    this.hideGuides();
    try { this.stageEl.releasePointerCapture(evt.pointerId); } catch (e) { /* noop */ }
    if (!d) return;

    if (d.mode === 'connect') {
      this.hideConnectPreview();
      if (d.overId) {
        this.addLink(d.from, d.overId);
        this.connectFrom = null;
        this.setConnectMode(false);
        return;
      }
      // released on nothing: in click-to-connect mode keep the origin armed,
      // so the next click finishes the arrow
      if (!d.viaMode) this.connectFrom = null;
      return;
    }

    if (d.mode === 'pan') { this.requestSave(); return; }

    if (d.mode === 'marquee') {
      if (d.rect) {
        const r = d.rect;
        const hit = this.doc.elements.filter(function (e) {
          return e.x < r.x1 && e.x + e.w > r.x0 && e.y < r.y1 && e.y + e.h > r.y0;
        }).map(function (e) { return e.id; });
        const merged = d.base.slice();
        for (const id of hit) if (merged.indexOf(id) < 0) merged.push(id);
        this.sel = merged;
        this.renderSelection();
        this.renderInspector();
      }
      return;
    }

    if (d.mode === 'move' && !d.moved) { return; }   // a plain click, nothing to record
    this.commit();
  }

  /* Compare the dragged bounding box against every other element on both axes.
   * Snapping to a neighbour beats snapping to the grid, which is what makes
   * things line up instead of landing one grid step off. */
  alignSnap(d, dx, dy) {
    const TOL = 6;
    const moving = d.before.map((b) => b.id);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of d.before) {
      const e = this.byId(b.id);
      if (!e) continue;
      x0 = Math.min(x0, b.x + dx); y0 = Math.min(y0, b.y + dy);
      x1 = Math.max(x1, b.x + dx + e.w); y1 = Math.max(y1, b.y + dy + e.h);
    }
    if (!isFinite(x0)) return { dx: dx, dy: dy, guides: [], snapped: false };

    const mine = {
      x: [x0, (x0 + x1) / 2, x1],
      y: [y0, (y0 + y1) / 2, y1]
    };
    let bestX = null, bestY = null;
    for (const other of this.doc.elements) {
      if (moving.indexOf(other.id) >= 0) continue;
      const ox = [other.x, other.x + other.w / 2, other.x + other.w];
      const oy = [other.y, other.y + other.h / 2, other.y + other.h];
      for (const m of mine.x) {
        for (const o of ox) {
          const diff = o - m;
          if (Math.abs(diff) <= TOL && (!bestX || Math.abs(diff) < Math.abs(bestX.diff))) {
            bestX = { diff: diff, at: o };
          }
        }
      }
      for (const m of mine.y) {
        for (const o of oy) {
          const diff = o - m;
          if (Math.abs(diff) <= TOL && (!bestY || Math.abs(diff) < Math.abs(bestY.diff))) {
            bestY = { diff: diff, at: o };
          }
        }
      }
    }

    const guides = [];
    if (bestX) { dx += bestX.diff; guides.push({ axis: 'x', at: bestX.at }); }
    if (bestY) { dy += bestY.diff; guides.push({ axis: 'y', at: bestY.at }); }
    return { dx: dx, dy: dy, guides: guides, snapped: !!(bestX || bestY) };
  }

  showGuides(guides) {
    if (!this.guideEl) this.guideEl = this.stageEl.createDiv({ cls: 'wire-guides' });
    this.guideEl.empty();
    if (!guides || !guides.length) return;
    const v = this.doc.view;
    for (const g of guides) {
      const line = this.guideEl.createDiv({ cls: 'wire-guide wire-guide-' + g.axis });
      if (g.axis === 'x') line.style.left = (g.at * v.zoom + v.x) + 'px';
      else line.style.top = (g.at * v.zoom + v.y) + 'px';
    }
  }

  hideGuides() { if (this.guideEl) this.guideEl.empty(); }

  showConnectPreview(from, to, overId) {
    if (!this.previewEl) {
      this.previewEl = this.stageEl.createDiv({ cls: 'wire-preview' });
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('fill', 'none');
      this.previewEl.appendChild(svg);
      this.previewSvg = svg;
    }
    const r = this.stageEl.getBoundingClientRect();
    const v = this.doc.view;
    const sx = from.x * v.zoom + v.x, sy = from.y * v.zoom + v.y;
    const ex = to.x * v.zoom + v.x, ey = to.y * v.zoom + v.y;
    this.previewEl.hidden = false;
    this.previewEl.style.left = '0px';
    this.previewEl.style.top = '0px';
    this.previewSvg.setAttribute('width', String(Math.max(1, r.width)));
    this.previewSvg.setAttribute('height', String(Math.max(1, r.height)));
    while (this.previewSvg.firstChild) this.previewSvg.removeChild(this.previewSvg.firstChild);
    svgChild(this.previewSvg, 'line', {
      x1: sx, y1: sy, x2: ex, y2: ey,
      stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-dasharray': '5 4'
    });
    svgChild(this.previewSvg, 'circle', { cx: ex, cy: ey, r: 4, fill: 'currentColor' });
    this.previewEl.classList.toggle('wire-preview-ok', !!overId);
    for (const [id, boxEl] of this.els) boxEl.classList.toggle('wire-connect-target', id === overId);
  }

  hideConnectPreview() {
    if (this.previewEl) this.previewEl.hidden = true;
    for (const [, boxEl] of this.els) boxEl.classList.remove('wire-connect-target');
  }

  /* --- keyboard --- */

  installKeys() {
    this.registerDomEvent(this.stageEl, 'keydown', (evt) => {
      if (evt.key === 'Escape' && this.presenting) {
        evt.preventDefault();
        this.setPresenting(false);
        return;
      }
      if (evt.key === ' ') { this.spaceDown = true; this.stageEl.classList.add('wire-grab'); }
      const mod = evt.metaKey || evt.ctrlKey;

      // Anything with a modifier is registered as an Obsidian command instead.
      // A DOM listener here only fires when the canvas holds focus, which is why
      // Cmd+D appeared not to work; commands fire whenever the view is active
      // and users can rebind them in Settings -> Hotkeys.
      if (mod) return;
      if (evt.key === 'Delete' || evt.key === 'Backspace') {
        if (!this.sel.length && !this.selLink) return;
        evt.preventDefault(); this.deleteSelection(); return;
      }
      if (evt.key === 'Escape') {
        if (this.connectMode) { this.setConnectMode(false); return; }
        this.sel = []; this.selLink = null; this.renderAll(); return;
      }
      if (evt.key === 'c' && !mod && !evt.shiftKey) { this.setConnectMode(!this.connectMode); return; }
      if (evt.key === 'Enter' && this.sel.length === 1) {
        evt.preventDefault(); this.startEdit(this.sel[0]); return;
      }
      if (evt.key.indexOf('Arrow') === 0 && this.sel.length) {
        evt.preventDefault();
        const step = evt.shiftKey ? GRID * 2 : (this.grid ? GRID : 1);
        const dx = evt.key === 'ArrowLeft' ? -step : evt.key === 'ArrowRight' ? step : 0;
        const dy = evt.key === 'ArrowUp' ? -step : evt.key === 'ArrowDown' ? step : 0;
        for (const e of this.selected()) { e.x += dx; e.y += dy; }
        this.commit();
      }
    });
    this.registerDomEvent(this.stageEl, 'keyup', (evt) => {
      if (evt.key === ' ') { this.spaceDown = false; this.stageEl.classList.remove('wire-grab'); }
    });
  }

  selectAll() {
    this.sel = this.doc.elements.map(function (e) { return e.id; });
    this.selLink = null;
    this.renderSelection();
    this.renderInspector();
  }

  /* --- inline text editing: the text, never the code --- */

  startEdit(id) {
    if (this.locked) { new Notice('This board is locked. Unlock it to edit.'); return; }
    const elm = this.byId(id);
    if (!elm) return;
    if (this.editing) this.commitEdit();

    if (!hasEditableText(elm.type) && !isRowElement(elm)) {
      const def = WIDGETS[elm.type];
      this.sel = [id];
      this.renderAll();
      new Notice((def ? def.label : elm.type) +
        ' is a layout box — it has no text. Drop widgets on top of it instead.');
      return;
    }

    this.sel = [id];
    this.renderSelection();
    this.renderInspector();

    const box = this.els.get(id);
    if (!box) return;
    const rowMode = isRowElement(elm);
    const v = this.doc.view;

    const wrap = this.stageEl.createDiv({ cls: 'wire-edit' + (rowMode ? ' wire-edit-rows' : '') });
    wrap.style.left = (elm.x * v.zoom + v.x) + 'px';
    wrap.style.top = (elm.y * v.zoom + v.y) + 'px';
    wrap.style.width = Math.max(180, elm.w * v.zoom) + 'px';

    wrap.createDiv({
      cls: 'wire-edit-label',
      text: rowMode ? rowsLabel(elm.type) : valueLabel(elm.type)
    });
    const ta = wrap.createEl('textarea', { cls: 'wire-edit-field' });
    ta.value = rowMode ? elm.rows : elm.value;
    ta.rows = rowMode ? Math.max(3, Math.min(14, ta.value.split('\n').length + 1)) : 1;
    ta.spellcheck = false;

    const hint = wrap.createDiv({ cls: 'wire-edit-hint' });
    hint.setText(rowMode ? 'Esc to cancel · click away to keep' : 'Enter to keep · Esc to cancel');

    this.editing = { kind: 'element', id: id, rowMode: rowMode, wrap: wrap, ta: ta };

    ta.focus();
    ta.select();

    ta.addEventListener('keydown', (evt) => {
      evt.stopPropagation();
      if (evt.key === 'Escape') { evt.preventDefault(); this.cancelEdit(); return; }
      if (evt.key === 'Enter' && (!rowMode || evt.metaKey || evt.ctrlKey)) {
        evt.preventDefault(); this.commitEdit(); return;
      }
      if (evt.key === 'Tab') { evt.preventDefault(); this.commitEdit(); }
    });
    ta.addEventListener('input', () => {
      if (rowMode) ta.rows = Math.max(3, Math.min(14, ta.value.split('\n').length + 1));
      this.previewEdit();
    });
    ta.addEventListener('blur', () => { if (this.editing) this.commitEdit(); });
  }

  /* Double-clicking an arrow should do what double-clicking anything else does:
   * open the text, not a panel. The label sits on the curve, so the box opens
   * there rather than in the inspector across the room. */
  startEditLink(linkId) {
    if (this.locked) { new Notice('This board is locked. Unlock it to edit.'); return; }
    const link = this.linkById(linkId);
    if (!link) return;
    if (this.editing) this.commitEdit();

    const a = this.byId(link.from), b = this.byId(link.to);
    if (!a || !b) return;

    this.sel = [];
    this.selLink = linkId;
    this.renderAll();

    const g = linkGeometry(a, b);
    const v = this.doc.view;
    const W = 200;

    const wrap = this.stageEl.createDiv({ cls: 'wire-edit wire-edit-link' });
    // centred on the label point, so the box appears where the text will land
    wrap.style.left = (g.mid.x * v.zoom + v.x - W / 2) + 'px';
    wrap.style.top = (g.mid.y * v.zoom + v.y - 16) + 'px';
    wrap.style.width = W + 'px';

    // the same wording the inspector uses, because it is the same field
    wrap.createDiv({ cls: 'wire-edit-label', text: 'Label — what makes this transition happen' });
    const ta = wrap.createEl('textarea', { cls: 'wire-edit-field' });
    ta.value = link.label || '';
    ta.rows = 1;
    ta.spellcheck = false;
    ta.setAttribute('placeholder', 'e.g. sign in');

    wrap.createDiv({
      cls: 'wire-edit-hint',
      text: 'Enter to keep — Esc to cancel — empty removes the label'
    });

    this.editing = { kind: 'link', id: linkId, wrap: wrap, ta: ta };

    ta.focus();
    ta.select();

    ta.addEventListener('keydown', (evt) => {
      evt.stopPropagation();
      if (evt.key === 'Escape') { evt.preventDefault(); this.cancelEdit(); return; }
      if (evt.key === 'Enter') { evt.preventDefault(); this.commitEdit(); return; }
      if (evt.key === 'Tab') { evt.preventDefault(); this.commitEdit(); }
    });
    ta.addEventListener('input', () => this.previewEdit());
    ta.addEventListener('blur', () => { if (this.editing) this.commitEdit(); });
  }

  // live preview while typing, so it behaves like editing the thing itself
  previewEdit() {
    const ed = this.editing;
    if (!ed) return;
    if (ed.kind === 'link') {
      // redraw just the label, so the text lands on the curve as you type
      const host = this.surfaceEl.querySelector('.wire-link[data-link="' + ed.id + '"]');
      if (!host) return;
      const link = this.linkById(ed.id);
      const a = link ? this.byId(link.from) : null;
      const b = link ? this.byId(link.to) : null;
      if (!a || !b) return;
      const old = host.querySelector('.wire-link-label');
      if (old) old.remove();
      const text = ed.ta.value;
      if (!text) return;
      const g = linkGeometry(a, b);
      const x0 = parseFloat(host.style.left) || 0;
      const y0 = parseFloat(host.style.top) || 0;
      const lab = host.createDiv({ cls: 'wire-link-label', text: text });
      lab.style.left = (g.mid.x - x0) + 'px';
      lab.style.top = (g.mid.y - y0) + 'px';
      return;
    }
    const elm = this.byId(ed.id);
    const box = this.els.get(ed.id);
    if (!elm || !box) return;
    const probe = JSON.parse(JSON.stringify(elm));
    if (ed.rowMode) probe.rows = ed.ta.value; else probe.value = ed.ta.value;
    const inner = box.querySelector('.wire-el-inner');
    if (!inner) return;
    inner.empty();
    renderElementInto(inner, probe, this.skin());
  }

  commitEdit() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const next = ed.ta.value;
    if (ed.kind === 'link') {
      try { ed.wrap.remove(); } catch (e) { /* the view's DOM went away first */ }
      const link = this.linkById(ed.id);
      if (!link) return;
      // an empty label removes it rather than leaving an empty box on the curve
      const label = next.trim();
      const changed = (link.label || '') !== label;
      if (label) link.label = label; else delete link.label;
      if (changed) this.commit(); else this.renderAll();
      this.stageEl.focus();
      return;
    }
    const elm = this.byId(ed.id);
    try { ed.wrap.remove(); } catch (e) { /* the view's DOM went away first */ }
    if (!elm) return;
    const changed = ed.rowMode ? (elm.rows !== next) : (elm.value !== next);
    if (ed.rowMode) elm.rows = next; else elm.value = next;
    if (changed) this.commit(); else this.renderAll();
    this.stageEl.focus();
  }

  cancelEdit() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    try { ed.wrap.remove(); } catch (e) { /* the view's DOM went away first */ }
    this.renderAll();
    this.stageEl.focus();
  }

  /* --- inspector --- */

  syncInspectorGeometry() {
    if (!this.geomInputs) return;
    const e = this.sel.length === 1 ? this.byId(this.sel[0]) : null;
    if (!e) return;
    for (const k in this.geomInputs) {
      if (document.activeElement !== this.geomInputs[k]) this.geomInputs[k].value = String(e[k]);
    }
  }

  /* The other option is no permanent right-hand panel at all - properties
   * appear over the selection and vanish with it. This is the same idea within a
   * docked layout: an empty inspector is 236px of nothing, and the canvas is
   * what the person came for. */
  inspectorHasContent() {
    return !!(this.selLink || this.sel.length || this.showHelp);
  }

  syncInspectorVisibility() {
    const host = this.inspectorEl;
    if (!host) return;
    const show = this.inspectorHasContent() && !this.presenting;
    host.classList.toggle('wire-hidden', !show);
    if (this.helpBtn) {
      this.helpBtn.classList.toggle('wire-on', this.showHelp && !this.sel.length && !this.selLink);
      this.helpBtn.setAttribute('title',
        this.showHelp ? 'Hide the keyboard shortcuts' : 'Show the keyboard shortcuts');
      this.helpBtn.setAttribute('aria-label', 'Toggle the keyboard shortcuts');
    }
  }

  renderInspector() {
    const host = this.inspectorEl;
    if (!host || !host.isConnected) return;
    if (this.inspecting) { return; }
    this.inspecting = true;
    try { this.renderInspectorInner(host); this.syncInspectorVisibility(); }
    finally { this.inspecting = false; }
  }

  renderInspectorInner(host) {
    host.empty();
    this.geomInputs = null;

    if (this.selLink) {
      const link = this.linkById(this.selLink);
      if (link) {
        const a = this.byId(link.from), b = this.byId(link.to);
        host.createDiv({ cls: 'wire-ins-head', text: 'Arrow' });
        host.createDiv({
          cls: 'wire-ins-sub',
          text: (a ? (WIDGETS[a.type] ? WIDGETS[a.type].label : a.type) : '?') + '  →  ' +
                (b ? (WIDGETS[b.type] ? WIDGETS[b.type].label : b.type) : '?')
        });
        const f = host.createDiv({ cls: 'wire-ins-field' });
        f.createDiv({ cls: 'wire-ins-label', text: 'Label — what makes this transition happen' });
        const inp = f.createEl('input', { cls: 'wire-ins-linklabel', attr: { type: 'text', placeholder: 'e.g. sign in' } });
        inp.value = link.label;
        inp.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') { link.label = inp.value; this.commit(); }
        });
        inp.addEventListener('change', () => {
          if (link.label === inp.value) return;
          link.label = inp.value;
          this.commit();
        });

        const acts = host.createDiv({ cls: 'wire-ins-actions' });
        const flip = acts.createDiv({ cls: 'wire-ins-btn', text: 'Reverse' });
        flip.addEventListener('click', () => {
          const t = link.from; link.from = link.to; link.to = t; this.commit();
        });
        const del = acts.createDiv({ cls: 'wire-ins-btn wire-danger', text: 'Delete arrow' });
        del.addEventListener('click', () => this.deleteSelection());
        return;
      }
      this.selLink = null;
    }

    if (!this.sel.length) {
      // nothing selected: the panel is hidden entirely unless the shortcut list
      // was asked for, so there is nothing to draw
      if (!this.showHelp) return;
      const head = host.createDiv({ cls: 'wire-ins-headrow' });
      head.createDiv({ cls: 'wire-ins-head', text: 'Shortcuts' });
      const close = head.createDiv({ cls: 'wire-ins-close' });
      iconEl(close, 'close', 13);
      close.setAttribute('title', 'Hide the keyboard shortcuts');
      close.setAttribute('aria-label', 'Hide the keyboard shortcuts');
      close.addEventListener('click', () => this.setShowHelp(false));
      const tips = host.createDiv({ cls: 'wire-ins-tips' });
      const rows = [
        ['Double-click', 'edit its text'],
        ['Drag', 'move  ·  handles resize'],
        ['Shift-click', 'add to the selection'],
        ['Drag empty space', 'marquee select'],
        ['Space or Alt + drag', 'pan'],
        ['Cmd/Ctrl + scroll', 'zoom'],
        ['Cmd/Ctrl + C, V, X', 'copy, paste, cut'],
        ['Cmd/Ctrl + D', 'duplicate'],
        ['Cmd/Ctrl + Z', 'undo'],
        ['C', 'draw a connecting arrow'],
        ['Arrows', 'nudge  ·  Del removes']
      ];
      for (const [k, v] of rows) {
        const r = tips.createDiv({ cls: 'wire-ins-tip' });
        r.createSpan({ cls: 'wire-ins-key', text: k });
        r.createSpan({ text: v });
      }
      return;
    }

    if (this.sel.length > 1) {
      host.createDiv({ cls: 'wire-ins-head', text: this.sel.length + ' elements' });
      const g = host.createDiv({ cls: 'wire-ins-alignrow' });
      const mk = (label, how, title) => {
        const b = g.createDiv({ cls: 'wire-ins-align', text: label });
        b.setAttribute('title', title);
        b.addEventListener('click', () => this.align(how));
      };
      mk('⇤', 'left', 'Align left'); mk('⇔', 'hcentre', 'Centre horizontally'); mk('⇥', 'right', 'Align right');
      mk('⤒', 'top', 'Align top'); mk('⇕', 'vcentre', 'Centre vertically'); mk('⤓', 'bottom', 'Align bottom');
      return;
    }

    const e = this.byId(this.sel[0]);
    if (!e) return;
    const def = WIDGETS[e.type];

    host.createDiv({ cls: 'wire-ins-head', text: def ? def.label : e.type });
    host.createDiv({ cls: 'wire-ins-sub', text: e.type });

    // value
    const f1 = host.createDiv({ cls: 'wire-ins-field' });
    f1.createDiv({ cls: 'wire-ins-label', text: valueLabel(e.type) });
    const vi = f1.createEl('input', { attr: { type: 'text' } });
    vi.value = e.value;
    const applyValue = () => {
      if (e.value === vi.value) return;
      e.value = vi.value;
      this.commit();
    };
    vi.addEventListener('change', applyValue);
    vi.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') applyValue();
    });

    // rows
    if (isRowElement(e)) {
      const f2 = host.createDiv({ cls: 'wire-ins-field' });
      f2.createDiv({ cls: 'wire-ins-label', text: rowsLabel(e.type) });
      const ta = f2.createEl('textarea');
      ta.value = e.rows;
      ta.rows = Math.max(4, Math.min(12, e.rows.split('\n').length + 1));
      ta.spellcheck = false;
      ta.addEventListener('keydown', (ev) => ev.stopPropagation());
      ta.addEventListener('change', () => {
        if (e.rows === ta.value) return;
        e.rows = ta.value;
        this.commit();
      });
    }

    // state chips
    const mods = modsFor(e.type);
    if (mods.length) {
      const f3 = host.createDiv({ cls: 'wire-ins-field' });
      f3.createDiv({ cls: 'wire-ins-label', text: 'State' });
      const chips = f3.createDiv({ cls: 'wire-ins-chips' });
      for (const m of mods) {
        const on = e.mods.indexOf(m) >= 0;
        const chip = chips.createDiv({ cls: 'wire-ins-chip' + (on ? ' wire-on' : ''), text: m });
        chip.addEventListener('click', () => {
          const i = e.mods.indexOf(m);
          if (i >= 0) e.mods.splice(i, 1); else e.mods.push(m);
          this.commit();
        });
      }
    }

    // geometry
    const f4 = host.createDiv({ cls: 'wire-ins-field' });
    f4.createDiv({ cls: 'wire-ins-label', text: 'Position and size' });
    const grid = f4.createDiv({ cls: 'wire-ins-geom' });
    this.geomInputs = {};
    for (const k of ['x', 'y', 'w', 'h']) {
      const cell = grid.createDiv({ cls: 'wire-ins-geomcell' });
      cell.createSpan({ cls: 'wire-ins-geomkey', text: k.toUpperCase() });
      const inp = cell.createEl('input', { attr: { type: 'number' } });
      inp.value = String(e[k]);
      inp.addEventListener('keydown', (ev) => ev.stopPropagation());
      inp.addEventListener('change', () => {
        const n = Math.round(Number(inp.value));
        if (!isFinite(n)) return;
        const next = (k === 'w') ? Math.max(24, n) : (k === 'h') ? Math.max(20, n) : n;
        if (e[k] === next) return;
        e[k] = next;
        this.commit();
      });
      this.geomInputs[k] = inp;
    }

    const acts = host.createDiv({ cls: 'wire-ins-actions' });
    const act = (label, fn) => {
      const b = acts.createDiv({ cls: 'wire-ins-btn', text: label });
      b.addEventListener('click', fn);
    };
    act('Edit text', () => this.startEdit(e.id));
    act('Connect →', () => this.setConnectMode(true));
    act('Duplicate', () => this.duplicate());
    act('To front', () => this.reorder(1));
    act('To back', () => this.reorder(-1));
    const del = acts.createDiv({ cls: 'wire-ins-btn wire-danger', text: 'Delete' });
    del.addEventListener('click', () => this.deleteSelection());
  }
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

class WireframyPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.applyCssVars();

    // The core of the plugin: a wf code block renders as a wireframe.
    // This fires in reading view, live preview, AND inside Canvas text
    // nodes and Canvas file-node embeds, which is what makes masters work.
    this.registerMarkdownCodeBlockProcessor('wf', (source, el) => {
      el.addClass('wf-host');
      renderWireframe(el, source, this.settings);
    });

    this.registerView(VIEW_PALETTE, (leaf) => new PaletteView(leaf, this));

    // The standalone editor: .wire files open in it instead of as text.
    this.registerView(WIRE_VIEW, (leaf) => new WireEditorView(leaf, this));
    try {
      this.registerExtensions([WIRE_EXT], WIRE_VIEW);
    } catch (e) {
      new Notice("Another plugin already claims .wire files, so this editor can't open them. Disable that plugin to use it.");
    }

    // One click straight into a new wireframe. The Canvas-mode palette is still
    // available from the command palette, but it is no longer the way in.
    // The glyph is a drafting one, deliberately not Canvas's 'layout-dashboard':
    // two plugins wearing the same icon in one ribbon is a coin toss every time.
    this.addRibbonIcon('drafting-compass', 'New wireframe', () => this.newWireframe());

    this.addCommand({
      id: 'new-wireframe',
      name: 'New wireframe',
      callback: () => this.newWireframe()
    });

    this.addCommand({
      id: 'open-palette',
      name: 'Open wireframe palette',
      callback: () => this.openPalette()
    });

    this.addCommand({
      id: 'quick-add',
      name: 'Quick add widget',
      callback: () => new QuickAddModal(this.app, this).open()
    });

    this.addCommand({
      id: 'pick-icon',
      name: 'Insert icon',
      callback: () => new IconPickerModal(this.app, this).open()
    });

    this.addCommand({
      id: 'insert-starter',
      name: 'Insert starter wireframe',
      callback: () => new StarterModal(this.app, this).open()
    });

    for (const p of SCREEN_PRESETS) {
      this.addCommand({
        id: 'frame-' + p.id,
        name: 'New screen frame: ' + p.label + ' (' + p.width + '×' + p.height + ')',
        callback: () => this.insertScreenFrame(p.id)
      });
    }

    this.addCommand({
      id: 'save-as-master',
      name: 'Save selected node as master',
      callback: () => this.saveSelectionAsMaster()
    });

    this.addCommand({
      id: 'insert-master',
      name: 'Insert master',
      callback: () => this.pickMaster()
    });

    this.addCommand({
      id: 'rebuild-catalog',
      name: 'Rebuild element catalog',
      callback: () => this.writeCatalog()
    });

    this.registerEditorCommands();

    this.addCommand({
      id: 'cycle-skin',
      name: 'Cycle skin (sketch / clean / wire)',
      callback: async () => {
        const order = ['sketch', 'clean', 'wire'];
        const i = order.indexOf(this.settings.skin);
        this.settings.skin = order[(i + 1) % order.length];
        await this.saveSettings();
        this.refreshAll();
        new Notice('Wireframe skin: ' + this.settings.skin);
      }
    });

    this.installDropHandlers();
    this.addSettingTab(new WireframeSettingTab(this.app, this));
  }

  onunload() {
    if (this.styleEl) this.styleEl.remove();
    clearDropHints(this.app.workspace.containerEl);
    DRAG_PAYLOAD = null;
  }

  /* Capture phase, so we settle the drop before Canvas's own handler turns it
   * into a plain text card. Both listeners bail immediately when nothing of
   * ours is being dragged, so normal Canvas drops are untouched. */
  installDropHandlers() {
    const onDragOver = (evt) => {
      if (!DRAG_PAYLOAD) return;
      const wrapper = evt.target && evt.target.closest ? evt.target.closest('.canvas-wrapper') : null;
      if (!wrapper) { clearDropHints(this.app.workspace.containerEl); return; }

      evt.preventDefault();
      try { evt.dataTransfer.dropEffect = 'copy'; } catch (e) { /* noop */ }
      wrapper.classList.add('wf-drop-armed');

      // highlight the wireframe a drop would join, if any
      const view = canvasViewFor(this.app, wrapper);
      const canvas = view && view.canvas;
      if (!canvas || DRAG_PAYLOAD.frame) return;
      const hit = wfNodeAt(canvas, canvasPosFromEvent(canvas, evt));
      const el = hit && hit.nodeEl ? hit.nodeEl : null;
      if (this.hintEl && this.hintEl !== el) this.hintEl.classList.remove('wf-drop-target');
      this.hintEl = el;
      if (el) el.classList.add('wf-drop-target');
    };

    const onDrop = (evt) => {
      if (!DRAG_PAYLOAD) return;
      const wrapper = evt.target && evt.target.closest ? evt.target.closest('.canvas-wrapper') : null;
      if (!wrapper) { endDrag(); return; }

      const view = canvasViewFor(this.app, wrapper);
      const canvas = view && view.canvas;
      const payload = DRAG_PAYLOAD;
      endDrag();
      if (!canvas) return;

      evt.preventDefault();
      evt.stopPropagation();

      const pos = canvasPosFromEvent(canvas, evt);
      if (payload.frame) {
        this.insertScreenFrame(payload.frame, canvas, pos);
        return;
      }
      this.placeWidget(canvas, payload, pos, wfNodeAt(canvas, pos));
    };

    document.addEventListener('dragover', onDragOver, true);
    document.addEventListener('drop', onDrop, true);
    this.register(() => document.removeEventListener('dragover', onDragOver, true));
    this.register(() => document.removeEventListener('drop', onDrop, true));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  applyCssVars() {
    if (!this.styleEl) {
      this.styleEl = document.createElement('style');
      this.styleEl.id = 'wireframy-vars';
      document.head.appendChild(this.styleEl);
    }
    this.styleEl.textContent = ':root { --wf-pad: ' + this.settings.nodePadding + 'px; }';
  }

  // Skin is baked into the rendered root, so swap it in place rather than
  // forcing every note and canvas to re-render.
  refreshAll() {
    const scope = this.app.workspace.containerEl || document.body;
    const roots = scope.querySelectorAll('.wf-root');
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      r.classList.remove('wf-skin-sketch', 'wf-skin-clean', 'wf-skin-wire');
      r.classList.add('wf-skin-' + this.settings.skin);
    }
  }

  /* Creates an empty .wire next to the demo folder and opens the editor. */
  async newWireframe() {
    const folder = normalizePath(String(this.settings.mastersFolder || 'Wireframes/Masters'));
    const parent = folder.indexOf('/') >= 0 ? folder.slice(0, folder.lastIndexOf('/')) : folder;
    const dir = parent || 'Wireframes';
    await this.ensureFolder(dir);

    let name = 'Wireframe';
    let path = dir + '/' + name + '.' + WIRE_EXT;
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      name = 'Wireframe ' + n++;
      path = dir + '/' + name + '.' + WIRE_EXT;
      if (n > 500) break;
    }

    const seed = emptyDoc();
    seed.view = { x: 60, y: 50, zoom: 1 };
    const winDef = WIDGETS['window'];
    if (winDef) {
      const frame = elementFromDef(winDef, seed.nextId++, 0, 0);
      frame.w = 900; frame.h = 600;
      seed.elements.push(frame);
    }

    try {
      const file = await this.app.vault.create(path, serializeDoc(seed));
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(file);
      new Notice('New wireframe: ' + name + '. Rename it in the file explorer whenever you like.');
    } catch (e) {
      new Notice('Could not create the wireframe: ' + e.message);
    }
  }

  /* Job B8. The vault copy is the guaranteed outcome; the clipboard is a bonus,
   * because a clipboard write can be refused and failing silently would be
   * worse than not offering it. */
  async exportBoardImage(view) {
    if (!view) return;
    const doc = view.doc;
    if (!doc || !doc.elements || !doc.elements.length) {
      new Notice('Nothing on the board to export yet.');
      return;
    }
    new Notice('Rendering the board' + '\u2026');
    let dataUrl = null;
    try { dataUrl = await view.boardImage(2); }
    catch (e) { dataUrl = null; }
    if (!dataUrl) {
      new Notice('Could not render the board to an image on this platform.');
      return;
    }

    const bytes = dataUrlToBytes(dataUrl);
    if (!bytes) { new Notice('Could not read the rendered image.'); return; }

    const base = view.file ? view.file.basename : 'Wireframe';
    const dir = view.file && view.file.parent && view.file.parent.path &&
      view.file.parent.path !== '/' ? view.file.parent.path + '/' : '';
    const name = imageNameFor(base, (n) => !!this.app.vault.getAbstractFileByPath(dir + n));

    let clipped = false;
    try {
      if (navigator.clipboard && typeof window.ClipboardItem === 'function') {
        const blob = new Blob([bytes], { type: 'image/png' });
        await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
        clipped = true;
      }
    } catch (e) { clipped = false; }

    try {
      await this.app.vault.createBinary(dir + name, bytes.buffer);
      new Notice(clipped
        ? 'Copied to the clipboard, and saved as ' + name + '. Paste it straight into Slack.'
        : 'Saved as ' + name + ', beside the board. Drag it wherever you need it.');
    } catch (e) {
      new Notice(clipped
        ? 'Copied to the clipboard, but could not save the file: ' + e.message
        : 'Could not save the image: ' + e.message);
    }
  }

  /* Job B3: explore a second idea without abandoning the first. "Another take
   * on this" is a different act from "a copy of this"; here the
   * naming carries that, so the relationship survives in the file list. */
  async duplicateAsAlternative(view) {
    const file = view && view.file;
    if (!file) { new Notice('Save this wireframe first, then make an alternative.'); return; }
    const dir = file.parent && file.parent.path && file.parent.path !== '/' ? file.parent.path + '/' : '';
    const stem = file.basename.replace(/ \(alt(?: \d+)?\)$/, '');
    let name = stem + ' (alt)';
    let path = dir + name + '.' + WIRE_EXT;
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      name = stem + ' (alt ' + n++ + ')';
      path = dir + name + '.' + WIRE_EXT;
      if (n > 200) break;
    }
    try {
      const made = await this.app.vault.create(path, view.getViewData());
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(made);
      new Notice('Alternative created: ' + name + '. The original is untouched.');
    } catch (e) {
      new Notice('Could not create the alternative: ' + e.message);
    }
  }

  /* Jobs B10 and C7: keep the reasoning with the drawing, and give a board an
   * exit into prose. A sibling note is the Obsidian-native answer - it gets
   * search, backlinks and the graph for free, which a notes field inside the
   * .wire file would not. */
  notePathFor(file) {
    const dir = file.parent && file.parent.path && file.parent.path !== '/' ? file.parent.path + '/' : '';
    return dir + file.basename + '.md';
  }

  async openBoardNotes(view) {
    const file = view && view.file;
    if (!file) { new Notice('Save this wireframe first, then add notes to it.'); return; }
    const path = this.notePathFor(file);
    let note = this.app.vault.getAbstractFileByPath(path);
    let made = false;
    if (!note) {
      const doc = parseDoc(view.getViewData());
      try {
        note = await this.app.vault.create(path, boardNotesTemplate(file.basename, doc));
        made = true;
      } catch (e) {
        new Notice('Could not create the notes: ' + e.message);
        return;
      }
    }
    const leaf = this.app.workspace.getLeaf('split');
    await leaf.openFile(note);
    new Notice(made
      ? 'Notes created beside the board. Open questions are listed from its sticky notes.'
      : 'Opened the notes for ' + file.basename + '.');
  }

  async openPalette() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_PALETTE);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_PALETTE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  requireCanvas() {
    const canvas = getCanvas(this.app);
    if (!canvas) {
      new Notice('Open a Canvas first — this inserts nodes into the active canvas.');
      return null;
    }
    return canvas;
  }

  /* One placement path, shared by clicking a palette card and dropping one.
   *
   *   target node given (a drop landed on a wireframe) -> append into it
   *   no target, something selected                    -> append into that
   *   otherwise                                        -> new node at `pos`
   */
  placeWidget(canvas, payload, pos, targetNode) {
    const label = (payload.label || 'widget').toLowerCase();

    let node = targetNode || null;
    if (!node && !pos) {
      const sel = selectedNodes(canvas).filter(nodeHasWf);
      if (sel.length === 1) node = sel[0];
    }

    if (node) {
      const updated = appendToWfBlock(nodeText(node), payload.snippet);
      if (updated && setNodeText(node, updated)) {
        try { canvas.requestSave(); } catch (e) { /* noop */ }
        new Notice('Added ' + label + ' to that screen');
        return true;
      }
      new Notice('Could not edit that node. Added a new one instead.');
    }

    try {
      addTextNode(canvas, fence(payload.snippet), payload.size, pos || null);
      return true;
    } catch (e) {
      new Notice('Could not insert: ' + e.message);
      return false;
    }
  }

  insertWidget(def) {
    const canvas = this.requireCanvas();
    if (!canvas) return;
    this.placeWidget(canvas, { snippet: def.snippet, size: def.size, label: def.label }, null, null);
  }

  insertIcon(name) {
    const def = WIDGETS['icon'];
    this.insertWidget({
      name: 'icon', label: 'icon ' + name, group: 'Action',
      snippet: 'icon: ' + name, size: def ? def.size : [80, 80], aliases: []
    });
  }

  insertStarter(key) {
    const canvas = this.requireCanvas();
    if (!canvas) return;
    const s = STARTERS[key];
    if (!s) return;
    try {
      addTextNode(canvas, fence(s.body), s.size);
    } catch (e) {
      new Notice('Could not insert: ' + e.message);
    }
  }

  insertScreenFrame(presetId, canvasArg, pos) {
    const canvas = canvasArg || this.requireCanvas();
    if (!canvas) return;
    const p = SCREEN_PRESETS.filter(function (x) { return x.id === presetId; })[0] || SCREEN_PRESETS[0];
    try {
      addGroupNode(canvas, p.label + ' — ' + p.width + '×' + p.height, [p.width, p.height], pos || null);
      new Notice('Screen frame added. Drop wireframes inside it; the group moves as one.');
    } catch (e) {
      new Notice('Could not add frame: ' + e.message);
    }
  }

  /* The active wireframe editor, or null. Commands use this so they stay out of
   * the way everywhere else in the app. */
  activeWireView() {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const view = leaf && leaf.view;
    return (view && view instanceof WireEditorView) ? view : null;
  }

  /* One helper so every editor command is scoped the same way: checkCallback
   * returns false when no wireframe is open, which lets a binding like Mod+A
   * fall through to its normal meaning everywhere else. */
  wireCommand(id, name, fn, hotkeys) {
    this.addCommand({
      id: id,
      name: name,
      hotkeys: hotkeys || [],
      checkCallback: (checking) => {
        const view = this.activeWireView();
        if (!view) return false;
        if (checking) return true;
        fn(view);
        return true;
      }
    });
  }

  registerEditorCommands() {
    const mod = (key, extra) => [{ modifiers: extra ? ['Mod'].concat(extra) : ['Mod'], key: key }];

    this.wireCommand('wire-duplicate', 'Wireframe: duplicate selection',
      (v) => v.duplicate(), mod('D'));
    // No default binding for these three: Cmd+C/X/V already reach the editor as
    // clipboard events, and claiming them app-wide would be rude. They are here
    // so they are discoverable and rebindable.
    this.wireCommand('wire-copy', 'Wireframe: copy selection', (v) => {
      if (!v.copySelection()) new Notice('Nothing selected — click an element first, then copy.');
    });
    this.wireCommand('wire-cut', 'Wireframe: cut selection', (v) => {
      if (!v.cutSelection()) new Notice('Nothing selected — click an element first, then cut.');
    });
    this.wireCommand('wire-paste', 'Wireframe: paste', (v) => {
      if (!v.pasteClip(null)) new Notice('Nothing on the wireframe clipboard yet.');
    });
    this.wireCommand('wire-delete', 'Wireframe: delete selection', (v) => v.deleteSelection());
    this.wireCommand('wire-select-all', 'Wireframe: select all', (v) => v.selectAll(), mod('A'));
    this.wireCommand('wire-undo', 'Wireframe: undo', (v) => v.undo(), mod('Z'));
    this.wireCommand('wire-redo', 'Wireframe: redo', (v) => v.redo(), mod('Z', ['Shift']));
    this.wireCommand('wire-front', 'Wireframe: bring to front', (v) => v.reorder(1), mod(']'));
    this.wireCommand('wire-back', 'Wireframe: send to back', (v) => v.reorder(-1), mod('['));
    this.wireCommand('wire-transform', 'Wireframe: transform to' + '…',
      (v) => v.openTransform(), mod('T', ['Alt']));
    this.wireCommand('wire-connect', 'Wireframe: connect two elements',
      (v) => v.setConnectMode(!v.connectMode));
    this.wireCommand('wire-edit-text', 'Wireframe: edit the text of the selection', (v) => {
      if (v.selLink) v.startEditLink(v.selLink);
      else if (v.sel.length === 1) v.startEdit(v.sel[0]);
      else new Notice('Select exactly one element or arrow first.');
    });
    this.wireCommand('wire-zoom-in', 'Wireframe: zoom in', (v) => v.zoomBy(1.2));
    this.wireCommand('wire-zoom-out', 'Wireframe: zoom out', (v) => v.zoomBy(1 / 1.2));
    this.wireCommand('wire-zoom-reset', 'Wireframe: zoom to 100%', (v) => v.setZoom(1));
    this.wireCommand('wire-zoom-fit', 'Wireframe: fit everything', (v) => v.zoomToFit());
    this.wireCommand('wire-toggle-grid', 'Wireframe: toggle the snap grid', (v) => {
      if (v.gridBtn) v.gridBtn.click();
    });
    this.wireCommand('wire-export-image', 'Wireframe: copy this board as an image',
      (v) => { this.exportBoardImage(v); }, mod('C', ['Shift']));
    this.wireCommand('wire-present', 'Wireframe: present this board',
      (v) => v.setPresenting(!v.presenting), mod('F', ['Shift']));
    this.wireCommand('wire-lock', 'Wireframe: lock this board',
      (v) => v.setLocked(!v.locked));
    this.wireCommand('wire-alternative', 'Wireframe: create an alternate version',
      (v) => { this.duplicateAsAlternative(v); });
    this.wireCommand('wire-notes', 'Wireframe: write board notes',
      (v) => { this.openBoardNotes(v); });
    this.wireCommand('wire-cycle-skin', 'Wireframe: cycle skin', (v) => {
      const order = ['sketch', 'clean', 'wire'];
      v.doc.skin = order[(order.indexOf(v.skin()) + 1) % order.length];
      v.commit();
    });
  }

  catalogPath() {
    const folder = normalizePath(String(this.settings.mastersFolder || 'Wireframes/Masters'));
    const parent = folder.indexOf('/') >= 0 ? folder.slice(0, folder.lastIndexOf('/')) : folder;
    return (parent || 'Wireframes') + '/Element catalog.md';
  }

  async writeCatalog() {
    const path = this.catalogPath();
    const body = buildCatalogMarkdown();
    try {
      await this.ensureFolder(path.slice(0, path.lastIndexOf('/')));
      const existing = this.app.vault.getAbstractFileByPath(path);
      let file;
      if (existing) {
        await this.app.vault.modify(existing, body);
        file = existing;
      } else {
        file = await this.app.vault.create(path, body);
      }
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(file);
      new Notice('Element catalog written to ' + path);
    } catch (e) {
      new Notice('Could not write the catalog: ' + e.message);
    }
  }

  /* Anything the user typed into settings is normalised before it touches the
   * vault: Obsidian's review guidelines require it, and a stray leading slash
   * or backslash otherwise produces a folder nobody asked for. */
  async ensureFolder(rawPath) {
    const path = normalizePath(String(rawPath || ''));
    const parts = path.split('/').filter(Boolean);
    let cur = '';
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      const existing = this.app.vault.getAbstractFileByPath(cur);
      if (!existing) {
        try { await this.app.vault.createFolder(cur); } catch (e) { /* race or exists */ }
      }
    }
  }

  saveSelectionAsMaster() {
    const canvas = this.requireCanvas();
    if (!canvas) return;
    const sel = selectedNodes(canvas).filter(nodeHasWf);
    if (sel.length !== 1) {
      new Notice('Select exactly one wireframe node to turn into a master.');
      return;
    }
    const node = sel[0];
    if (!nodeText(node)) {
      new Notice("That node isn't a wireframe — it has no wf block.");
      return;
    }
    new TextPromptModal(this.app, {
      title: 'Save as master',
      description: 'A master is a note holding this wireframe. Every place you insert it stays in sync with the note.',
      placeholder: 'App header',
      value: 'Header',
      cta: 'Create master',
      onSubmit: (name) => { if (name) this.writeMaster(canvas, node, name); }
    }).open();
  }

  async writeMaster(canvas, node, name) {
    const text = nodeText(node);
    if (!text) return;
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '-').trim();
    if (!safe) { new Notice("That name can't be used for a file — try one without / : | # ^ [ ] characters."); return; }

    await this.ensureFolder(this.settings.mastersFolder);
    const path = this.settings.mastersFolder + '/' + safe + '.md';
    let file = this.app.vault.getAbstractFileByPath(path);
    try {
      if (!file) file = await this.app.vault.create(path, text + '\n');
      else new Notice('Reusing the existing master note ' + safe);
    } catch (e) {
      new Notice('Could not create the master: ' + e.message);
      return;
    }

    let w = 400, h = 200, pos = null;
    try {
      w = node.width || w;
      h = node.height || h;
      pos = { x: (node.x || 0) + w / 2, y: (node.y || 0) + h / 2 };
    } catch (e) { /* fall back to the viewport centre */ }

    try {
      addFileNode(canvas, file, [w, h], pos);
      if (typeof canvas.removeNode === 'function') canvas.removeNode(node);
      try { canvas.requestSave(); } catch (e) { /* noop */ }
      new Notice('Master saved to ' + path + '. Edit that note and every instance updates.');
    } catch (e) {
      new Notice('Master note created at ' + path + ', but swapping the node failed: ' + e.message);
    }
  }

  pickMaster() {
    const canvas = this.requireCanvas();
    if (!canvas) return;
    const folder = this.settings.mastersFolder.replace(/\/+$/, '');
    const files = this.app.vault.getMarkdownFiles().filter(function (f) {
      return f.path.indexOf(folder + '/') === 0;
    });
    if (!files.length) {
      new Notice('No masters in ' + folder + ' yet. Use "Save selected node as master" first.');
      return;
    }
    new MasterPickerModal(this.app, this, files).open();
  }

  insertMaster(file) {
    const canvas = this.requireCanvas();
    if (!canvas) return;
    try {
      addFileNode(canvas, file, [420, 220]);
    } catch (e) {
      new Notice('Could not insert master: ' + e.message);
    }
  }
}

module.exports = WireframyPlugin;

/* Exported for the test harness only; harmless in Obsidian. */
module.exports.__internals = {
  parseWf: parseWf,
  renderWireframe: renderWireframe,
  WIDGETS: WIDGETS,
  STARTERS: STARTERS,
  splitMods: splitMods,
  splitItems: splitItems,
  checkState: checkState,
  SCREEN_PRESETS: SCREEN_PRESETS,
  appendToWfBlock: appendToWfBlock,
  chooseIndent: chooseIndent,
  reindentSnippet: reindentSnippet,
  isContainerLine: isContainerLine,
  flatRows: flatRows,
  renderThumb: renderThumb,
  PaletteView: PaletteView,
  VIEW_PALETTE: VIEW_PALETTE,
  iconNames: iconNames,
  iconsMatching: iconsMatching,
  iconEl: iconEl,
  ICON_SPECS: ICON_SPECS,
  ICON_ALIASES: ICON_ALIASES,
  resolveIconName: resolveIconName,
  ICON_ALIASES_BY_TARGET: ICON_ALIASES_BY_TARGET,
  wfNodeAt: wfNodeAt,
  makeDraggable: makeDraggable,
  dragPayload: function () { return DRAG_PAYLOAD; },
  buildCatalogMarkdown: buildCatalogMarkdown,
  catalogGroups: catalogGroups,
  paletteGroups: paletteGroups,
  GROUP_ORDER: GROUP_ORDER,
  ESSENTIALS: ESSENTIALS,
  emptyDoc: emptyDoc,
  parseDoc: parseDoc,
  serializeDoc: serializeDoc,
  normaliseElement: normaliseElement,
  elementDsl: elementDsl,
  elementNode: elementNode,
  elementFromDef: elementFromDef,
  renderElementInto: renderElementInto,
  isRowElement: isRowElement,
  transformElement: transformElement,
  exportCss: exportCss,
  collectPluginCss: collectPluginCss,
  boardBounds: boardBounds,
  imageNameFor: imageNameFor,
  dataUrlToBytes: dataUrlToBytes,
  boardNotesTemplate: boardNotesTemplate,
  ANNOTATION_TYPES: ANNOTATION_TYPES,
  transformSummary: transformSummary,
  TransformModal: TransformModal,
  modsFor: modsFor,
  hasEditableText: hasEditableText,
  valueLabel: valueLabel,
  VALUE_LABEL: VALUE_LABEL,
  ROWS_LABEL: ROWS_LABEL,
  rowsLabel: rowsLabel,
  WireEditorView: WireEditorView,
  WIRE_VIEW: WIRE_VIEW,
  WIRE_EXT: WIRE_EXT,
  GRID: GRID,
  HANDLES: HANDLES,
  linkGeometry: linkGeometry,
  bezierAt: bezierAt,
  bezierPath: bezierPath,
  ROWS_WIDGETS: ROWS_WIDGETS,
  defTakesRows: defTakesRows,
  WIRE_CLIP_KIND: WIRE_CLIP_KIND
};
