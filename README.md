# emacs-config

Personal Emacs configuration, macOS, `emacs-plus` (Homebrew).

## Structure

- `init.el` — bootstrap. Loads `config.org` via `org-babel-load-file`.
- `config.org` — the actual config, literate Org file, single source of truth.
- `config.el` / `config.elc` — generated from `config.org` on every startup, not tracked in git.
- `custom.el` — settings saved by Emacs's `M-x customize` UI.

## Setup

Clone to `~/.emacs.d`:

```sh
git clone https://github.com/Sati2030/emacs-config ~/.emacs.d
```

Requires `emacs-plus` from Homebrew:

```sh
brew install d12frosted/emacs-plus/emacs-plus@31
```
