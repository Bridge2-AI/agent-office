export {};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('connect-form');
const generate = $<HTMLButtonElement>('generate');
const error = $('error');
let replace = false;

async function load() {
  try {
    const res = await fetch('/api/node-connect');
    if (res.status === 401) return location.replace('/login?next=/connect-node');
    const info = await res.json();
    if (!res.ok) {
      error.textContent = info.error ?? 'Could not check your machine.';
      return;
    }
    replace = info.registered;
    $<HTMLInputElement>('max-workers').max = String(info.maxWorkerLimit);
    $('replacement').hidden = !replace;
    generate.textContent = replace ? 'Replace connection command' : 'Create connection command';
    form.hidden = false;
  } catch {
    error.textContent = 'Server unreachable. Reload to try again.';
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  generate.disabled = true;
  try {
    const res = await fetch('/api/node-connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ consent: $<HTMLInputElement>('consent').checked, maxWorkers: $<HTMLInputElement>('max-workers').valueAsNumber, replace }),
    });
    if (res.status === 401) return location.replace('/login?next=/connect-node');
    const result = await res.json();
    if (!res.ok) {
      error.textContent = result.error ?? 'Could not create a connection command.';
      return;
    }
    $<HTMLTextAreaElement>('command').value = result.command;
    $('machine').textContent = `Your machine will appear as ${result.name}.`;
    form.hidden = true;
    $('connection').hidden = false;
    $('continue').textContent = 'Enter the office →';
    $<HTMLTextAreaElement>('command').focus();
  } catch {
    error.textContent = 'Server unreachable. If the command was created, reload to replace it.';
  } finally {
    generate.disabled = false;
  }
});

$('copy').addEventListener('click', async () => {
  const command = $<HTMLTextAreaElement>('command');
  try {
    await navigator.clipboard.writeText(command.value);
    $('copy').textContent = 'Copied';
  } catch {
    command.focus();
    command.select();
    $('copy').textContent = 'Command selected. Copy it from the text box.';
  }
});

void load();
