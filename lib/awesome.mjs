import { runCmd } from './spawn.mjs';

export function parseAwesomeOutput(stdout) {
  const text = String(stdout || '');
  const kind = /^\s*(string|double|boolean|integer)\b/.exec(text);
  if (!kind) return text.trim();
  const rest = text.slice(kind.index + kind[0].length).trim();
  if (kind[1] === 'boolean') return rest === 'true';
  if (kind[1] === 'double' || kind[1] === 'integer') return Number(rest);
  const start = rest.indexOf('"');
  const end = rest.lastIndexOf('"');
  if (start >= 0 && end > start) {
    return rest.slice(start + 1, end).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return rest;
}

export function createAwesome(run = runCmd) {
  const lua = async (code) => {
    const res = await run('awesome-client', [code]);
    if (!res.ok) throw new Error(`awesome-client failed: ${res.out || 'no output'}`);
    return parseAwesomeOutput(res.stdout ?? res.out);
  };

  const screens = async () => {
    const raw = await lua(`local t={}
for s in screen do
  table.insert(t, string.format("%d\\t%d\\t%d\\t%d\\t%d\\t%d\\t%d\\t%d\\t%d",
    s.index, s.geometry.x, s.geometry.y, s.geometry.width, s.geometry.height,
    s.workarea.x, s.workarea.y, s.workarea.width, s.workarea.height))
end
return table.concat(t, "\\n")`);
    return String(raw || '').split('\n').filter(Boolean).map((line) => {
      const [index, x, y, w, h, wx, wy, ww, wh] = line.split('\t').map(Number);
      return { index, x, y, width: w, height: h, workarea: { x: wx, y: wy, width: ww, height: wh } };
    });
  };

  const parseWindows = (raw) => String(raw || '').split('\n').filter(Boolean).map((line) => {
    const [cls, instance, name, x, y, w, h, screen, fs, win, focused] = line.split('\t');
    return {
      class: cls || '', instance: instance || '', title: name || '',
      x: Number(x), y: Number(y), width: Number(w), height: Number(h),
      screen: Number(screen), fullscreen: fs === 'true',
      windowId: Number(win), focused: focused === 'true',
    };
  });

  const list = async () => {
    const raw = await lua(`local focus = client.focus
local t={}
for _, c in ipairs(client.get()) do
  table.insert(t, string.format("%s\\t%s\\t%s\\t%d\\t%d\\t%d\\t%d\\t%d\\t%s\\t%d\\t%s",
    (c.class or ""):gsub("[\\t\\n]"," "),
    (c.instance or ""):gsub("[\\t\\n]"," "),
    (c.name or ""):gsub("[\\t\\n]"," "):sub(1,160),
    c.x, c.y, c.width, c.height, c.screen.index, tostring(c.fullscreen), c.window,
    tostring(c == focus)))
end
return table.concat(t, "\\n")`);
    return parseWindows(raw);
  };

  const match = (wins, sel = {}) => {
    let found = wins;
    if (sel.windowId != null) found = found.filter((w) => w.windowId === Number(sel.windowId));
    if (sel.class) {
      const c = String(sel.class).toLowerCase();
      found = found.filter((w) => w.class.toLowerCase() === c || w.class.toLowerCase().includes(c));
    }
    if (sel.title) {
      const t = String(sel.title).toLowerCase();
      found = found.filter((w) => w.title.toLowerCase().includes(t));
    }
    if (sel.focused === true) found = found.filter((w) => w.focused);
    return found;
  };

  const one = async (sel = {}) => {
    const wins = match(await list(), sel);
    if (wins.length === 1) return wins[0];
    if (!sel.windowId && !sel.class && !sel.title && sel.focused !== false) {
      const focus = wins.filter((w) => w.focused);
      if (focus.length === 1) return focus[0];
    }
    if (!wins.length) throw new Error('No matching window. Use window_list, then pass class=zen or windowId.');
    throw new Error(`Ambiguous window (${wins.length} matches). Pass windowId. Candidates: ${wins.slice(0, 8).map((w) => `${w.windowId}:${w.class}:${w.title.slice(0, 40)}`).join('; ')}`);
  };

  const apply = async (windowId, body) => {
    const id = Number(windowId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('windowId must be a positive integer');
    const raw = await lua(`for _, c in ipairs(client.get()) do
  if c.window == ${id} then
    ${body}
    return string.format("%s\\t%s\\t%s\\t%d\\t%d\\t%d\\t%d\\t%d\\t%s\\t%d\\t%s",
      (c.class or ""):gsub("[\\t\\n]"," "), (c.instance or ""):gsub("[\\t\\n]"," "),
      (c.name or ""):gsub("[\\t\\n]"," "):sub(1,160),
      c.x, c.y, c.width, c.height, c.screen.index, tostring(c.fullscreen), c.window,
      tostring(c == client.focus))
  end
end
return ""`);
    const [win] = parseWindows(raw);
    if (!win) throw new Error(`Window ${id} not found in AwesomeWM`);
    return win;
  };

  return { lua, screens, list, match, one, apply };
}
