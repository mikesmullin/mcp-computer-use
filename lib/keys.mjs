const aliases={enter:'Return',return:'Return',esc:'Escape',escape:'Escape',tab:'Tab',backspace:'BackSpace',delete:'Delete',space:'space',home:'Home',end:'End',left:'Left',right:'Right',up:'Up',down:'Down',pageup:'Page_Up',pagedown:'Page_Down'};
export function normalizeKey(value) {
  if(typeof value!=='string')throw new Error('keys must be one chord, for example Ctrl+t or Enter');
  const parts=value.split('+');
  if(parts.length>5||parts.some(x=>!x))throw new Error('Use one keyboard chord at a time');
  const modifiers=parts.slice(0,-1).map(x=>x.toLowerCase());
  if(modifiers.some(x=>!['ctrl','alt','shift','super'].includes(x))||new Set(modifiers).size!==modifiers.length)throw new Error('Modifiers: Ctrl, Alt, Shift, Super');
  const last=parts.at(-1).toLowerCase();
  const key=aliases[last]||(/^[a-z0-9]$/.test(last)?last:/^f([1-9]|1[0-2])$/.test(last)?last.toUpperCase():null);
  if(!key)throw new Error('Unsupported key. Use a letter/digit, Enter, Tab, Escape, arrows, editing keys, or F1–F12.');
  return [...modifiers,key].join('+');
}
