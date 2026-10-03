# Nodes: more machines for the workers

Back to the [README](../README.md).

One office, the compute of several machines. A **node** is a teammate's computer (or a spare server) running `agent-office node`. It connects out to the office, so it needs no open ports, and the office can then run new workers on it. Each worker's terminal shows in the office like any other: anyone can open it and type. The work comes back the way all work in the office does, as a pushed branch and a pull request.

## Add one

On the office's machine (it can be running):

```bash
agent-office nodes add alice-pc
```

It prints the command to run on that machine, with a token that's only shown once:

```bash
agent-office node --office https://192.168.1.20:4600 --name alice-pc --token 3f9c… --pin sha256:AB:CD:…
```

On the node (Linux, macOS, or WSL on Windows: like the office, a node needs a Unix terminal host), install the **same version** of agent-office, sign in to `claude` and `gh` as yourself, and run that command. Leave it running. The office shows a toast when it joins, and **☰ → 🖥️ Machines** lists it with its free memory, load and workers.

- `--office` is how the node reaches the office. On a LAN, the office has to listen there too: start it with `--host 0.0.0.0 --self-signed`. An office in WSL also needs WSL's mirrored networking and a Windows firewall rule for its port before other machines can reach it; Tailscale avoids both. With `--self-signed`, `nodes add` adds `--pin`, the fingerprint of the office's certificate: the node checks it before it sends its token, so nobody in between can pose as the office. Over plain http the node warns you that terminals cross the network unencrypted. An office on [Tailscale](aws.md#tailscale) or a real domain needs neither.
- `--projects <dir>` is where the node clones the office's projects (default `~/agent-office-node`). Keep it apart from any office of your own on that machine.
- `--max-workers <n>` caps how many workers it takes at once.

`agent-office nodes` lists the nodes the office knows, and `agent-office nodes remove alice-pc` stops one from joining again.

## Where a worker runs

When you hire a worker **in its own git worktree**, the hire window's **🖥️ Runs on** (in the Ask window too, and on `/lite`) picks the machine. It only shows once a node has joined:

- **Auto** (the default): the machine with the most memory to spare right now. That's the office's own machine, which keeps 1.5 GB back for the office itself, or any node that's connected, has the project ready, and isn't at its `--max-workers`. Each worker placed in the last minute counts 700 MB against its machine until the node's numbers catch up, so a burst of hires spreads out.
- **This office's machine**, or a **node by name**, to pin it.

The worker stays on that machine for good. The workers list (and its card on `/lite`) says which one: 🖥️ alice-pc. A card dropped on a desk hires on Auto. Everything else runs on the office's machine: shells, board agents, meetings, workers without a worktree of their own, and workers across several repositories.

## What happens on the node

When a node joins, the office tells it about every floor. The node clones each project from its `origin` (once, with your git credentials), and starts a terminal host for it, like the office's own (see [how it works](how-it-works.md)). A worker hired onto it gets:

- **its worktree there**, on the same `office/<name>` branch the office made, cut from the same commit (or from `origin/<branch>` if that commit was never pushed);
- **your sign-ins**: the node's own `claude`, `gh` and git config, never the office's. Its environment is the node's, plus what the office sets for a worker (its id, its hook token, the model and so on);
- **the office's hooks and `office-workers`**, which reach the office through the node's connection: status, needs-input alerts and `office-workers list|hire|tell|home` work as on the office.

Claude asks once whether to trust the node's clone of a project: if a node's worker shows as needing you right after it starts, open its terminal and accept.

If the node's connection drops (Wi-Fi, a laptop lid), what was in flight is resent when it comes back, within two minutes, and nothing is lost. When the office restarts (an upgrade, say), a node's workers keep running and the office picks them back up as the node reconnects. If it's gone for longer, or `agent-office node` itself restarts, its workers start again on it when it's back, resuming their conversations. A node that's away shows its workers asleep; walking onto the floor tries to wake them and says the node isn't connected.

## Not on a node yet

These still only work for workers on the office's machine:

- **Cost.** A node's workers' spend isn't counted in the office's totals or budget.
- **🔀 Changes and O (open PR).** These look at the office's copy of the worktree, which stays empty. Ask the worker to push and open its pull request itself (`gh pr create`): the office picks it up and shows it at the desk.
- **🌐 Services.** A node's workers' dev servers aren't listed or tunnelled.
- **Dropping files** into a node's worker's terminal.
- **Sending home** deletes the office's copy of the worktree, not the node's: run `git worktree prune` in the node's clone now and then.
- **Moving** a running worker to another machine.
