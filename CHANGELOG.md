# Changelog

First number: a permission changed. Second: a new ability. Third: a fix.

## 1.1.1 (2026-10-07)

- Fix: `memory_save` and `memory_update` used to cut note text at 2,000 characters without
  saying so, which lost the end of long notes. They now refuse with the character count and
  ask for a shorter note or two notes. Nothing is saved or changed when that happens.

## 1.1.0 (2026-10-07)

- `memory_search` skips notes in the "archive" category unless the search asks for
  category "archive", so finished things stop crowding out current ones.

## 1.0.0 (2026-10-07)

First public release.

- Memory: save, search, list, update, delete. Notes can be marked as an assistant's guess
  and can carry an end date.
- Tasks and bills, each with their own tools.
- `memory_recent`: the newest things across memory, tasks and bills, so "the thing I just
  saved" is found in one call from any chat.
