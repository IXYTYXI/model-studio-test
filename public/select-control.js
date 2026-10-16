let dismissActive = () => {};

export function closeSelect() { dismissActive(); }

// Keep the submitted value separate from presentation, including fixed protocols.
export function selectControl({ id, name, value, options, labelId }) {
  const root = document.createElement('div');
  root.className = 'select-control';
  const input = document.createElement('input');
  input.type = 'hidden'; input.name = name;
  let selected = Math.max(0, options.findIndex(([key]) => key === value));
  input.value = options[selected][0];
  root.append(input);
  if (options.length === 1) {
    const display = document.createElement('input');
    display.id = id; display.className = 'fixed-control'; display.readOnly = true;
    display.value = options[0][1];
    display.setAttribute('aria-describedby', `${id}-note`);
    const note = document.createElement('span');
    note.id = `${id}-note`; note.className = 'fixed-control-note'; note.textContent = '固定协议';
    root.append(display, note);
    return root;
  }

  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.id = id; trigger.className = 'select-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-labelledby', labelId);
  const text = document.createElement('span');
  text.textContent = options[selected][1];
  const chevron = document.createElement('span');
  chevron.className = 'select-chevron'; chevron.setAttribute('aria-hidden', 'true');
  trigger.append(text, chevron); root.append(trigger);
  let menu, active = selected, listeners;

  function close() {
    if (!menu) return;
    listeners.abort(); menu.remove(); menu = null;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    trigger.removeAttribute('aria-controls');
    dismissActive = () => {};
  }
  function highlight(index) {
    active = index;
    [...menu.children].forEach((item, i) => item.classList.toggle('highlighted', i === active));
    trigger.setAttribute('aria-activedescendant', menu.children[active].id);
    menu.children[active].scrollIntoView({ block: 'nearest' });
  }
  function choose(index) {
    selected = index; input.value = options[index][0]; text.textContent = options[index][1];
    close(); trigger.focus({ preventScroll: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function open() {
    if (menu || trigger.disabled) return;
    closeSelect(); active = selected;
    menu = document.createElement('div'); menu.className = 'select-menu'; menu.id = `${id}-menu`;
    menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-labelledby', labelId);
    options.forEach(([, label], index) => {
      const item = document.createElement('div');
      item.id = `${id}-option-${index}`; item.className = 'select-option';
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(index === selected));
      const caption = document.createElement('span'); caption.textContent = label;
      const check = document.createElement('span'); check.className = 'select-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
      item.append(caption, check);
      item.addEventListener('pointerdown', event => event.preventDefault());
      item.addEventListener('pointermove', () => highlight(index));
      item.addEventListener('click', () => choose(index));
      menu.append(item);
    });
    // A dialog-owned portal stays in the modal top layer and out of the scrolling form.
    (root.closest('dialog') || document.body).append(menu);
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const below = top + height - rect.bottom - 12, above = rect.top - top - 12;
    const up = below < Math.min(menu.scrollHeight, 240) && above > below;
    menu.style.width = `${Math.min(rect.width, width - 24)}px`;
    menu.style.maxHeight = `${Math.max(44, Math.min(240, up ? above : below))}px`;
    menu.style.left = `${Math.max(left + 12, Math.min(rect.left, left + width - menu.offsetWidth - 12))}px`;
    menu.style.top = `${up ? rect.top - menu.offsetHeight - 6 : rect.bottom + 6}px`;
    trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', menu.id);
    highlight(selected); dismissActive = close;
    listeners = new AbortController();
    const opts = { signal: listeners.signal };
    document.addEventListener('pointerdown', event => {
      if (!root.contains(event.target) && !menu.contains(event.target)) close();
    }, opts);
    document.addEventListener('scroll', event => { if (!menu.contains(event.target)) close(); }, { ...opts, capture: true });
    window.addEventListener('resize', close, opts);
    viewport?.addEventListener('resize', close, opts);
    root.closest('dialog')?.addEventListener('close', close, opts);
  }
  trigger.addEventListener('click', () => menu ? close() : open());
  trigger.addEventListener('blur', close);
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (!menu) { open(); if (event.key === 'End' || event.key === 'Home') highlight(event.key === 'Home' ? 0 : options.length - 1); return; }
      if (event.key === 'Enter' || event.key === ' ') { choose(active); return; }
      highlight(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    }
  });
  return root;
}
