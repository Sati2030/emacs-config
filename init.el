;; -*- lexical-binding: t; -*-
(require 'org)
(org-babel-load-file
 (expand-file-name "config.org" user-emacs-directory))
(put 'set-goal-column 'disabled nil)
