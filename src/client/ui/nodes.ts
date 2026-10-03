import './nodes.css';
import type { NodeView, WorkerInfo } from '../../shared/protocol';
import { DESK_BY_ID } from '../../shared/layout';
import { store } from '../state';
import { h, openModal } from './dom';

// Teammates' machines lending the office their compute (see docs/nodes.md): which one a new worker
// runs on, in the hire dialogs, moving one that's running, and the ☰ menu's 🖥️ Machines window. The
// office's own machine isn't a node, so the Machines list leaves it out (the machine monitor is its own).

const NODE_KEY = 'agent-office.node';

function gb(bytes: number): string {
  const n = bytes / 2 ** 30;
  return `${n.toFixed(n < 10 ? 1 : 0)} GB`;
}

/** "3 workers", or "3 of 4 workers" when it set the most it takes. */
function workersOf(n: NodeView): string {
  const s = n.stats!;
  const of = s.maxWorkers ? ` of ${s.maxWorkers}` : '';
  return `${s.workers}${of} worker${(s.maxWorkers ?? s.workers) === 1 ? '' : 's'}`;
}

function optionLabel(n: NodeView): string {
  if (!n.online) return `${n.name} · offline`;
  return n.stats ? `${n.name} · ${gb(n.stats.memFree)} free · ${workersOf(n)}` : n.name;
}

/**
 * Which machine a new worker runs on: Auto ('', the one with the most free memory), the office's own
 * ('host') or a node by name. Only offered once a node has joined, and only for a worker in its own
 * worktree, so it's off while `wtBox` isn't ticked. The last pick is remembered for the next hire.
 */
export function nodePicker(wtBox: HTMLInputElement): { element: HTMLElement | null; value(): string | undefined } {
  if (!store.nodes.length) return { element: null, value: () => undefined };
  const select = h('select', { 'aria-label': 'Machine to run on' }) as HTMLSelectElement;
  const hint = h('small', {}, 'needs its own worktree');
  const element = h('label.node-pick', { title: 'Only a worker in its own git worktree can run on another machine' }, h('span', {}, '🖥️ Runs on'), select, hint);
  // A pick that's gone, or gone offline, falls back to Auto (and comes back once it's online again).
  const fill = (want: string) => {
    select.replaceChildren(
      h('option', { value: '' }, 'Auto (most free memory)'),
      h('option', { value: 'host' }, 'This office’s machine'),
      ...store.nodes.map((n) => h('option', { value: n.name, disabled: !n.online }, optionLabel(n))),
    );
    select.value = [...select.options].some((o) => o.value === want && !o.disabled) ? want : '';
  };
  const sync = () => {
    select.disabled = !wtBox.checked;
    hint.classList.toggle('hidden', wtBox.checked);
  };
  let saved = '';
  try {
    saved = localStorage.getItem(NODE_KEY) ?? '';
  } catch {
    // storage blocked
  }
  fill(saved);
  sync();
  wtBox.addEventListener('change', sync);
  select.addEventListener('change', () => {
    try {
      localStorage.setItem(NODE_KEY, select.value);
    } catch {
      // storage blocked
    }
  });
  // Nodes come and go while it's open; it stops following them once its window has closed.
  const off = store.on('nodes', () => (element.isConnected ? fill(select.value) : off()));
  return { element, value: () => (wtBox.checked && select.value) || undefined };
}

/** A node's free memory, load and workers, in a line. */
function nodeMeta(n: NodeView): string {
  if (!n.online) return 'offline';
  const s = n.stats;
  if (!s) return 'online · no report yet';
  return [`${gb(s.memFree)} of ${gb(s.memTotal)} free`, `load ${s.load.toFixed(1)} on ${s.cores} cores`, workersOf(n)].join(' · ');
}

