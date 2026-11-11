# Makedeck

See the dev services started by [makedeck](https://github.com/Lorenzo-Se/makedeck) with live logs, open any of them in Terminal (e.g. to press `r` for Flutter hot reload), restart or stop them.

## Setup

This extension shows sessions created by the `makedeck` launcher, so you need both:

1. tmux: `brew install tmux`
2. The launcher from the [makedeck repository](https://github.com/Lorenzo-Se/makedeck):

   ```sh
   git clone https://github.com/Lorenzo-Se/makedeck.git
   ln -s "$PWD/makedeck/bin/makedeck" "$(brew --prefix)/bin/makedeck"
   ```

Then run `makedeck` in a project root. It starts every prerequisite of the Makefile's `dev` target in its own background tmux window. Open **Dev Services** in Raycast to see them.

Dev servers started outside makedeck, e.g. by a coding agent with `make api &`, show up in their project marked "outside makedeck", with their ports and, if their output goes to a file, their log. Stop them, or move them to makedeck in one step.

How to structure the Makefile is described in the [makedeck README](https://github.com/Lorenzo-Se/makedeck#makefile).