/** The ☰ menu's 🖥️ Machines: every node that has joined the office, and how busy each is. */
export function openMachines() {
  const body = h('div.body');
  const el = h('div.modal', { role: 'dialog', 'aria-label': 'Machines', style: 'width:min(560px,100%)' }, h('header', {}, h('h2', {}, '🖥️ Machines')), body);
  const render = () => {
    if (!store.nodes.length) {
      body.replaceChildren(
        h('p.setting-note', { style: 'margin:0' }, 'No machines have joined. On the office machine run ', h('code', {}, 'agent-office nodes add <name>'), ' and follow what it prints on the teammate’s machine.'),
      );
      return;
    }
    body.replaceChildren(
      h('ul.svc-list.node-list', {}, ...store.nodes.map((n) => h('li', {}, h('span.dot', { class: n.online ? 'on' : '' }), h('div.svc-main', {}, h('div.svc-title', {}, n.name), h('div.svc-meta', {}, nodeMeta(n)))))),
      h('p.setting-note', {}, 'Teammates’ machines lending the office their compute. A new worker in its own worktree goes to the one with the most free memory, the office’s own included, unless its hire dialog picks one.'),
    );
  };
  const off = store.on('nodes', render);
  openModal(el, { doing: '🖥️ looking over the machines', onClose: () => off() });
  render();
}

/**
 * Whether a worker can move to another machine: an agent in a worktree of its own that's still there,
 * not across repositories, in a meeting or at a board's kiosk, once a node has joined.
 */
export function movable(w: WorkerInfo): boolean {
  return store.nodes.length > 0 && w.kind === 'agent' && !!w.worktree && !w.lost && !w.repos?.length && !w.meeting && !DESK_BY_ID.get(w.deskId)?.station;
}

/**
 * 🖥️ Move to…: picks the machine a running worker carries on on (a node's name, or 'host' for the
 * office's own), every one but where it is now. Not while it's working: the office refuses then.
 */
export function moveDialog(w: WorkerInfo, onMove: (node: string) => void) {
  const select = h('select', { 'aria-label': 'Machine to move to' }) as HTMLSelectElement;
  const busy = h('p.wt-status.warn', {}, 'It’s in the middle of something: move it once it’s done');
  const no = h('button.btn', { type: 'button' }, 'Cancel');
  const yes = h('button.btn.primary', { type: 'submit' }, 'Move');
  const form = h(
    'form.modal',
    { role: 'dialog', 'aria-label': `Move ${w.name}` },
    h('header', {}, h('h2', {}, `Move ${w.name}`)),
    h(
      'div.body',
      {},
      h('p', { style: 'margin:0;font-weight:700' }, 'It stops, its work is committed and pushed, and it carries on — conversation and all — on the machine you pick.'),
      h('label.node-pick', {}, h('span', {}, '🖥️ To'), select),
      busy,
    ),
    h('footer', {}, no, yes),
  ) as HTMLFormElement;
  // Nodes come and go, and the worker gets busy or moves, while it's open.
  const sync = () => {
    const now = store.workers.get(w.id);
    if (!now) return modal.close();
    const here = now.node || 'host';
    const want = select.value;
    select.replaceChildren(
      ...(here === 'host' ? [] : [h('option', { value: 'host' }, 'This office’s machine')]),
      ...store.nodes.filter((n) => n.name !== here).map((n) => h('option', { value: n.name, disabled: !n.online }, optionLabel(n))),
    );
    const open = [...select.options].filter((o) => !o.disabled);
    select.value = (open.find((o) => o.value === want) ?? open[0])?.value ?? '';
    busy.classList.toggle('hidden', now.status !== 'working');
    yes.disabled = now.status === 'working' || !select.value;
  };
  const offNodes = store.on('nodes', sync);
  const offWorkers = store.on('workers', sync);
  const modal = openModal(form, {
    onClose: () => {
      offNodes();
      offWorkers();
    },
  });
  no.addEventListener('click', () => modal.close());
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const node = select.value;
    modal.close();
    onMove(node);
  });
  sync();
  setTimeout(() => select.focus(), 30);
}
